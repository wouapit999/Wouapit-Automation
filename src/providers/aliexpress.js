// AliExpress connector.
//  1. Official Dropshipping API (needs ALIEXPRESS_APP_KEY / SECRET / ACCESS_TOKEN) — reliable, also lets the
//     app place the supplier order for you.
//  2. Fallback: read the public product page (window.runParams JSON / JSON-LD / og: tags). Best effort.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { fetchHtml, fetchJson } from '../util/http.js';
import { extractJsonAfter, extractJsonLd, metaContent, deepFind, normalizeImageUrl, decodeEntities } from '../util/json-extract.js';

export const ALIEXPRESS_HOSTS = /(^|\.)aliexpress\.(com|us|ru|fr|es|it|de|nl|pl|co\.kr|com\.br)$/i;
const API_GATEWAY = 'https://api-sg.aliexpress.com/sync';
const SHIP_TO = 'CM';

export function matches(url) {
  try { return ALIEXPRESS_HOSTS.test(new URL(url).hostname); } catch { return false; }
}

export function extractProductId(url) {
  const m = String(url).match(/\/(?:item|i)\/(?:[^/]+\/)?(\d{6,20})(?:\.html)?/i) || String(url).match(/[?&]productId=(\d{6,20})/i);
  return m ? m[1] : null;
}

/** Short links (a.aliexpress.com/_xxxx) redirect to the real product page. */
export async function resolveUrl(url) {
  if (extractProductId(url)) return url;
  const { url: finalUrl } = await fetchHtml(url);
  return finalUrl;
}

// ---------------------------------------------------------------- official API
export function signParams(params, appSecret) {
  const str = Object.keys(params).sort().map((k) => k + params[k]).join('');
  return crypto.createHmac('sha256', appSecret).update(str, 'utf8').digest('hex').toUpperCase();
}

