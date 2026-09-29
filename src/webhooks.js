import crypto from 'node:crypto';
import { config } from './config.js';
import { logEvent, updateOrderStatus, webhookSeen, getOrderByShopifyId, insertOrder, insertPurchaseOrder, updatePurchaseOrder, getProductByShopifyId, listPurchaseOrders } from './db.js';
import { getFxRates } from './fx.js';
import { toXaf } from './pricing.js';
import { getAdapter } from './suppliers/registry.js';
import { toSupplierAddress } from './suppliers/common.js';
import { encodeVariantId } from './suppliers/aliexpress-adapter.js';

export function verifyShopifyHmac(rawBody, headerHmac, secret = config.shopify.apiSecret) {
  if (!secret || !headerHmac) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(digest), b = Buffer.from(String(headerHmac));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Express handler for POST /webhooks/shopify (expects req.body to be the raw Buffer). */
export async function handleShopifyWebhook(req, res) {
  const topic = req.get('x-shopify-topic') || '';
  const webhookId = req.get('x-shopify-webhook-id');
  // Raw bytes are required for the HMAC. On Vercel set NODEJS_HELPERS=0 so the body is not pre-parsed;
  // if it was parsed anyway we re-serialise it (works for Shopify's compact JSON) and log a warning.
  let raw = req.body;
  if (!Buffer.isBuffer(raw)) {
    raw = Buffer.from(typeof raw === 'string' ? raw : JSON.stringify(raw ?? ''));
    console.warn('Webhook body was pre-parsed by the platform; set NODEJS_HELPERS=0 on Vercel for exact signature checks.');
  }
  if (!verifyShopifyHmac(raw, req.get('x-shopify-hmac-sha256'))) {
    await logEvent('webhook.rejected', `Invalid HMAC for ${topic}`, null, 'warn');
    return res.status(401).send('invalid hmac');
  }
  res.status(200).send('ok'); // respond fast; Shopify retries on timeouts
  if (await webhookSeen(webhookId)) return;
  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); } catch { return await logEvent('webhook.bad_json', topic, null, 'error'); }
  try {
    if (topic === 'orders/paid') await processPaidOrder(payload);
    else if (topic === 'orders/cancelled') await processCancelledOrder(payload);
    else await logEvent('webhook.ignored', `Ignored topic ${topic}`);
  } catch (e) {
    await logEvent('webhook.error', `${topic}: ${e.message}`, { stack: e.stack }, 'error');
  }
}

/** Turn a paid Shopify order into purchase orders (what to buy from which supplier, and what you owe). */
export async function processPaidOrder(order) {
  if (await getOrderByShopifyId(order.id)) return await logEvent('order.duplicate', `Order ${order.name} already recorded`);
  const fx = await getFxRates();
  const orderId = await insertOrder({
    shopify_order_id: order.id,
    order_number: order.name || String(order.order_number || order.id),
    customer: { name: `${order.customer?.first_name ?? ''} ${order.customer?.last_name ?? ''}`.trim(), email: order.email || order.contact_email, phone: order.phone || order.customer?.phone || order.shipping_address?.phone },
    shipping_address: order.shipping_address || order.billing_address || {},
    currency: order.currency,
    total_price: Number(order.total_price || 0),
    financial_status: order.financial_status,
    raw: order,
  });

  const created = [];
  for (const li of order.line_items || []) {
    const product = li.product_id ? await getProductByShopifyId(li.product_id) : null;
    const variant = product?.variants.find((v) => String(v.shopifyVariantId) === String(li.variant_id))
      || product?.variants.find((v) => v.sku && v.sku === li.sku)
      || product?.variants[0];
    const qty = Number(li.quantity || 1);
    let supplierTotalXaf = null;
    if (variant) {
      const total = (Number(variant.supplierPrice || 0) + Number(variant.supplierShipping || 0)) * qty;
      try { supplierTotalXaf = Math.round(toXaf(total, variant.supplierCurrency, fx)); } catch { /* unknown currency */ }
    }
    const poId = await insertPurchaseOrder({
      order_id: orderId,
      product_id: product?.id ?? null,
      shopify_line_item_id: li.id,
      shopify_variant_id: li.variant_id,
      sku: li.sku || variant?.sku || null,
      title: li.title + (li.variant_title ? ` — ${li.variant_title}` : ''),
      quantity: qty,
      sold_unit_price: Number(li.price || 0),
      supplier_url: product?.source_url ?? null,
      supplier_sku_attr: variant?.skuAttr ?? null,
      supplier_unit_cost: variant?.supplierPrice ?? null,
      supplier_shipping: variant?.supplierShipping ?? 0,
      supplier_currency: variant?.supplierCurrency ?? null,
      supplier_total_xaf: supplierTotalXaf,
      status: 'pending',
      notes: product ? null : 'No supplier mapping found for this line item (product not imported through this app).',
    });
    created.push({ poId, product, variant, qty, li });
  }
  await logEvent('order.received', `Paid order ${order.name}: ${created.length} line(s) → purchase orders created`, { orderId, shopify_order_id: order.id });

  // Optional: place the supplier order automatically through the supplier adapter (AliExpress DS API).
  if (config.aliexpress.autoOrder) await autoPurchase(order, created);
  return orderId;
}

