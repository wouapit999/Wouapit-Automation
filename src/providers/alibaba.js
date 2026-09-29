// Alibaba.com connector (public page parsing + manual override). Alibaba has no open dropshipping API
// for individual buyers, so orders are placed by you (Trade Assurance) and recorded here.
import { fetchHtml } from '../util/http.js';
import { extractJsonAfter, extractJsonLd, metaContent, deepFind, normalizeImageUrl, decodeEntities } from '../util/json-extract.js';

export const ALIBABA_HOSTS = /(^|\.)alibaba\.com$/i;

export function matches(url) {
  try { return ALIBABA_HOSTS.test(new URL(url).hostname); } catch { return false; }
}

export function extractProductId(url) {
  const s = String(url);
  const m = s.match(/_(\d{8,20})\.html/) || s.match(/\/product\/(\d{8,20})/) || s.match(/[?&]productId=(\d{8,20})/);
  return m ? m[1] : null;
}

function parsePriceNumber(v) {
  if (v === null || v === undefined) return 0;
  const m = String(v).replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

export function parseProductPage(html, url, productId) {
  const warnings = [];
  const blocked = /_____tmd_____|punish|captcha|slide to verify/i.test(html) && !/detailData|ld\+json/.test(html);
  if (blocked) return { ...manualSkeleton(url, productId), warnings: ['Alibaba showed an anti-bot page. Fill the fields manually.'] };

  const detail = extractJsonAfter(html, 'window.detailData') || extractJsonAfter(html, 'window.__INITIAL_DATA__') || {};
  const ld = extractJsonLd(html).find((x) => /Product/i.test(x['@type'] || ''));

  let title = deepFind(detail, ['subject', 'productTitle', 'title']) || ld?.name || metaContent(html, 'og:title') || '';
  title = decodeEntities(String(title)).replace(/\s*-\s*Buy .*$/i, '').trim();

  // Images
  let images = [];
  const media = deepFind(detail, ['mediaItems', 'imageList', 'images']);
  if (Array.isArray(media)) {
    for (const m of media) {
      if (typeof m === 'string') images.push(m);
      else if (m?.type && m.type !== 'image') continue;
      else images.push(m?.imageUrl?.big || m?.imageUrl?.normal || m?.big || m?.url || m?.imageUrl);
    }
  }
  if (!images.length && ld?.image) images = [].concat(ld.image);
  if (!images.length) { const og = metaContent(html, 'og:image'); if (og) images = [og]; }
  images = images.map(normalizeImageUrl).filter(Boolean);

  // Price ladder & MOQ
  const ladder = deepFind(detail, ['productLadderPrices', 'ladderPrices', 'ladderPeriodList']) || [];
  let currency = String(deepFind(detail, ['currency', 'currencyCode', 'priceCurrency']) || ld?.offers?.priceCurrency || 'USD').toUpperCase();
  let unitPrice = 0, moq = parsePriceNumber(deepFind(detail, ['moq', 'minOrderQuantity', 'minOrder'])) || 1;
  const tiers = (Array.isArray(ladder) ? ladder : []).map((t) => ({
    min: parsePriceNumber(t.min ?? t.minQuantity ?? t.start ?? t.moq),
    max: parsePriceNumber(t.max ?? t.maxQuantity ?? t.end) || null,
    price: parsePriceNumber(t.dollarPrice ?? t.price ?? t.formatPrice ?? t.unitPrice),
  })).filter((t) => t.price > 0);
  if (tiers.length) {
    tiers.sort((a, b) => a.min - b.min);
    unitPrice = tiers[0].price;      // price at MOQ tier (conservative)
    if (tiers[0].min > 0) moq = Math.max(moq, tiers[0].min);
  } else {
    unitPrice = parsePriceNumber(ld?.offers?.highPrice ?? ld?.offers?.price ?? ld?.offers?.lowPrice);
    if (!unitPrice) {
      const meta = metaContent(html, 'og:price:amount') || metaContent(html, 'product:price:amount');
      unitPrice = parsePriceNumber(meta);
    }
  }
  if (!unitPrice) warnings.push('Could not read the unit price. Enter the supplier price at your order quantity.');
  if (!ld?.offers?.priceCurrency && !/US\$|USD/.test(html.slice(0, 200000))) warnings.push(`Currency assumed ${currency}; verify.`);

  // SKU attributes (colors / sizes) when available
  const skuAttrs = deepFind(detail, ['skuAttrs', 'skuAttributes', 'productSkuAttrs']) || [];
  const variants = [];
  if (Array.isArray(skuAttrs) && skuAttrs.length === 1 && Array.isArray(skuAttrs[0]?.values)) {
    const attrName = skuAttrs[0].name || skuAttrs[0].attrName || 'Option';
    skuAttrs[0].values.forEach((v, i) => variants.push({
      sku: `${productId}-${i + 1}`, skuId: String(v.id ?? v.valueId ?? ''), skuAttr: '',
      title: v.name || v.valueName || `Option ${i + 1}`, options: { [attrName]: v.name || v.valueName || `Option ${i + 1}` },
      supplierPrice: unitPrice, supplierCurrency: currency, supplierShipping: 0, stock: null, image: normalizeImageUrl(v.image || v.imageUrl),
    }));
  }
  if (!variants.length) variants.push(defaultVariant(productId, unitPrice, currency));

  const companyName = deepFind(detail, ['companyName', 'sellerName', 'supplierName']) || null;
  const leadTime = parsePriceNumber(deepFind(detail, ['leadTime', 'deliveryTime', 'leadTimeDays'])) || null;

  warnings.push('Alibaba shipping is quoted per order by the supplier: ask for a quote to Douala/Yaoundé and enter it as supplier shipping per unit.');

  return {
    provider: 'alibaba',
    source_url: url,
    source_product_id: productId ? String(productId) : null,
    title: title || `Alibaba product ${productId ?? ''}`.trim(),
    description_html: '',
    images,
    variants,
    conditions: {
      moq,
      leadTimeDays: leadTime,
      shippingMethod: null,
      paymentTerms: 'Trade Assurance (pay supplier on Alibaba); price tiers depend on quantity',
      weightKg: null,
      storeName: companyName,
      priceTiers: tiers,
      notes: '',
    },
    confidence: unitPrice > 0 && title ? 'full' : 'partial',
    warnings,
  };
}

function defaultVariant(productId, price, currency) {
  return { sku: `${productId || 'item'}-1`, skuId: '', skuAttr: '', title: 'Default', options: {}, supplierPrice: price, supplierCurrency: currency, supplierShipping: 0, stock: null, image: null };
}

export function manualSkeleton(url, productId) {
  return {
    provider: 'alibaba', source_url: url, source_product_id: productId ? String(productId) : null, title: '', description_html: '',
    images: [], variants: [defaultVariant(productId, 0, 'USD')],
    conditions: { moq: 1, leadTimeDays: null, shippingMethod: null, paymentTerms: 'Trade Assurance (pay supplier on Alibaba)', weightKg: null, storeName: null, notes: '' },
    confidence: 'partial', warnings: [],
  };
}

export async function importProduct(url) {
  const productId = extractProductId(url);
  const { html, status, url: finalUrl } = await fetchHtml(url);
  if (status >= 400) return { ...manualSkeleton(finalUrl, productId), warnings: [`Alibaba returned HTTP ${status}. Fill the product in manually.`] };
  return parseProductPage(html, finalUrl, productId || extractProductId(finalUrl));
}