export async function apiCall(method, bizParams = {}) {
  const { appKey, appSecret, accessToken } = config.aliexpress;
  if (!appKey || !appSecret) throw new Error('AliExpress API credentials are not configured');
  const params = {
    app_key: appKey,
    method,
    timestamp: String(Date.now()),
    sign_method: 'sha256',
    format: 'json',
    v: '2.0',
    simplify: 'true',
    ...(accessToken ? { access_token: accessToken } : {}),
  };
  for (const [k, v] of Object.entries(bizParams)) {
    if (v === undefined || v === null) continue;
    params[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  params.sign = signParams(params, appSecret);
  const body = new URLSearchParams(params).toString();
  const { body: json } = await fetchJson(API_GATEWAY, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body,
  }, 30000);
  if (json.error_response) {
    const e = json.error_response;
    throw new Error(`AliExpress API error ${e.code ?? ''}: ${e.msg ?? ''} ${e.sub_msg ?? ''}`.trim());
  }
  if (json.code && json.code !== '0' && json.code !== 0 && json.message) {
    throw new Error(`AliExpress API error ${json.code}: ${json.message}`);
  }
  const respKey = Object.keys(json).find((k) => k.endsWith('_response'));
  const content = respKey ? json[respKey] : json;
  return content?.result ?? content;
}

function parseSkuAttr(skuAttr, propertyList) {
  // "14:29#Red;5:100014064#XL"  ->  { Color: "Red", Size: "XL" }
  const options = {};
  if (!skuAttr) return options;
  const props = new Map();
  for (const p of propertyList || []) {
    const id = String(p.skuPropertyId ?? p.sku_property_id ?? p.propertyId ?? '');
    const name = p.skuPropertyName ?? p.sku_property_name ?? p.propertyName ?? `Option ${id}`;
    const values = new Map();
    for (const v of p.skuPropertyValues ?? p.sku_property_values ?? p.values ?? []) {
      values.set(String(v.propertyValueId ?? v.property_value_id ?? v.id ?? ''), v.propertyValueDisplayName ?? v.propertyValueName ?? v.property_value_display_name ?? v.property_value_name ?? v.name);
    }
    props.set(id, { name, values });
  }
  for (const part of String(skuAttr).split(';')) {
    const [ids, label] = part.split('#');
    const [propId, valId] = (ids || '').split(':');
    const prop = props.get(propId);
    const name = prop?.name ?? `Option ${propId}`;
    options[name] = label ?? prop?.values.get(valId) ?? valId;
  }
  return options;
}

function normalizeApiProduct(result, url, productId) {
  const base = result.ae_item_base_info_dto ?? {};
  const skuList = result.ae_item_sku_info_dtos?.ae_item_sku_info_d_t_o ?? result.ae_item_sku_info_dtos ?? [];
  const media = result.ae_multimedia_info_dto ?? {};
  const logistics = result.logistics_info_dto ?? {};
  const store = result.ae_store_info ?? {};
  const pkg = result.package_info_dto ?? {};

  const images = String(media.image_urls || '').split(';').map(normalizeImageUrl).filter(Boolean);
  const currency = base.currency_code || 'USD';

  const variants = (Array.isArray(skuList) ? skuList : []).map((s, i) => {
    const props = s.ae_sku_property_dtos?.ae_sku_property_d_t_o ?? [];
    const options = {};
    for (const p of props) {
      options[p.sku_property_name || `Option ${p.sku_property_id}`] = p.property_value_definition_name || p.sku_property_value || String(p.property_value_id_long ?? '');
    }
    const price = Number(s.offer_sale_price ?? s.offer_bulk_sale_price ?? s.sku_price ?? 0);
    const image = normalizeImageUrl(props.find((p) => p.sku_image)?.sku_image);
    return {
      sku: s.sku_code || s.id || `${productId}-${i + 1}`,
      skuId: String(s.sku_id ?? ''),
      skuAttr: s.sku_attr ?? s.id ?? '',
      title: Object.values(options).join(' / ') || 'Default',
      options,
      supplierPrice: price,
      supplierCurrency: s.currency_code || currency,
      supplierShipping: 0,
      stock: Number(s.sku_available_stock ?? s.sku_stock ?? 0) || null,
      image,
    };
  });

  const leadTime = Number(logistics.delivery_time) || null;
  return {
    provider: 'aliexpress',
    source_url: url,
    source_product_id: String(productId),
    title: decodeEntities(base.subject || `AliExpress product ${productId}`),
    description_html: base.detail || '',
    images,
    variants: variants.length ? variants : [defaultVariant(productId, 0, currency)],
    conditions: {
      moq: 1,
      leadTimeDays: leadTime,
      shippingMethod: null,
      paymentTerms: 'Paid in full on AliExpress at order time',
      weightKg: pkg.gross_weight ? Number(pkg.gross_weight) : null,
      storeName: store.store_name || null,
      notes: '',
    },
    confidence: 'full',
    warnings: [],
    raw: result,
  };
}

function defaultVariant(productId, price, currency) {
  return { sku: `${productId}-1`, skuId: '', skuAttr: '', title: 'Default', options: {}, supplierPrice: price, supplierCurrency: currency, supplierShipping: 0, stock: null, image: null };
}

export async function fetchProductViaApi(productId, url) {
  const result = await apiCall('aliexpress.ds.product.get', {
    product_id: productId,
    ship_to_country: SHIP_TO,
    target_currency: 'USD',
    target_language: 'en',
  });
  if (!result || (!result.ae_item_base_info_dto && !result.ae_item_sku_info_dtos)) {
    throw new Error('AliExpress API returned no product data (check that the access token has Dropshipping scope)');
  }
  const product = normalizeApiProduct(result, url, productId);
  // Best-effort freight quote to Cameroon for the first SKU.
  try {
    const freight = await queryFreight(productId, product.variants[0]?.skuId);
    if (freight) {
      for (const v of product.variants) v.supplierShipping = freight.fee;
      product.conditions.shippingMethod = freight.company;
      if (freight.maxDays) product.conditions.leadTimeDays = freight.maxDays;
    }
  } catch (e) {
    product.warnings.push(`Could not fetch shipping cost to Cameroon automatically: ${e.message}`);
  }
  return product;
}

/** Cheapest shipping option to Cameroon. Returns { fee, currency, company, minDays, maxDays } or null. */
export async function queryFreight(productId, skuId) {
  const result = await apiCall('aliexpress.ds.freight.query', {
    queryDeliveryReq: {
      productId: String(productId),
      quantity: 1,
      shipToCountry: SHIP_TO,
      selectedSkuId: skuId || undefined,
      currency: 'USD',
      language: 'en_US',
      locale: 'en_US',
    },
  });
  const options = deepFind(result, ['delivery_option_d_t_o', 'delivery_options', 'deliveryOptions']) ;
  const list = Array.isArray(options) ? options : options?.delivery_option_d_t_o ?? [];
  const parsed = list.map((o) => ({
    fee: Number(o.shipping_fee_cent != null ? o.shipping_fee_cent / 100 : (o.shipping_fee_format ?? o.freight?.amount ?? o.shippingFee ?? '').toString().replace(/[^\d.]/g, '')),
    currency: o.shipping_fee_currency || o.currency || 'USD',
    company: o.company || o.code || o.logistics_service_name || 'Standard',
    minDays: Number(o.min_delivery_days ?? o.minDeliveryDays) || null,
    maxDays: Number(o.max_delivery_days ?? o.maxDeliveryDays) || null,
    serviceName: o.code || o.logistics_service_name || null,
  })).filter((o) => !Number.isNaN(o.fee));
  if (!parsed.length) return null;
  parsed.sort((a, b) => a.fee - b.fee);
  return parsed[0];
}

/**
 * Place the supplier order on AliExpress (auto-pay from your AliExpress account).
 * items: [{ productId, skuAttr, quantity, shippingService? }], address: Shopify shipping address.
 * Returns { orderIds: [...], raw }.
 */
export async function placeOrder({ items, address, memo }) {
  const req = {
    logistics_address: {
      address: [address.address1, address.address2].filter(Boolean).join(', '),
      city: address.city || '',
      contact_person: address.name || `${address.first_name || ''} ${address.last_name || ''}`.trim(),
      country: 'CM',
      full_name: address.name || `${address.first_name || ''} ${address.last_name || ''}`.trim(),
      mobile_no: String(address.phone || '').replace(/[^\d]/g, '').replace(/^237/, ''),
      phone_country: '+237',
      province: address.province || address.city || '',
      zip: address.zip || '00000',
      locale: 'en_US',
    },
    product_items: items.map((it) => ({
      product_id: Number(it.productId),
      product_count: Number(it.quantity),
      sku_attr: it.skuAttr || undefined,
      logistics_service_name: it.shippingService || undefined,
      order_memo: memo || undefined,
    })),
  };
  const result = await apiCall('aliexpress.ds.order.create', {
    param_place_order_request4_open_api_d_t_o: req,
  });
  const ok = result?.is_success === true || result?.is_success === 'true';
  const ids = result?.order_list?.number ?? result?.order_list ?? [];
  if (!ok || !ids.length) {
    throw new Error(`AliExpress order not created: ${result?.error_code ?? ''} ${result?.error_msg ?? JSON.stringify(result)}`);
  }
  return { orderIds: (Array.isArray(ids) ? ids : [ids]).map(String), raw: result };
}

export async function getTracking(aeOrderId) {
  const result = await apiCall('aliexpress.ds.order.tracking.get', { ae_order_id: String(aeOrderId), language: 'en_US' });
  const number = deepFind(result, ['mail_no', 'logistics_no', 'tracking_number', 'mailNo']);
  const company = deepFind(result, ['logistics_service_name', 'carrier_name', 'shipping_company', 'company']);
  return { trackingNumber: number ? String(number) : null, company: company ? String(company) : null, raw: result };
}

// ---------------------------------------------------------------- HTML fallback
export function parseProductPage(html, url, productId) {
  const warnings = [];
  const blocked = /_____tmd_____|punish|captcha|slide to verify|x5secdata/i.test(html) && html.length < 200000 && !/runParams/.test(html);
  if (blocked) {
    return { ...manualSkeleton(url, productId), warnings: ['AliExpress showed an anti-bot page instead of the product. Fill the fields manually or configure the AliExpress API.'] };
  }
  const run = extractJsonAfter(html, 'window.runParams') || extractJsonAfter(html, 'window._d_c_.DCData') || extractJsonAfter(html, 'window.__AER_DATA__');
  const data = run?.data ?? run ?? {};
  const ld = extractJsonLd(html).find((x) => /Product/i.test(x['@type'] || ''));

  let title = deepFind(data, ['subject']) || ld?.name || metaContent(html, 'og:title') || '';
  title = decodeEntities(String(title)).replace(/\s*[-|]\s*AliExpress.*$/i, '').trim();

  let images = deepFind(data, ['imagePathList', 'image_path_list']) || [];
  if (!Array.isArray(images) || !images.length) images = ld?.image ? [].concat(ld.image) : [];
  if (!images.length) { const og = metaContent(html, 'og:image'); if (og) images = [og]; }
  images = images.map(normalizeImageUrl).filter(Boolean);

  const propertyList = deepFind(data, ['productSKUPropertyList', 'product_sku_property_list']) || [];
  const skuPriceList = deepFind(data, ['skuPriceList', 'sku_price_list']) || [];
  const currencyGuess = deepFind(data, ['currencyCode', 'currency_code', 'currency']) || ld?.offers?.priceCurrency || 'USD';

  let variants = (Array.isArray(skuPriceList) ? skuPriceList : []).map((s, i) => {
    const val = s.skuVal ?? s;
    const price = Number(val.actSkuCalPrice ?? val.actSkuMultiCurrencyCalPrice ?? val.skuCalPrice ?? val.skuAmount?.value ?? val.skuActivityAmount?.value ?? 0);
    const currency = val.skuAmount?.currency ?? val.skuActivityAmount?.currency ?? currencyGuess;
    const options = parseSkuAttr(s.skuAttr, propertyList);
    return {
      sku: `${productId}-${i + 1}`,
      skuId: String(s.skuId ?? s.skuIdStr ?? ''),
      skuAttr: s.skuAttr ?? '',
      title: Object.values(options).join(' / ') || 'Default',
      options,
      supplierPrice: price,
      supplierCurrency: String(currency).toUpperCase(),
      supplierShipping: 0,
      stock: Number(val.availQuantity ?? val.inventory ?? 0) || null,
      image: null,
    };
  }).filter((v) => v.supplierPrice > 0);

  if (!variants.length) {
    const min = deepFind(data, ['minAmount', 'min_amount']);
    const price = Number(min?.value ?? ld?.offers?.lowPrice ?? ld?.offers?.price ?? 0);
    const currency = String(min?.currency ?? ld?.offers?.priceCurrency ?? currencyGuess).toUpperCase();
    variants = [defaultVariant(productId, price, currency)];
    if (!price) warnings.push('Could not read the supplier price from the page. Enter it manually below.');
  }

  // Shipping: look for a freight block mentioning a display amount and max delivery days
  let shipping = 0, leadTime = null, method = null;
  const freightList = deepFind(data, ['originalLayoutResultList', 'freightResult', 'freight_result']);
  const first = Array.isArray(freightList) ? freightList[0] : null;
  const biz = first?.bizData ?? first ?? null;
  if (biz) {
    shipping = Number(String(biz.displayAmount ?? biz.formattedAmount ?? biz.freightAmount?.value ?? '0').replace(/[^\d.]/g, '')) || 0;
    leadTime = Number(biz.deliveryDayMax ?? biz.deliveryDate ?? 0) || null;
    method = biz.company ?? biz.deliveryProviderName ?? null;
  }
  for (const v of variants) v.supplierShipping = shipping;
  if (!shipping) warnings.push('Shipping cost to Cameroon not found on the page; check it on AliExpress (set Ship to: Cameroon) and enter it below.');

  const storeName = deepFind(data, ['storeName', 'store_name']) || null;
  const confidence = variants[0].supplierPrice > 0 && title ? 'full' : 'partial';
  if (!title) warnings.push('Could not read the product title.');

  return {
    provider: 'aliexpress',
    source_url: url,
    source_product_id: String(productId),
    title: title || `AliExpress product ${productId}`,
    description_html: '',
    images,
    variants,
    conditions: { moq: 1, leadTimeDays: leadTime, shippingMethod: method, paymentTerms: 'Paid in full on AliExpress at order time', weightKg: null, storeName, notes: '' },
    confidence,
    warnings,
  };
}

export function manualSkeleton(url, productId) {
  return {
    provider: 'aliexpress',
    source_url: url,
    source_product_id: productId ? String(productId) : null,
    title: '',
    description_html: '',
    images: [],
    variants: [defaultVariant(productId || 'item', 0, 'USD')],
    conditions: { moq: 1, leadTimeDays: null, shippingMethod: null, paymentTerms: 'Paid in full on AliExpress at order time', weightKg: null, storeName: null, notes: '' },
    confidence: 'partial',
    warnings: [],
  };
}

export async function importProduct(inputUrl) {
  const url = await resolveUrl(inputUrl);
  const productId = extractProductId(url);
  if (!productId) throw new Error('Could not find a product id in this AliExpress link');
  const canonical = `https://www.aliexpress.com/item/${productId}.html`;

  if (config.aliexpress.enabled) {
    try {
      return await fetchProductViaApi(productId, canonical);
    } catch (e) {
      const fallback = await importFromPage(canonical, productId);
      fallback.warnings.unshift(`AliExpress API failed (${e.message}); used the public page instead.`);
      return fallback;
    }
  }
  return importFromPage(canonical, productId);
}

async function importFromPage(url, productId) {
  const { html, status } = await fetchHtml(url);
  if (status >= 400) {
    return { ...manualSkeleton(url, productId), warnings: [`AliExpress returned HTTP ${status}. Fill the product in manually or configure the AliExpress API.`] };
  }
  return parseProductPage(html, url, productId);
}