/** Place supplier orders for the lines whose adapter supports automatic purchasing. Idempotent per Shopify order. */
export async function autoPurchase(order, created) {
  const groups = new Map();
  for (const c of created) {
    if (!c.product?.source_product_id) continue;
    const adapter = getAdapter(c.product.provider);
    if (!adapter?.supportsAutomaticPurchasing) continue;
    if (!groups.has(adapter.supplierId)) groups.set(adapter.supplierId, { adapter, lines: [] });
    groups.get(adapter.supplierId).lines.push(c);
  }
  for (const { adapter, lines } of groups.values()) {
    const result = await adapter.createPurchaseOrder({
      idempotencyKey: `shopify:${order.id}:${adapter.supplierId}`,
      externalOrderReference: `Shop order ${order.name}`,
      shippingAddress: toSupplierAddress(order.shipping_address || {}),
      lines: lines.map((c) => ({
        supplierVariantId: encodeVariantId(c.product.source_product_id, c.variant?.skuAttr || c.variant?.skuId || ''),
        quantity: c.qty,
        expectedUnitCost: { amount: Number(c.variant?.supplierPrice || 0), currency: c.variant?.supplierCurrency || 'USD' },
      })),
    });
    if (result.status === 'REJECTED') {
      await logEvent('supplier.auto_order_failed', `${adapter.supplierId} refused order for ${order.name}: ${result.message}. Left as pending for manual purchase.`, null, 'error');
      continue;
    }
    for (const c of lines) {
      await updatePurchaseOrder(c.poId, { status: 'ordered', supplier_order_ref: result.supplierOrderId, supplier_paid_at: new Date().toISOString(), notes: result.message || `Placed automatically via ${adapter.supplierId}` });
    }
    await logEvent('supplier.auto_ordered', `${adapter.supplierId} order ${result.supplierOrderId} placed for ${order.name} (${result.status})`);
  }
}


export async function processCancelledOrder(order) {
  const local = await getOrderByShopifyId(order.id);
  if (!local) return;
  await updateOrderStatus(local.id, order.financial_status || 'cancelled');
  for (const po of await listPurchaseOrders({ orderId: local.id })) {
    if (po.status === 'pending') await updatePurchaseOrder(po.id, { status: 'cancelled', notes: 'Shopify order cancelled before supplier purchase' });
  }
  await logEvent('order.cancelled', `Order ${order.name} cancelled; pending supplier orders cancelled. Check any already-ordered lines manually.`, null, 'warn');
}
