import { Router } from 'express';
import { insertProduct, getProduct, updateProduct, listProducts, deleteProduct, logEvent } from '../db.js';
import { importFromUrl } from '../providers/index.js';
import { adapterForUrl } from '../suppliers/registry.js';
import { priceProduct, effectiveRules, refreshProductFromSupplier } from '../sync.js';
import { deliveryEstimateDays, formatXaf, DEFAULT_PRICING_RULES } from '../pricing.js';
import { getFxRates } from '../fx.js';
import * as shopify from '../shopify.js';
import { config } from '../config.js';
import { layout, esc, attr, statusBadge } from '../util/html.js';

export const router = Router();
const redirectMsg = (res, path, type, message) => res.redirect(`${path}?${type}=${encodeURIComponent(message)}`);
const flashFrom = (q) => (q.ok ? { type: 'ok', message: q.ok } : q.err ? { type: 'err', message: q.err } : q.warn ? { type: 'warn', message: q.warn } : null);

// ---------- import ----------
router.get('/import', (req, res) => {
  res.send(layout({ title: 'Import product', active: '/import', flash: flashFrom(req.query), body: `
  <h1>Import a supplier product</h1>
  <div class="card">
    <form method="post" action="/import">
      <label><b>Supplier link</b> (AliExpress or Alibaba product page)</label>
      <input type="url" name="url" required placeholder="https://www.aliexpress.com/item/1005006123456789.html" autofocus>
      <div class="actions"><button type="submit">Fetch product</button></div>
    </form>
    <p class="muted small">The app reads title, images, variants, supplier price, shipping to Cameroon (when shown) and conditions such as minimum quantity.
    You then review everything, adjust the price rules, and publish to Shopify with one click. ${config.aliexpress.enabled ? 'AliExpress official API: <b>connected</b>.' : 'AliExpress official API: <b>not configured</b> (using the public page; set the keys in .env for reliable data and automatic ordering).'}</p>
  </div>` }));
});

router.post('/import', async (req, res) => {
  try {
    const adapter = adapterForUrl(String(req.body.url || '').trim());
    const imported = adapter ? (await adapter.getProduct(String(req.body.url).trim())).internal : await importFromUrl(req.body.url);
    priceProduct(imported);
    imported.pricing.importWarnings = imported.warnings || [];
    imported.pricing.confidence = imported.confidence;
    const id = insertProduct({ ...imported, status: 'draft' });
    logEvent('product.imported', `Imported "${imported.title || imported.source_url}" from ${imported.provider}`, { id });
    res.redirect(`/products/${id}`);
  } catch (e) {
    redirectMsg(res, '/import', 'err', `Import failed: ${e.message}`);
  }
});

