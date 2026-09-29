import crypto from 'node:crypto';
import { config } from './config.js';
import { getDb, logEvent, webhookSeen, getOrderByShopifyId, insertOrder, insertPurchaseOrder, updatePurchaseOrder, getProductByShopifyId, listPurchaseOrders } from './db.js';
import { getFxRates } from './fx.js';
import { toXaf } from './pricing.js';
import * as aliexpress from './providers/aliexpress.js';

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
  if (!verifyShopifyHmac(req.body, req.get('x-shopify-hmac-sha256'))) {
    logEvent('webhook.rejected', `Invalid HMAC for ${topic}`, null, 'warn');
    return res.status(401).send('invalid hmac');
  }
  res.status(200).send('ok'); // respond fast; Shopify retries on timeouts
  if (webhookSeen(webhookId)) return;
  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); } catch { return logEvent('webhook.bad_json', topic, null, 'error'); }
  try {
    if (topic === 'orders/paid') await processPaidOrder(payload);
    else if (topic === 'orders/cancelled') await processCancelledOrder(payload);
    else logEvent('webhook.ignored', `Ignored topic ${topic}`);
  } catch (e) {
    logEvent('webhook.error', `${topic}: ${e.message}`, { stack: e.stack }, 'error');
  }
}

/** Turn a paid Shopify order into purchase orders (what to buy from which supplier, and what you owe). */
export async function processPaidOrder(order) {
  if (getOrderByShopifyId(order.id)) return logEvent('order.duplicate', `Order ${order.name} already recorded`);
  const fx = getFxRates();
  const orderId = insertOrder({
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
    const product = li.product_id ? getProductByShopifyId(li.product_id) : null;
    const variant = product?.variants.find((v) => String(v.shopifyVariantId) === String(li.variant_id))
      || product?.variants.find((v) => v.sku && v.sku === li.sku)
      || product?.variants[0];
    const qty = Number(li.quantity || 1);
    let supplierTotalXaf = null;
    if (variant) {
      const total = (Number(variant.supplierPrice || 0) + Number(variant.supplierShipping || 0)) * qty;
      try { supplierTotalXaf = Math.round(toXaf(total, variant.supplierCurrency, fx)); } catch { /* unknown currency */ }
    }
    const poId = insertPurchaseOrder({
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
  logEvent('order.received', `Paid order ${order.name}: ${created.length} line(s) → purchase orders created`, { orderId, shopify_order_id: order.id });

  // Optional: place the AliExpress order automatically and pay the supplier from your AliExpress account.
  if (config.aliexpress.enabled && config.aliexpress.autoOrder) {
    const items = created.filter((c) => c.product?.provider === 'aliexpress' && c.product.source_product_id);
    if (items.length) {
      try {
        const { orderIds } = await aliexpress.placeOrder({
          items: items.map((c) => ({ productId: c.product.source_product_id, skuAttr: c.variant?.skuAttr, quantity: c.qty })),
          address: order.shipping_address || {},
          memo: `Shop order ${order.name}`,
        });
        for (const c of items) {
          updatePurchaseOrder(c.poId, { status: 'ordered', supplier_order_ref: orderIds.join(','), supplier_paid_at: new Date().toISOString(), notes: 'Placed automatically via AliExpress API' });
        }
        logEvent('supplier.auto_ordered', `AliExpress order(s) ${orderIds.join(', ')} placed for ${order.name}`);
      } catch (e) {
        logEvent('supplier.auto_order_failed', `Auto-order failed for ${order.name}: ${e.message}. Left as pending for manual purchase.`, null, 'error');
      }
    }
  }
  return orderId;
}

export async function processCancelledOrder(order) {
  const local = getOrderByShopifyId(order.id);
  if (!local) return;
  getDb().prepare("UPDATE orders SET financial_status = ? WHERE id = ?").run(order.financial_status || 'cancelled', local.id);
  for (const po of listPurchaseOrders({ orderId: local.id })) {
    if (po.status === 'pending') updatePurchaseOrder(po.id, { status: 'cancelled', notes: 'Shopify order cancelled before supplier purchase' });
  }
  logEvent('order.cancelled', `Order ${order.name} cancelled; pending supplier orders cancelled. Check any already-ordered lines manually.`, null, 'warn');
}
