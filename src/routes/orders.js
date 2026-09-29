import { Router } from 'express';
import { listOrders, getOrder, listPurchaseOrders, getPurchaseOrder, updatePurchaseOrder, getProduct, logEvent, pj } from '../db.js';
import { formatXaf } from '../pricing.js';
import { getFxRates } from '../fx.js';
import { toXaf } from '../pricing.js';
import * as shopify from '../shopify.js';
import { getAdapter } from '../suppliers/registry.js';
import { toSupplierAddress, encodeVariantId } from '../suppliers/common.js';
import { config } from '../config.js';
import { layout, esc, attr, statusBadge } from '../util/html.js';

export const router = Router();
const redirectMsg = (res, path, type, message) => res.redirect(`${path}?${type}=${encodeURIComponent(message)}`);
const flashFrom = (q) => (q.ok ? { type: 'ok', message: q.ok } : q.err ? { type: 'err', message: q.err } : null);

router.get('/orders', (req, res) => {
  const orders = listOrders();
  const rows = orders.map((o) => `<tr>
    <td><a href="/orders/${o.id}">${esc(o.order_number)}</a></td>
    <td>${esc(o.customer.name || '')}<div class="muted small">${esc(o.customer.phone || o.customer.email || '')}</div></td>
    <td>${esc(o.shipping_address.city || '')}</td>
    <td class="right">${esc(o.total_price)} ${esc(o.currency)}</td>
    <td>${o.po_pending > 0 ? `<span class="badge pending">${o.po_pending} to buy</span>` : `<span class="badge paid">${o.po_count} handled</span>`}</td>
    <td class="muted small">${esc(o.created_at)}</td></tr>`).join('');
  res.send(layout({ title: 'Orders', active: '/orders', flash: flashFrom(req.query), body: `
  <h1>Orders</h1>
  <div class="card">${orders.length ? `<table><thead><tr><th>Order</th><th>Customer</th><th>City</th><th class="right">Paid</th><th>Supplier orders</th><th>Received</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="muted">No paid orders yet. Orders appear here automatically when a customer pays on Shopify (webhook <code>orders/paid</code>). Register the webhook in Settings.</p>'}</div>` }));
});

router.get('/orders/:id', (req, res) => {
  const o = getOrder(req.params.id);
  if (!o) return res.status(404).send('Not found');
  const pos = listPurchaseOrders({ orderId: o.id });
  const a = o.shipping_address || {};
  res.send(layout({ title: `Order ${o.order_number}`, active: '/orders', flash: flashFrom(req.query), body: `
  <h1>Order ${esc(o.order_number)} <a class="btn secondary" style="float:right" target="_blank" href="https://${attr(config.shopify.domain)}/admin/orders/${attr(o.shopify_order_id)}">Open in Shopify</a></h1>
  <div class="grid">
    <div class="card"><h2>Customer</h2><p>${esc(o.customer.name)}<br>${esc(o.customer.phone || '')}<br>${esc(o.customer.email || '')}</p></div>
    <div class="card"><h2>Delivery address</h2><p>${esc(a.name || '')}<br>${esc(a.address1 || '')} ${esc(a.address2 || '')}<br>${esc(a.city || '')} ${esc(a.province || '')} ${esc(a.zip || '')}<br>${esc(a.country || '')}<br>${esc(a.phone || '')}</p></div>
    <div class="card"><h2>Paid</h2><p><b>${esc(o.total_price)} ${esc(o.currency)}</b><br><span class="muted">${esc(o.financial_status)}</span></p></div>
  </div>
  <div class="card"><h2>Supplier orders for this order</h2>${poTable(pos)}</div>` }));
});

function poTable(pos) {
  if (!pos.length) return '<p class="muted">Nothing here.</p>';
  return `<table><thead><tr><th>#</th><th>Order</th><th>Item</th><th class="right">Qty</th><th class="right">Owed to supplier</th><th>Status</th><th>Tracking</th></tr></thead><tbody>${pos.map((p) => `<tr>
    <td><a href="/purchase-orders/${p.id}">PO-${p.id}</a></td><td>${esc(p.order_number)}</td>
    <td>${esc(p.title)}${p.supplier_url ? ` <a class="small" target="_blank" href="${attr(p.supplier_url)}">supplier ↗</a>` : ' <span class="badge error">no supplier</span>'}</td>
    <td class="right">${p.quantity}</td>
    <td class="right">${p.supplier_total_xaf != null ? formatXaf(p.supplier_total_xaf) : '—'}<div class="muted small">${p.supplier_unit_cost != null ? `${esc(p.supplier_unit_cost)} + ${esc(p.supplier_shipping || 0)} ${esc(p.supplier_currency)}/u` : ''}</div></td>
    <td>${statusBadge(p.status)}${p.supplier_paid_at ? '<div class="small muted">paid</div>' : ''}</td>
    <td class="small">${esc(p.tracking_number || '')}</td></tr>`).join('')}</tbody></table>`;
}

router.get('/purchase-orders', (req, res) => {
  const status = req.query.status || '';
  const pos = listPurchaseOrders(status ? { status } : {});
  const owed = pos.filter((p) => p.status === 'pending' && !p.supplier_paid_at).reduce((s, p) => s + Number(p.supplier_total_xaf || 0), 0);
  const tabs = ['', 'pending', 'ordered', 'shipped', 'delivered', 'cancelled'].map((s) => `<a class="btn ${s === status ? '' : 'secondary'}" href="/purchase-orders${s ? `?status=${s}` : ''}">${s || 'all'}</a>`).join(' ');
  res.send(layout({ title: 'Supplier orders', active: '/purchase-orders', flash: flashFrom(req.query), body: `
  <h1>Supplier orders (what you must buy & pay)</h1>
  <div class="actions" style="margin-bottom:14px">${tabs}<span class="muted" style="margin-left:auto">Pending, not yet paid to suppliers: <b>${formatXaf(owed)}</b></span></div>
  <div class="card">${poTable(pos)}</div>` }));
});

router.get('/purchase-orders/:id', (req, res) => {
  const p = getPurchaseOrder(req.params.id);
  if (!p) return res.status(404).send('Not found');
  const a = pj(p.shipping_address_json, {});
  const c = pj(p.customer_json, {});
  const product = p.product_id ? getProduct(p.product_id) : null;
  const adapter = product ? getAdapter(product.provider) : null;
  const canAuto = Boolean(adapter?.supportsAutomaticPurchasing) && p.status === 'pending';
  res.send(layout({ title: `PO-${p.id}`, active: '/purchase-orders', flash: flashFrom(req.query), body: `
  <h1>PO-${p.id} · ${esc(p.title)} ${statusBadge(p.status)}</h1>
  <div class="grid">
    <div class="card"><h2>1. Buy from supplier</h2>
      <p>${p.supplier_url ? `<a class="btn" target="_blank" href="${attr(p.supplier_url)}">Open supplier page ↗</a>` : '<span class="badge error">No supplier link — product was not imported through this app</span>'}</p>
      <p><b>Quantity:</b> ${p.quantity}${p.supplier_sku_attr ? `<br><b>Variant (SKU attr):</b> <span class="mono">${esc(p.supplier_sku_attr)}</span>` : ''}<br><b>Variant:</b> ${esc(p.title)}</p>
      <p><b>You pay the supplier:</b> ${p.supplier_unit_cost != null ? `${esc(p.supplier_unit_cost)} ${esc(p.supplier_currency)} × ${p.quantity} + shipping ${esc(p.supplier_shipping || 0)} ${esc(p.supplier_currency)} × ${p.quantity} ≈ <b>${formatXaf(p.supplier_total_xaf)}</b>` : '—'}</p>
      <p><b>Customer paid you:</b> ${esc(p.sold_unit_price)} × ${p.quantity} = <b>${formatXaf(Number(p.sold_unit_price) * p.quantity)}</b></p>
      ${canAuto ? `<form method="post" action="/purchase-orders/${p.id}/auto-order"><button type="submit">Place & pay on ${esc(adapter.supplierId)} automatically</button></form>` : ''}
    </div>
    <div class="card"><h2>Ship to (paste on the supplier checkout)</h2>
      <pre class="mono" style="white-space:pre-wrap">${esc([a.name || c.name, a.address1, a.address2, [a.city, a.province, a.zip].filter(Boolean).join(' '), a.country || 'Cameroon', a.phone || c.phone].filter(Boolean).join('\n'))}</pre>
      <p class="muted small">Tip: many sellers ship to your forwarder in China/Douala instead; put that address on the supplier order and deliver locally yourself.</p>
    </div>
  </div>
  <div class="card"><h2>2. Record the supplier order & payment</h2>
    <form method="post" action="/purchase-orders/${p.id}/ordered">
      <div class="row">
        <div><label><b>Supplier order number</b></label><input type="text" name="supplier_order_ref" value="${attr(p.supplier_order_ref || '')}" required></div>
        <div><label><b>Amount actually paid (XAF)</b></label><input type="number" step="1" name="supplier_total_xaf" value="${attr(p.supplier_total_xaf ?? '')}"></div>
        <div><label><b>Notes</b></label><input type="text" name="notes" value="${attr(p.notes || '')}"></div>
      </div>
      <div class="actions"><button type="submit" ${p.status !== 'pending' ? 'class="secondary"' : ''}>Mark as ordered & paid</button></div>
    </form>
  </div>
  <div class="card"><h2>3. Tracking → fulfil on Shopify (customer gets the notification)</h2>
    <form method="post" action="/purchase-orders/${p.id}/ship">
      <div class="row">
        <div><label><b>Tracking number</b></label><input type="text" name="tracking_number" value="${attr(p.tracking_number || '')}" required></div>
        <div><label><b>Carrier</b></label><input type="text" name="tracking_company" value="${attr(p.tracking_company || '')}" placeholder="Cainiao, DHL, Aramex…"></div>
        <div><label><b>Tracking URL (optional)</b></label><input type="url" name="tracking_url" value="${attr(p.tracking_url || '')}"></div>
      </div>
      <div class="actions"><button type="submit">Save tracking & mark shipped on Shopify</button>
      ${p.supplier_order_ref && adapter?.supportsAutomaticPurchasing ? `</form><form method="post" action="/purchase-orders/${p.id}/fetch-tracking"><button class="secondary" type="submit">Fetch tracking from ${esc(adapter.supplierId)}</button>` : ''}
      </div>
    </form>
  </div>
  <div class="card"><h2>4. Close</h2>
    <div class="actions">
      <form method="post" action="/purchase-orders/${p.id}/status"><input type="hidden" name="status" value="delivered"><button class="secondary" type="submit">Mark delivered</button></form>
      <form method="post" action="/purchase-orders/${p.id}/status"><input type="hidden" name="status" value="cancelled"><button class="danger" type="submit">Cancel</button></form>
      <a class="btn secondary" href="/orders/${p.order_id}">Back to order ${esc(p.order_number)}</a>
    </div>
  </div>` }));
});

router.post('/purchase-orders/:id/ordered', (req, res) => {
  const paid = req.body.supplier_total_xaf === '' ? undefined : Number(req.body.supplier_total_xaf);
  updatePurchaseOrder(req.params.id, { status: 'ordered', supplier_order_ref: req.body.supplier_order_ref, supplier_paid_at: new Date().toISOString(), notes: req.body.notes || null, ...(paid !== undefined && !Number.isNaN(paid) ? { supplier_total_xaf: paid } : {}) });
  logEvent('supplier.ordered', `PO-${req.params.id} ordered from supplier (ref ${req.body.supplier_order_ref})`);
  redirectMsg(res, `/purchase-orders/${req.params.id}`, 'ok', 'Recorded as ordered and paid.');
});

router.post('/purchase-orders/:id/ship', async (req, res) => {
  const p = getPurchaseOrder(req.params.id);
  if (!p) return res.status(404).send('Not found');
  try {
    const fid = await shopify.fulfillLineItems(p.shopify_order_id, [{ shopifyLineItemId: p.shopify_line_item_id, quantity: p.quantity }],
      { number: req.body.tracking_number, company: req.body.tracking_company, url: req.body.tracking_url });
    updatePurchaseOrder(p.id, { status: 'shipped', tracking_number: req.body.tracking_number, tracking_company: req.body.tracking_company || null, tracking_url: req.body.tracking_url || null, shopify_fulfillment_id: fid });
    logEvent('supplier.shipped', `PO-${p.id} shipped, Shopify fulfilment ${fid} created`);
    redirectMsg(res, `/purchase-orders/${p.id}`, 'ok', 'Tracking saved and order marked fulfilled on Shopify.');
  } catch (e) {
    updatePurchaseOrder(p.id, { tracking_number: req.body.tracking_number, tracking_company: req.body.tracking_company || null, tracking_url: req.body.tracking_url || null });
    redirectMsg(res, `/purchase-orders/${p.id}`, 'err', `Tracking saved locally but Shopify fulfilment failed: ${e.message}`);
  }
});

router.post('/purchase-orders/:id/status', (req, res) => {
  const status = ['delivered', 'cancelled', 'pending'].includes(req.body.status) ? req.body.status : null;
  if (!status) return redirectMsg(res, `/purchase-orders/${req.params.id}`, 'err', 'Bad status');
  updatePurchaseOrder(req.params.id, { status });
  redirectMsg(res, `/purchase-orders/${req.params.id}`, 'ok', `Marked ${status}.`);
});

router.post('/purchase-orders/:id/auto-order', async (req, res) => {
  const p = getPurchaseOrder(req.params.id);
  const product = p?.product_id ? getProduct(p.product_id) : null;
  const adapter = product ? getAdapter(product.provider) : null;
  if (!p || !product || !adapter) return redirectMsg(res, `/purchase-orders/${req.params.id}`, 'err', 'No supplier product mapped');
  if (!adapter.supportsAutomaticPurchasing) return redirectMsg(res, `/purchase-orders/${p.id}`, 'err', `${adapter.supplierId} does not support automatic purchasing.`);
  try {
    const result = await adapter.createPurchaseOrder({
      idempotencyKey: `po:${p.id}`,
      externalOrderReference: `Shop order ${p.order_number}`,
      shippingAddress: toSupplierAddress(pj(p.shipping_address_json, {})),
      lines: [{ supplierVariantId: encodeVariantId(product.source_product_id, p.supplier_sku_attr || ''), quantity: p.quantity, expectedUnitCost: { amount: Number(p.supplier_unit_cost || 0), currency: p.supplier_currency || 'USD' } }],
    });
    if (result.status === 'REJECTED') return redirectMsg(res, `/purchase-orders/${p.id}`, 'err', `Supplier refused the order: ${result.message}`);
    updatePurchaseOrder(p.id, { status: 'ordered', supplier_order_ref: result.supplierOrderId, supplier_paid_at: new Date().toISOString(), notes: result.message || `Placed via ${adapter.supplierId}` });
    logEvent('supplier.auto_ordered', `PO-${p.id}: ${adapter.supplierId} order ${result.supplierOrderId}`);
    redirectMsg(res, `/purchase-orders/${p.id}`, 'ok', `${adapter.supplierId} order ${result.supplierOrderId} placed (${result.status}).`);
  } catch (e) { redirectMsg(res, `/purchase-orders/${p.id}`, 'err', e.message); }
});

router.post('/purchase-orders/:id/fetch-tracking', async (req, res) => {
  const p = getPurchaseOrder(req.params.id);
  const product = p?.product_id ? getProduct(p.product_id) : null;
  const adapter = product ? getAdapter(product.provider) : null;
  if (!p?.supplier_order_ref || !adapter) return redirectMsg(res, `/purchase-orders/${req.params.id}`, 'err', 'No supplier order reference');
  try {
    const t = (await adapter.getTracking(p.supplier_order_ref)).find((x) => x.trackingNumber);
    if (!t) return redirectMsg(res, `/purchase-orders/${p.id}`, 'err', 'The supplier has no tracking number yet.');
    updatePurchaseOrder(p.id, { tracking_number: t.trackingNumber, tracking_company: t.carrier || null, tracking_url: t.trackingUrl || null });
    redirectMsg(res, `/purchase-orders/${p.id}`, 'ok', `Tracking ${t.trackingNumber} fetched. Click "Save tracking & mark shipped" to notify the customer.`);
  } catch (e) { redirectMsg(res, `/purchase-orders/${p.id}`, 'err', e.message); }
});

// Keep an FX helper import used (for future manual recalculation)
export { toXaf, getFxRates };
