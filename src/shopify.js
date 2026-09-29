// Shopify Admin GraphQL client + the handful of operations this app needs.
import { config, assertShopifyConfigured } from './config.js';
import { deliveryEstimateDays } from './pricing.js';
import { esc } from './util/html.js';

const gid = (type, id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/${type}/${id}`);
export const numericId = (g) => String(g ?? '').split('/').pop();

export async function graphql(query, variables = {}) {
  assertShopifyConfigured();
  const { domain, token, apiVersion } = config.shopify;
  const res = await fetch(`https://${domain}/admin/api/${apiVersion}/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Shopify returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}: ${JSON.stringify(json.errors ?? json).slice(0, 500)}`);
  if (json.errors?.length) throw new Error(`Shopify GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
  return json.data;
}

function userErrors(payload, label) {
  const errs = payload?.userErrors ?? [];
  if (errs.length) throw new Error(`${label}: ${errs.map((e) => `${(e.field || []).join('.')} ${e.message}`.trim()).join('; ')}`);
}

export async function shopInfo() {
  const d = await graphql(`{ shop { name myshopifyDomain currencyCode primaryDomain { url } } }`);
  return d.shop;
}

/** Build the customer-facing description including the supplier's conditions. */
export function buildDescriptionHtml(product, rules) {
  const c = product.conditions || {};
  const eta = deliveryEstimateDays(c, rules);
  const lines = [];
  lines.push(`<p><strong>Livraison estimée / Estimated delivery:</strong> ${eta.min}–${eta.max} jours ouvrés (commande importée pour vous).</p>`);
  if (Number(c.moq) > 1) lines.push(`<p><strong>Quantité minimum / Minimum order:</strong> ${esc(c.moq)} unités.</p>`);
  if (c.shippingMethod) lines.push(`<p><strong>Transport:</strong> ${esc(c.shippingMethod)} jusqu'au Cameroun, puis livraison locale.</p>`);
  if (c.notes) lines.push(`<p>${esc(c.notes)}</p>`);
  lines.push(`<p class="small">Prix TTC en FCFA, transport international et frais de dédouanement inclus. Paiement sécurisé à la commande; le produit est commandé chez le fournisseur dès réception de votre paiement.</p>`);
  const conditions = `<div class="cm-conditions"><h3>Conditions de vente</h3>${lines.join('')}</div>`;
  const body = product.description_html ? `<div class="cm-description">${product.description_html}</div>` : '';
  return body + conditions;
}

/**
 * Create or update the Shopify product for a local product record (variants must already carry sellingPriceXaf).
 * Returns { productId, handle, variants: [{ id, sku }] }.
 */
export async function upsertProduct(product, { rules, status } = {}) {
  const optionNames = [];
  for (const v of product.variants) for (const k of Object.keys(v.options || {})) if (!optionNames.includes(k)) optionNames.push(k);
  const hasOptions = optionNames.length > 0;
  const options = hasOptions
    ? optionNames.slice(0, 3).map((name, i) => ({
        name, position: i + 1,
        values: [...new Set(product.variants.map((v) => String(v.options?.[name] ?? '—')))].map((n) => ({ name: n })),
      }))
    : [{ name: 'Title', position: 1, values: [{ name: 'Default Title' }] }];

  const seen = new Set();
  const variants = product.variants.filter((v) => Number(v.sellingPriceXaf) > 0).map((v) => {
    const optionValues = hasOptions
      ? optionNames.slice(0, 3).map((name) => ({ optionName: name, name: String(v.options?.[name] ?? '—') }))
      : [{ optionName: 'Title', name: 'Default Title' }];
    const key = optionValues.map((o) => o.name).join('|');
    if (seen.has(key)) return null; // Shopify rejects duplicate option combinations
    seen.add(key);
    return {
      ...(v.shopifyVariantId ? { id: gid('ProductVariant', v.shopifyVariantId) } : {}),
      optionValues,
      price: String(v.sellingPriceXaf),
      compareAtPrice: v.compareAtXaf ? String(v.compareAtXaf) : null,
      sku: v.sku || null,
      inventoryPolicy: 'CONTINUE',
      inventoryItem: { tracked: false, requiresShipping: true },
      ...(v.image ? { file: { originalSource: v.image, contentType: 'IMAGE' } } : {}),
    };
  }).filter(Boolean);
  if (!variants.length) throw new Error('No variant has a selling price; compute prices first.');

  const c = product.conditions || {};
  const input = {
    ...(product.shopify_product_id ? { id: gid('Product', product.shopify_product_id) } : {}),
    title: product.title,
    descriptionHtml: buildDescriptionHtml(product, rules),
    vendor: c.storeName || (product.provider === 'alibaba' ? 'Alibaba supplier' : 'AliExpress supplier'),
    productType: product.productType || '',
    tags: ['dropship', product.provider],
    status: status || config.shopify.defaultStatus,
    productOptions: options,
    variants,
    files: (product.images || []).slice(0, 20).map((url, i) => ({ originalSource: url, contentType: 'IMAGE', alt: `${product.title} ${i + 1}` })),
    metafields: [
      { namespace: 'cmdropship', key: 'source_url', type: 'url', value: product.source_url },
      { namespace: 'cmdropship', key: 'provider', type: 'single_line_text_field', value: product.provider },
      { namespace: 'cmdropship', key: 'moq', type: 'number_integer', value: String(Number(c.moq) || 1) },
      { namespace: 'cmdropship', key: 'lead_time_days', type: 'number_integer', value: String(deliveryEstimateDays(c, rules).max) },
    ],
  };

  const d = await graphql(`
    mutation productSet($input: ProductSetInput!) {
      productSet(synchronous: true, input: $input) {
        product { id handle title status variants(first: 100) { nodes { id sku title selectedOptions { name value } } } }
        userErrors { field message }
      }
    }`, { input });
  userErrors(d.productSet, 'productSet');
  const p = d.productSet.product;
  return {
    productId: numericId(p.id),
    handle: p.handle,
    variants: p.variants.nodes.map((n) => ({ id: numericId(n.id), sku: n.sku, title: n.title, options: Object.fromEntries(n.selectedOptions.map((o) => [o.name, o.value])) })),
  };
}

/** Make the product visible in the Online Store channel (needs read/write_publications). Best effort. */
export async function publishToOnlineStore(productId) {
  const d = await graphql(`{ publications(first: 25) { nodes { id name catalog { title } } } }`);
  const pub = d.publications.nodes.find((p) => /online store/i.test(p.name || '') || /online store/i.test(p.catalog?.title || ''));
  if (!pub) return false;
  const r = await graphql(`
    mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) { userErrors { field message } }
    }`, { id: gid('Product', productId), input: [{ publicationId: pub.id }] });
  userErrors(r.publishablePublish, 'publishablePublish');
  return true;
}

export async function updateVariantPrices(productId, variants) {
  // variants: [{ shopifyVariantId, sellingPriceXaf, compareAtXaf }]
  const d = await graphql(`
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
    }`, {
    productId: gid('Product', productId),
    variants: variants.map((v) => ({ id: gid('ProductVariant', v.shopifyVariantId), price: String(v.sellingPriceXaf), compareAtPrice: v.compareAtXaf ? String(v.compareAtXaf) : null })),
  });
  userErrors(d.productVariantsBulkUpdate, 'productVariantsBulkUpdate');
}

export async function setProductStatus(productId, status) {
  const d = await graphql(`mutation($input: ProductInput!) { productUpdate(input: $input) { userErrors { field message } } }`,
    { input: { id: gid('Product', productId), status } });
  userErrors(d.productUpdate, 'productUpdate');
}

// ---------------------------------------------------------------- webhooks
export const WEBHOOK_TOPICS = ['ORDERS_PAID', 'ORDERS_CANCELLED'];

export async function listWebhooks() {
  const d = await graphql(`{ webhookSubscriptions(first: 50) { nodes { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } } }`);
  return d.webhookSubscriptions.nodes.map((n) => ({ id: n.id, topic: n.topic, url: n.endpoint?.callbackUrl }));
}

export async function registerWebhooks(appUrl) {
  const callback = `${appUrl.replace(/\/+$/, '')}/webhooks/shopify`;
  const existing = await listWebhooks();
  const results = [];
  for (const topic of WEBHOOK_TOPICS) {
    const dup = existing.find((w) => w.topic === topic && w.url === callback);
    if (dup) { results.push({ topic, status: 'exists', id: dup.id }); continue; }
    const d = await graphql(`
      mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { field message } }
      }`, { topic, sub: { uri: callback, format: 'JSON' } });
    userErrors(d.webhookSubscriptionCreate, `webhook ${topic}`);
    results.push({ topic, status: 'created', id: d.webhookSubscriptionCreate.webhookSubscription.id });
  }
  return results;
}

// ---------------------------------------------------------------- fulfilment
export async function getFulfillmentOrders(orderId) {
  const d = await graphql(`
    query($id: ID!) { order(id: $id) { id name fulfillmentOrders(first: 10) { nodes {
      id status lineItems(first: 50) { nodes { id remainingQuantity lineItem { id sku variant { id } } } } } } } }`,
    { id: gid('Order', orderId) });
  return d.order?.fulfillmentOrders?.nodes ?? [];
}

/**
 * Create a fulfilment with tracking for specific Shopify line items of an order.
 * lineItems: [{ shopifyLineItemId, quantity }]
 */
export async function fulfillLineItems(orderId, lineItems, tracking, notifyCustomer = true) {
  const fos = await getFulfillmentOrders(orderId);
  const byFo = [];
  for (const fo of fos) {
    if (!['OPEN', 'IN_PROGRESS', 'SCHEDULED', 'ON_HOLD'].includes(fo.status)) continue;
    const items = [];
    for (const li of fo.lineItems.nodes) {
      const want = lineItems.find((x) => numericId(li.lineItem.id) === String(x.shopifyLineItemId));
      if (want && li.remainingQuantity > 0) items.push({ id: li.id, quantity: Math.min(want.quantity, li.remainingQuantity) });
    }
    if (items.length) byFo.push({ fulfillmentOrderId: fo.id, fulfillmentOrderLineItems: items });
  }
  if (!byFo.length) throw new Error('Nothing left to fulfil for these line items (already fulfilled or order closed).');

  const mutationName = config.shopify.apiVersion < '2025-01' ? 'fulfillmentCreateV2' : 'fulfillmentCreate';
  const d = await graphql(`
    mutation($fulfillment: FulfillmentInput!) {
      ${mutationName}(fulfillment: $fulfillment) { fulfillment { id status } userErrors { field message } }
    }`, {
    fulfillment: {
      lineItemsByFulfillmentOrder: byFo,
      notifyCustomer,
      trackingInfo: tracking?.number ? { number: tracking.number, company: tracking.company || undefined, url: tracking.url || undefined } : undefined,
    },
  });
  userErrors(d[mutationName], mutationName);
  return numericId(d[mutationName].fulfillment.id);
}