// ---------- list ----------
router.get('/products', (req, res) => {
  const products = listProducts();
  const rows = products.map((p) => {
    const prices = p.variants.map((v) => v.sellingPriceXaf).filter(Boolean);
    const min = prices.length ? Math.min(...prices) : null, max = prices.length ? Math.max(...prices) : null;
    return `<tr>
      <td>${p.images[0] ? `<img src="${attr(p.images[0])}" style="width:44px;height:44px;object-fit:cover;border-radius:6px">` : ''}</td>
      <td><a href="/products/${p.id}">${esc(p.title)}</a><div class="muted small">${esc(p.provider)} · ${p.variants.length} variant(s)</div></td>
      <td>${min !== null ? (min === max ? formatXaf(min) : `${formatXaf(min)} – ${formatXaf(max)}`) : '—'}</td>
      <td>${statusBadge(p.status)}${p.shopify_handle ? ` <a class="small" target="_blank" href="https://${config.shopify.domain}/products/${attr(p.shopify_handle)}">view</a>` : ''}</td>
      <td class="muted small">${esc(p.updated_at)}</td></tr>`;
  }).join('');
  res.send(layout({ title: 'Products', active: '/products', flash: flashFrom(req.query), body: `
  <h1>Products <a class="btn" style="float:right" href="/import">+ Import</a></h1>
  <div class="card">${products.length ? `<table><thead><tr><th></th><th>Product</th><th>Selling price</th><th>Status</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">No products yet. Import your first supplier link.</p>'}</div>` }));
});

// ---------- review / edit ----------
router.get('/products/:id', (req, res) => {
  const p = getProduct(req.params.id);
  if (!p) return res.status(404).send('Not found');
  const rules = effectiveRules(p);
  const fx = getFxRates();
  const eta = deliveryEstimateDays(p.conditions, rules);
  const warnings = (p.pricing.importWarnings || []).map((w) => `<div class="flash warn">${esc(w)}</div>`).join('');
  const ov = p.pricing.overrides || {};

  const variantRows = p.variants.map((v, i) => `<tr>
    <td><input type="checkbox" name="variants[${i}][keep]" value="1" checked></td>
    <td><input type="text" name="variants[${i}][sku]" value="${attr(v.sku)}"></td>
    <td><input type="text" name="variants[${i}][title]" value="${attr(v.title)}"><input type="hidden" name="variants[${i}][options]" value="${attr(JSON.stringify(v.options || {}))}"><input type="hidden" name="variants[${i}][skuAttr]" value="${attr(v.skuAttr || '')}"><input type="hidden" name="variants[${i}][skuId]" value="${attr(v.skuId || '')}"><input type="hidden" name="variants[${i}][image]" value="${attr(v.image || '')}"><input type="hidden" name="variants[${i}][shopifyVariantId]" value="${attr(v.shopifyVariantId || '')}"></td>
    <td><input type="number" step="0.01" min="0" name="variants[${i}][supplierPrice]" value="${attr(v.supplierPrice)}"></td>
    <td><input type="number" step="0.01" min="0" name="variants[${i}][supplierShipping]" value="${attr(v.supplierShipping || 0)}"></td>
    <td><select name="variants[${i}][supplierCurrency]">${Object.keys(fx).map((c) => `<option ${c === (v.supplierCurrency || 'USD') ? 'selected' : ''}>${c}</option>`).join('')}</select></td>
    <td class="right"><b>${v.priceError ? `<span class="badge error">${esc(v.priceError)}</span>` : formatXaf(v.sellingPriceXaf)}</b>${v.breakdown ? `<div class="muted small">profit ${formatXaf(v.breakdown.profitXaf)} (${v.breakdown.marginPercent}%)</div>` : ''}</td>
  </tr>`).join('');

  const b = p.variants[0]?.breakdown;
  const breakdown = b ? `<details><summary>How the price of the first variant is calculated</summary>
    <table class="breakdown"><tbody>
    <tr><td>Supplier price ${esc(p.variants[0].supplierPrice)} ${esc(b.supplierCurrency)} × ${b.fxRate} XAF</td><td>${formatXaf(b.goodsXaf)}</td></tr>
    <tr><td>Supplier shipping to Cameroon</td><td>${formatXaf(b.supplierShippingXaf)}</td></tr>
    <tr><td>Customs / duty (${rules.customsDutyPercent}%)</td><td>${formatXaf(b.customsXaf)}</td></tr>
    <tr><td>Transport & local delivery</td><td>${formatXaf(b.transportFeeXaf)}</td></tr>
    <tr><td>Handling</td><td>${formatXaf(b.handlingFeeXaf)}</td></tr>
    <tr><td><b>Landed cost</b></td><td><b>${formatXaf(b.landedCostXaf)}</b></td></tr>
    <tr><td>Markup ${rules.markupPercent}% (min profit ${formatXaf(rules.minProfitXaf)})</td><td>${formatXaf(b.profitXaf)}</td></tr>
    <tr><td>Payment gateway fee (${rules.gatewayFeePercent}%)</td><td>${formatXaf(b.gatewayFeeXaf)}</td></tr>
    <tr><td><b>Selling price</b> (rounded to ${rules.roundTo})</td><td><b>${formatXaf(b.sellingPriceXaf)}</b></td></tr>
    </tbody></table></details>` : '';

  res.send(layout({ title: p.title || 'Review product', active: '/products', flash: flashFrom(req.query), body: `
  <h1>${esc(p.title || 'Untitled product')} ${statusBadge(p.status)}</h1>
  ${warnings}
  ${p.last_error ? `<div class="flash err">Last Shopify error: ${esc(p.last_error)}</div>` : ''}
  <form method="post" action="/products/${p.id}">
  <div class="card">
    <h2>Listing</h2>
    <p class="small muted">Source: <a href="${attr(p.source_url)}" target="_blank">${esc(p.source_url)}</a>${p.conditions.storeName ? ` · Supplier: ${esc(p.conditions.storeName)}` : ''}</p>
    <label><b>Title</b></label><input type="text" name="title" value="${attr(p.title)}" required>
    <label><b>Description (HTML)</b> — the conditions block (delivery time, MOQ, transport) is added automatically</label>
    <textarea name="description_html">${esc(p.description_html)}</textarea>
    <label><b>Images</b> — one URL per line (first one is the cover)</label>
    <textarea name="images">${esc(p.images.join('\n'))}</textarea>
    <div class="thumbs">${p.images.slice(0, 12).map((u) => `<img src="${attr(u)}" loading="lazy">`).join('')}</div>
  </div>
  <div class="card">
    <h2>Variants & supplier prices</h2>
    <table><thead><tr><th>Keep</th><th>SKU</th><th>Variant</th><th>Supplier price</th><th>Supplier shipping/unit</th><th>Cur.</th><th class="right">Selling price (XAF)</th></tr></thead><tbody>${variantRows}</tbody></table>
    ${breakdown}
  </div>
  <div class="card">
    <h2>Supplier conditions (passed on to the customer)</h2>
    <div class="row">
      <div><label><b>Minimum order quantity</b></label><input type="number" min="1" name="conditions[moq]" value="${attr(p.conditions.moq ?? 1)}"></div>
      <div><label><b>Supplier lead time (days)</b> → shown as ${eta.min}–${eta.max} days</label><input type="number" min="0" name="conditions[leadTimeDays]" value="${attr(p.conditions.leadTimeDays ?? '')}" placeholder="${DEFAULT_PRICING_RULES.defaultLeadTimeDays}"></div>
      <div><label><b>Shipping method</b></label><input type="text" name="conditions[shippingMethod]" value="${attr(p.conditions.shippingMethod ?? '')}" placeholder="AliExpress Standard Shipping"></div>
      <div><label><b>Supplier payment terms</b></label><input type="text" name="conditions[paymentTerms]" value="${attr(p.conditions.paymentTerms ?? '')}"></div>
    </div>
    <label><b>Other conditions / notes shown to the customer</b></label><textarea name="conditions[notes]" style="min-height:60px">${esc(p.conditions.notes ?? '')}</textarea>
  </div>
  <div class="card">
    <h2>Price rule overrides for this product <span class="muted small">(blank = use global settings)</span></h2>
    <div class="row">
      ${['markupPercent', 'minProfitXaf', 'customsDutyPercent', 'transportFeeXaf', 'handlingFeeXaf', 'roundTo', 'compareAtMultiplier'].map((k) => `<div><label><b>${k}</b> <span class="muted">(global: ${DEFAULT_PRICING_RULES[k] !== undefined ? esc(rules[k]) : ''})</span></label><input type="number" step="any" name="overrides[${k}]" value="${attr(ov[k] ?? '')}"></div>`).join('')}
    </div>
    <div class="actions">
      <button type="submit" name="action" value="save">Save & recompute prices</button>
      <button type="submit" name="action" value="publish">${p.shopify_product_id ? 'Save & update on Shopify' : 'Save & publish to Shopify'}</button>
    </div>
  </div>
  </form>
  <div class="card">
    <h2>Other actions</h2>
    <div class="actions">
      <form method="post" action="/products/${p.id}/refresh"><button class="secondary" type="submit">Refresh supplier price from source</button></form>
      ${p.shopify_product_id ? `<a class="btn secondary" target="_blank" href="https://${attr(config.shopify.domain)}/admin/products/${attr(p.shopify_product_id)}">Open in Shopify admin</a>
      <form method="post" action="/products/${p.id}/archive"><button class="secondary" type="submit">Archive on Shopify</button></form>` : ''}
      <form method="post" action="/products/${p.id}/delete" onsubmit="return confirm('Delete this product from the app? (Shopify is not touched)')"><button class="danger" type="submit">Delete locally</button></form>
    </div>
  </div>` }));
});

function applyForm(p, body) {
  p.title = String(body.title || '').trim();
  p.description_html = String(body.description_html || '');
  p.images = String(body.images || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const vs = Array.isArray(body.variants) ? body.variants : Object.values(body.variants || {});
  p.variants = vs.filter((v) => v.keep).map((v) => ({
    sku: String(v.sku || '').trim(), title: String(v.title || '').trim() || 'Default',
    options: (() => { try { return JSON.parse(v.options || '{}'); } catch { return {}; } })(),
    skuAttr: v.skuAttr || '', skuId: v.skuId || '', image: v.image || null,
    shopifyVariantId: v.shopifyVariantId || null,
    supplierPrice: Number(v.supplierPrice || 0), supplierShipping: Number(v.supplierShipping || 0),
    supplierCurrency: String(v.supplierCurrency || 'USD').toUpperCase(),
  }));
  const c = body.conditions || {};
  p.conditions = { ...p.conditions, moq: Number(c.moq) || 1, leadTimeDays: c.leadTimeDays === '' ? null : Number(c.leadTimeDays), shippingMethod: c.shippingMethod || null, paymentTerms: c.paymentTerms || '', notes: c.notes || '' };
  const overrides = {};
  for (const [k, v] of Object.entries(body.overrides || {})) if (v !== '' && !Number.isNaN(Number(v))) overrides[k] = Number(v);
  p.pricing = { ...p.pricing, overrides, importWarnings: [] };
}

router.post('/products/:id', async (req, res) => {
  const p = getProduct(req.params.id);
  if (!p) return res.status(404).send('Not found');
  try {
    applyForm(p, req.body);
    if (!p.title) throw new Error('Title is required');
    if (!p.variants.length) throw new Error('Keep at least one variant');
    priceProduct(p);
    updateProduct(p.id, { title: p.title, description_html: p.description_html, images: p.images, variants: p.variants, conditions: p.conditions, pricing: p.pricing });
    if (req.body.action !== 'publish') return redirectMsg(res, `/products/${p.id}`, 'ok', 'Saved. Prices recomputed.');
    await publish(p);
    return redirectMsg(res, `/products/${p.id}`, 'ok', p.shopify_product_id ? 'Product published to Shopify.' : 'Saved.');
  } catch (e) {
    updateProduct(p.id, { last_error: e.message });
    return redirectMsg(res, `/products/${p.id}`, 'err', e.message);
  }
});

async function publish(p) {
  const rules = effectiveRules(p);
  const bad = p.variants.filter((v) => !(v.sellingPriceXaf > 0));
  if (bad.length) throw new Error(`Variant "${bad[0].title}" has no selling price. Check the supplier price and currency.`);
  const result = await shopify.upsertProduct(p, { rules });
  for (const v of p.variants) {
    const m = result.variants.find((r) => r.sku && r.sku === v.sku)
      || result.variants.find((r) => Object.entries(v.options || {}).every(([k, val]) => String(r.options[k]) === String(val)) && Object.keys(v.options || {}).length)
      || (result.variants.length === 1 ? result.variants[0] : null);
    if (m) v.shopifyVariantId = m.id;
  }
  let published = false;
  try { published = await shopify.publishToOnlineStore(result.productId); } catch (e) { logEvent('shopify.publish_channel', `Could not add to Online Store channel automatically (${e.message}). Do it in Shopify admin if the product is not visible.`, null, 'warn'); }
  updateProduct(p.id, { shopify_product_id: result.productId, shopify_handle: result.handle, variants: p.variants, status: 'published', last_error: null });
  p.shopify_product_id = result.productId;
  logEvent('product.published', `Published "${p.title}" to Shopify (product ${result.productId}${published ? ', Online Store' : ''})`);
}

router.post('/products/:id/refresh', async (req, res) => {
  try {
    const r = await refreshProductFromSupplier(req.params.id);
    const msg = r.changed.length ? `Supplier price changed on ${r.changed.length} variant(s)${r.priceMoved ? '; selling prices updated' : ''}.` : 'No supplier price change.';
    redirectMsg(res, `/products/${req.params.id}`, r.warnings.length ? 'warn' : 'ok', msg + (r.warnings.length ? ' ' + r.warnings.join(' ') : ''));
  } catch (e) { redirectMsg(res, `/products/${req.params.id}`, 'err', `Refresh failed: ${e.message}`); }
});

router.post('/products/:id/archive', async (req, res) => {
  const p = getProduct(req.params.id);
  try {
    if (p?.shopify_product_id) await shopify.setProductStatus(p.shopify_product_id, 'ARCHIVED');
    updateProduct(req.params.id, { status: 'archived' });
    redirectMsg(res, `/products/${req.params.id}`, 'ok', 'Archived on Shopify.');
  } catch (e) { redirectMsg(res, `/products/${req.params.id}`, 'err', e.message); }
});

router.post('/products/:id/delete', (req, res) => {
  deleteProduct(req.params.id);
  redirectMsg(res, '/products', 'ok', 'Product deleted from the app.');
});
