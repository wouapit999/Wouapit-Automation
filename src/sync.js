// Shared logic: compute selling prices for a product, and refresh supplier prices from the source.
import { computePrice } from './pricing.js';
import { getFxRates, getPricingRules } from './fx.js';
import { getProduct, updateProduct, listProducts, logEvent } from './db.js';
import { importFromUrl } from './providers/index.js';
import * as shopify from './shopify.js';

export function effectiveRules(product) {
  return { ...getPricingRules(), ...(product?.pricing?.overrides || {}) };
}

/** Mutates product.variants with sellingPriceXaf / compareAtXaf / breakdown. Returns the rules used. */
export function priceProduct(product) {
  const rules = effectiveRules(product);
  const fx = getFxRates();
  for (const v of product.variants) {
    try {
      const b = computePrice({ supplierPrice: v.supplierPrice, supplierCurrency: v.supplierCurrency, supplierShipping: v.supplierShipping }, rules, fx);
      v.sellingPriceXaf = b.sellingPriceXaf;
      v.compareAtXaf = b.compareAtXaf;
      v.breakdown = b;
      v.priceError = null;
    } catch (e) {
      v.sellingPriceXaf = 0; v.compareAtXaf = null; v.breakdown = null; v.priceError = e.message;
    }
  }
  product.pricing = { ...(product.pricing || {}), rulesUsed: rules, fxUsed: fx, pricedAt: new Date().toISOString() };
  return rules;
}

/**
 * Re-fetch the supplier listing, update supplier prices on matching variants, recompute, and push new prices to
 * Shopify if the product is published. Returns { changed: [...], warnings }.
 */
export async function refreshProductFromSupplier(productId, { push = true } = {}) {
  const product = getProduct(productId);
  if (!product) throw new Error('Product not found');
  const fresh = await importFromUrl(product.source_url);
  const changed = [];
  for (const v of product.variants) {
    const match = fresh.variants.find((f) => f.skuAttr && f.skuAttr === v.skuAttr)
      || fresh.variants.find((f) => f.skuId && f.skuId === v.skuId)
      || fresh.variants.find((f) => f.title === v.title)
      || (fresh.variants.length === 1 && product.variants.length === 1 ? fresh.variants[0] : null);
    if (!match || !(match.supplierPrice > 0)) continue;
    const before = { price: v.supplierPrice, shipping: v.supplierShipping, currency: v.supplierCurrency };
    if (before.price !== match.supplierPrice || before.currency !== match.supplierCurrency || (match.supplierShipping > 0 && before.shipping !== match.supplierShipping)) {
      v.supplierPrice = match.supplierPrice;
      v.supplierCurrency = match.supplierCurrency;
      if (match.supplierShipping > 0) v.supplierShipping = match.supplierShipping;
      changed.push({ sku: v.sku, before, after: { price: v.supplierPrice, shipping: v.supplierShipping, currency: v.supplierCurrency } });
    }
    if (match.stock !== undefined) v.stock = match.stock;
  }
  const oldPrices = product.variants.map((v) => v.sellingPriceXaf);
  priceProduct(product);
  const priceMoved = product.variants.some((v, i) => v.sellingPriceXaf !== oldPrices[i]);
  updateProduct(product.id, { variants: product.variants, pricing: product.pricing });

  if (push && priceMoved && product.status === 'published' && product.shopify_product_id) {
    const withIds = product.variants.filter((v) => v.shopifyVariantId && v.sellingPriceXaf > 0);
    if (withIds.length) await shopify.updateVariantPrices(product.shopify_product_id, withIds);
    logEvent('price.synced', `Updated Shopify prices for "${product.title}"`, { changed });
  } else if (changed.length) {
    logEvent('price.changed', `Supplier price changed for "${product.title}" (not pushed)`, { changed });
  }
  return { changed, priceMoved, warnings: fresh.warnings || [] };
}

export async function refreshAllPublished() {
  const results = [];
  for (const p of listProducts({ status: 'published' })) {
    try {
      const r = await refreshProductFromSupplier(p.id);
      results.push({ id: p.id, title: p.title, ...r });
    } catch (e) {
      results.push({ id: p.id, title: p.title, error: e.message });
      logEvent('price.sync_failed', `${p.title}: ${e.message}`, null, 'error');
    }
  }
  return results;
}
