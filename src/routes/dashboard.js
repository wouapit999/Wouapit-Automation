import { Router } from 'express';
import { dashboardStats, listPurchaseOrders, recentEvents } from '../db.js';
import { formatXaf } from '../pricing.js';
import { config } from '../config.js';
import { layout, esc, attr, statusBadge } from '../util/html.js';

export const router = Router();

router.get('/', async (req, res) => {
  const s = await dashboardStats();
  const pending = (await listPurchaseOrders({ status: 'pending' })).slice(0, 10);
  const events = await recentEvents(8);
  const setup = [];
  if (!config.shopify.domain || !config.shopify.token) setup.push('Add your Shopify store domain and Admin API token in <code>.env</code>.');
  if (!config.shopify.apiSecret) setup.push('Add <code>SHOPIFY_API_SECRET</code> so order webhooks can be verified.');
  if (!config.appUrl) setup.push('Set <code>APP_URL</code> (public https URL) and register webhooks in Settings so paid orders flow in.');
  res.send(layout({ title: 'Dashboard', active: '/', body: `
  <h1>Dashboard</h1>
  ${setup.length ? `<div class="flash warn"><b>Setup to finish:</b><ul style="margin:6px 0 0 18px">${setup.map((x) => `<li>${x}</li>`).join('')}</ul></div>` : ''}
  <div class="grid">
    <div class="stat"><b>${s.published}/${s.products}</b><span>products published</span></div>
    <div class="stat"><b>${s.orders}</b><span>paid orders</span></div>
    <div class="stat"><b>${s.poPending}</b><span>supplier orders to place</span></div>
    <div class="stat"><b>${s.poOrdered}</b><span>waiting for tracking</span></div>
    <div class="stat"><b>${formatXaf(s.owedToSuppliersXaf)}</b><span>to pay suppliers now</span></div>
    <div class="stat"><b>${formatXaf(s.revenue)}</b><span>total collected</span></div>
  </div>
  <div class="card"><h2>To do: buy from suppliers</h2>
    ${pending.length ? `<table><thead><tr><th>PO</th><th>Order</th><th>Item</th><th class="right">Qty</th><th class="right">Pay supplier</th><th></th></tr></thead><tbody>${pending.map((p) => `<tr>
      <td><a href="/purchase-orders/${p.id}">PO-${p.id}</a></td><td>${esc(p.order_number)}</td><td>${esc(p.title)}</td><td class="right">${p.quantity}</td>
      <td class="right">${formatXaf(p.supplier_total_xaf)}</td><td>${p.supplier_url ? `<a target="_blank" href="${attr(p.supplier_url)}">supplier ↗</a>` : statusBadge('error')}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Nothing to buy right now. 🎉</p>'}
  </div>
  <div class="card"><h2>Recent activity</h2>
    <table><tbody>${events.map((e) => `<tr><td class="muted small" style="white-space:nowrap">${esc(e.created_at)}</td><td>${esc(e.message)}</td></tr>`).join('') || '<tr><td class="muted">No activity yet. Start by importing a product.</td></tr>'}</tbody></table>
  </div>
  <div class="card"><h2>How it works</h2>
    <ol class="small">
      <li><b>Import</b> a supplier link → the app reads price, images, variants and conditions.</li>
      <li><b>Review</b> the computed FCFA price (supplier + transport + customs + your markup + gateway fee) and publish to Shopify.</li>
      <li><b>Customer pays you</b> on Shopify (Mobile Money / card via your gateway). The <code>orders/paid</code> webhook creates a supplier order here.</li>
      <li><b>You pay the supplier</b> (or the AliExpress API does it) and record the order number. The difference is your profit.</li>
      <li><b>Tracking</b> is pushed back to Shopify so the customer is notified automatically.</li>
    </ol>
  </div>` }));
});
