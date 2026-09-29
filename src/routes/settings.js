import { Router } from 'express';
import { config } from '../config.js';
import { getFxRates, saveFxRates, getPricingRules, savePricingRules, refreshFxRates } from '../fx.js';
import { DEFAULT_PRICING_RULES, computePrice, formatXaf } from '../pricing.js';
import { getSetting, recentEvents, logEvent } from '../db.js';
import * as shopify from '../shopify.js';
import { refreshAllPublished } from '../sync.js';
import { layout, esc, attr } from '../util/html.js';

export const router = Router();
const redirectMsg = (res, path, type, message) => res.redirect(`${path}?${type}=${encodeURIComponent(message)}`);
const flashFrom = (q) => (q.ok ? { type: 'ok', message: q.ok } : q.err ? { type: 'err', message: q.err } : null);

const RULE_HELP = {
  markupPercent: 'Your margin on top of the landed cost (%)',
  minProfitXaf: 'Minimum profit per unit (XAF)',
  customsDutyPercent: 'Customs / VAT estimate on goods value (%)',
  transportFeeXaf: 'Your forwarder + local delivery, per unit (XAF)',
  handlingFeeXaf: 'Packaging / handling per unit (XAF)',
  gatewayFeePercent: 'Payment gateway fee (MoMo / card) (%)',
  gatewayFixedFeeXaf: 'Fixed gateway fee per order (XAF)',
  roundTo: 'Round the selling price up to the nearest (XAF)',
  compareAtMultiplier: '"Compare at" price multiplier (0 = none, 1.2 = +20% struck-through)',
  defaultLeadTimeDays: 'Supplier lead time used when unknown (days)',
  extraLeadTimeDays: 'Safety buffer added to delivery estimate (days)',
};

router.get('/settings', async (req, res) => {
  const rules = await getPricingRules();
  const fx = await getFxRates();
  const sample = computePrice({ supplierPrice: 10, supplierCurrency: 'USD', supplierShipping: 3 }, rules, fx);
  const events = await recentEvents(25);
  res.send(layout({ title: 'Settings', active: '/settings', flash: flashFrom(req.query), body: `
  <h1>Settings</h1>
  <div class="card"><h2>Pricing rules</h2>
    <form method="post" action="/settings/pricing">
      <div class="row">${Object.keys(DEFAULT_PRICING_RULES).map((k) => `<div><label><b>${k}</b><br>${esc(RULE_HELP[k] || '')}</label><input type="number" step="any" name="${k}" value="${attr(rules[k])}"></div>`).join('')}</div>
      <p class="small muted">Example: a $10 item with $3 supplier shipping sells for <b>${formatXaf(sample.sellingPriceXaf)}</b> (landed ${formatXaf(sample.landedCostXaf)}, profit ${formatXaf(sample.profitXaf)}).</p>
      <div class="actions"><button type="submit">Save pricing rules</button></div>
    </form>
  </div>
  <div class="card"><h2>Exchange rates → XAF <span class="muted small">(last update: ${esc(await getSetting('fxUpdatedAt', 'never'))})</span></h2>
    <form method="post" action="/settings/fx">
      <div class="row">${Object.entries(fx).map(([k, v]) => `<div><label><b>1 ${k}</b> = … XAF</label><input type="number" step="any" name="${k}" value="${attr(v)}" ${k === 'XAF' || k === 'EUR' ? 'readonly' : ''}></div>`).join('')}
      <div><label><b>Add currency</b> (code, e.g. CNY)</label><input type="text" name="_newCode" placeholder="CODE"><input type="number" step="any" name="_newRate" placeholder="rate" style="margin-top:4px"></div></div>
      <div class="actions"><button type="submit">Save rates</button></form>
      <form method="post" action="/settings/fx/refresh"><button class="secondary" type="submit">Fetch live rates</button></form></div>
    <p class="small muted">The FCFA is pegged to the euro (655.957). Add a few % on USD/CNY if your bank or AliExpress applies a worse rate than the market.</p>
  </div>
  <div class="card"><h2>Connections</h2>
    <table><tbody>
      <tr><td>Shopify store</td><td>${config.shopify.domain ? `<code>${esc(config.shopify.domain)}</code> · API ${esc(config.shopify.apiVersion)} · new products: ${esc(config.shopify.defaultStatus)}` : '<span class="badge error">not configured</span>'}</td>
        <td class="right"><form method="post" action="/settings/shopify/test"><button class="secondary" type="submit">Test connection</button></form></td></tr>
      <tr><td>Order webhooks</td><td>${config.appUrl ? `<code>${esc(config.appUrl)}/webhooks/shopify</code>` : '<span class="badge error">APP_URL not set</span>'} · secret ${config.shopify.apiSecret ? 'set' : '<span class="badge error">missing</span>'}</td>
        <td class="right"><form method="post" action="/settings/shopify/webhooks"><button class="secondary" type="submit">Register webhooks</button></form></td></tr>
      <tr><td>AliExpress API</td><td>${config.aliexpress.enabled ? `connected · auto-order <b>${config.aliexpress.autoOrder ? 'ON' : 'off'}</b>` : 'not configured (page scraping fallback in use)'}</td><td></td></tr>
      <tr><td>Supplier price sync</td><td>${config.priceSyncIntervalHours > 0 ? `every ${config.priceSyncIntervalHours}h` : 'manual'}</td>
        <td class="right"><form method="post" action="/settings/sync-prices"><button class="secondary" type="submit">Sync all published now</button></form></td></tr>
    </tbody></table>
  </div>
  <div class="card"><h2>Recent activity</h2>
    <table><tbody>${events.map((e) => `<tr><td class="muted small" style="white-space:nowrap">${esc(e.created_at)}</td><td><span class="badge ${e.level === 'error' ? 'error' : e.level === 'warn' ? 'pending' : ''}">${esc(e.type)}</span></td><td>${esc(e.message)}</td></tr>`).join('') || '<tr><td class="muted">Nothing yet.</td></tr>'}</tbody></table>
  </div>` }));
});

