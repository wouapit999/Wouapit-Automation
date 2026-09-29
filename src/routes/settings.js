import { Router } from 'express';
import { config } from '../config.js';
import { getFxRates, saveFxRates, getPricingRules, savePricingRules, refreshFxRates } from '../fx.js';
import { DEFAULT_PRICING_RULES, computePrice, formatXaf } from '../pricing.js';
import { getSetting, recentEvents, logEvent } from '../db.js';
import * as shopify from '../shopify.js';
import { refreshAllPublished } from '../sync.js';
import { credentialStatus, saveCredentials, generateSecret, CREDENTIAL_FIELDS } from '../credentials.js';
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
  const cred = await credentialStatus();
  const src = (n) => cred[n].source === 'settings' ? '<span class="badge published">saved here</span>' : cred[n].source === 'environment' ? '<span class="badge">from environment</span>' : '<span class="badge error">not set</span>';
  const field = (n, extra = '') => { const c = cred[n]; return `<div><label><b>${esc(c.label)}</b> ${src(n)}</label><input type="${c.secret ? 'password' : 'text'}" name="${n}" value="${c.secret ? '' : attr(c.value)}" placeholder="${c.secret ? (c.value ? '•••••••• (saved — leave blank to keep)' : '') : ''}" autocomplete="off" ${extra}></div>`; };
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
  <div class="card"><h2>Connections &amp; credentials</h2>
    <p class="small muted">Saved encrypted in the database and used immediately; no redeploy needed. Values entered here override the environment variables of the same name.</p>
    <form method="post" action="/settings/credentials">
      <h3 style="margin:10px 0 0;font-size:15px">Shopify</h3>
      <div class="row">
        ${field('shopifyDomain', 'placeholder="ma-boutique.myshopify.com"')}
        ${field('shopifyToken')}
        ${field('shopifyApiSecret')}
        ${field('shopifyApiVersion')}
      </div>
      <h3 style="margin:16px 0 0;font-size:15px">This app</h3>
      <div class="row">
        ${field('appUrl', 'placeholder="https://wouapit-automation.vercel.app"')}
        ${field('cronSecret')}
      </div>
      <p class="small muted">Cron secret: on Vercel the scheduler sends this value itself, so the <b>same value</b> must also be in Vercel → Settings → Environment Variables → <code>CRON_SECRET</code>. Suggested value: <code>${esc(generateSecret())}</code></p>
      <h3 style="margin:16px 0 0;font-size:15px">AliExpress Dropshipping API (optional)</h3>
      <div class="row">
        ${field('aliAppKey')}
        ${field('aliAppSecret')}
        ${field('aliAccessToken')}
        <div><label><b>${esc(CREDENTIAL_FIELDS.aliAutoOrder.label)}</b> ${src('aliAutoOrder')}</label>
          <select name="aliAutoOrder"><option value="false" ${!/^(1|true|yes|on)$/i.test(cred.aliAutoOrder.value) ? 'selected' : ''}>Off — I buy manually</option><option value="true" ${/^(1|true|yes|on)$/i.test(cred.aliAutoOrder.value) ? 'selected' : ''}>On — order & pay automatically when a customer pays</option></select></div>
      </div>
      <p class="small muted">To remove a saved secret, type <code>__clear__</code> in its field.</p>
      <div class="actions"><button type="submit">Save credentials</button></div>
    </form>
  </div>
  <div class="card"><h2>Status</h2>
    <table><tbody>
      <tr><td>Shopify store</td><td>${config.shopify.domain ? `<code>${esc(config.shopify.domain)}</code> · API ${esc(config.shopify.apiVersion)} · new products: ${esc(config.shopify.defaultStatus)}` : '<span class="badge error">not configured</span>'}</td>
        <td class="right"><form method="post" action="/settings/shopify/test"><button class="secondary" type="submit">Test connection</button></form></td></tr>
      <tr><td>Order webhooks</td><td>${config.appUrl ? `<code>${esc(config.appUrl)}/webhooks/shopify</code>` : '<span class="badge error">public URL not set</span>'} · secret ${config.shopify.apiSecret ? 'set' : '<span class="badge error">missing</span>'}</td>
        <td class="right"><form method="post" action="/settings/shopify/webhooks"><button class="secondary" type="submit">Register webhooks</button></form></td></tr>
      <tr><td>AliExpress API</td><td>${config.aliexpress.enabled ? `connected · auto-order <b>${config.aliexpress.autoOrder ? 'ON' : 'off'}</b>` : 'not configured (page scraping fallback in use)'}</td><td></td></tr>
      <tr><td>Supplier price sync</td><td>${config.priceSyncIntervalHours > 0 ? `every ${config.priceSyncIntervalHours}h` : config.cronSecret ? 'daily via cron' : 'manual'}</td>
        <td class="right"><form method="post" action="/settings/sync-prices"><button class="secondary" type="submit">Sync all published now</button></form></td></tr>
    </tbody></table>
  </div>
  <div class="card"><h2>Recent activity</h2>
    <table><tbody>${events.map((e) => `<tr><td class="muted small" style="white-space:nowrap">${esc(e.created_at)}</td><td><span class="badge ${e.level === 'error' ? 'error' : e.level === 'warn' ? 'pending' : ''}">${esc(e.type)}</span></td><td>${esc(e.message)}</td></tr>`).join('') || '<tr><td class="muted">Nothing yet.</td></tr>'}</tbody></table>
  </div>` }));
});

router.post('/settings/credentials', async (req, res) => {
  try {
    await saveCredentials(req.body);
    await logEvent('credentials.saved', 'Connection credentials updated from Settings');
    redirectMsg(res, '/settings', 'ok', 'Credentials saved and active. Use "Test connection" to verify.');
  } catch (e) { redirectMsg(res, '/settings', 'err', `Could not save credentials: ${e.message}`); }
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
    if (!config.appUrl) throw new Error('Set the public URL of this app in Connections & credentials first');
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