router.post('/settings/pricing', async (req, res) => {
  await savePricingRules(req.body);
  redirectMsg(res, '/settings', 'ok', 'Pricing rules saved. Use "Save & recompute" on a product, or "Sync all published", to apply.');
});
router.post('/settings/fx', async (req, res) => {
  const { _newCode, _newRate, ...rates } = req.body;
  if (_newCode && _newRate) rates[String(_newCode).toUpperCase()] = _newRate;
  await saveFxRates(rates);
  redirectMsg(res, '/settings', 'ok', 'Exchange rates saved.');
});
router.post('/settings/fx/refresh', async (req, res) => {
  try { const r = await refreshFxRates(); redirectMsg(res, '/settings', 'ok', `Live rates fetched: 1 USD = ${r.USD} XAF, 1 CNY = ${r.CNY} XAF.`); }
  catch (e) { redirectMsg(res, '/settings', 'err', `Could not fetch rates: ${e.message}`); }
});
router.post('/settings/shopify/test', async (req, res) => {
  try { const s = await shopify.shopInfo(); redirectMsg(res, '/settings', 'ok', `Connected to "${s.name}" (${s.myshopifyDomain}), store currency ${s.currencyCode}${s.currencyCode !== 'XAF' ? ' — WARNING: prices are computed in XAF; set your store currency to XAF' : ''}.`); }
  catch (e) { redirectMsg(res, '/settings', 'err', e.message); }
});
router.post('/settings/shopify/webhooks', async (req, res) => {
  try {
    if (!config.appUrl) throw new Error('Set APP_URL in .env to your public https URL first');
    const r = await shopify.registerWebhooks(config.appUrl);
    await logEvent('webhooks.registered', r.map((x) => `${x.topic}: ${x.status}`).join(', '));
    redirectMsg(res, '/settings', 'ok', r.map((x) => `${x.topic}: ${x.status}`).join(' · '));
  } catch (e) { redirectMsg(res, '/settings', 'err', e.message); }
});
router.post('/settings/sync-prices', async (req, res) => {
  try {
    const r = await refreshAllPublished();
    const moved = r.filter((x) => x.priceMoved).length, failed = r.filter((x) => x.error).length;
    redirectMsg(res, '/settings', failed ? 'err' : 'ok', `Checked ${r.length} product(s): ${moved} price update(s), ${failed} error(s).`);
  } catch (e) { redirectMsg(res, '/settings', 'err', e.message); }
});
