// @ts-check
import { config } from '../config.js';
import * as ali from '../providers/aliexpress.js';
import { getPurchaseRequest, savePurchaseRequest } from '../db.js';
import { encodeVariantId, decodeVariantId, toSupplierProduct, UnsupportedOperationError, errorMessage } from './common.js';

/** @typedef {import('./types.js').SupplierAdapter} SupplierAdapter */

/** @implements {SupplierAdapter} */
export class AliExpressAdapter {
  supplierId = 'aliexpress';
  /** Marketplace functions, injectable for tests. */
  #api;
  /** @param {Partial<typeof ali>} [api] */
  constructor(api = {}) { this.#api = { ...ali, ...api }; }
  get supportsAutomaticPurchasing() { return config.aliexpress.enabled; }

  /**
   * @param {string} productId numeric AliExpress item id, or a product URL
   * @returns {Promise<import('./common.js').SupplierProductWithInternal>}
   */
  async getProduct(productId) {
    const url = /^https?:\/\//i.test(productId) ? productId : `https://www.aliexpress.com/item/${productId}.html`;
    const internal = await this.#api.importProduct(url);
    return toSupplierProduct(internal, (v) => v.skuAttr || v.skuId || '');
  }

  /** @param {import('./types.js').SupplierQuoteRequest} req */
  async getQuote(req) {
    const { productId, skuRef } = decodeVariantId(req.supplierVariantId);
    const product = await this.getProduct(productId);
    const variant = product.variants.find((v) => v.supplierVariantId === req.supplierVariantId) || product.variants[0];
    if (!variant) throw new Error(`Variant ${req.supplierVariantId} not found`);
    let shipping = { amount: 0, currency: variant.cost.currency };
    let minDays, maxDays, rawReference;
    if (config.aliexpress.enabled) {
      const internalVariant = product.internal?.variants.find((v) => (v.skuAttr || v.skuId || '') === skuRef);
      const f = await this.#api.queryFreight(productId, internalVariant?.skuId);
      if (f) { shipping = { amount: f.fee, currency: f.currency }; minDays = f.minDays ?? undefined; maxDays = f.maxDays ?? undefined; rawReference = f.serviceName ?? undefined; }
    } else {
      const internalVariant = product.internal?.variants.find((v) => (v.skuAttr || v.skuId || '') === skuRef);
      if (internalVariant?.supplierShipping) shipping = { amount: Number(internalVariant.supplierShipping), currency: variant.cost.currency };
      maxDays = product.internal?.conditions?.leadTimeDays ?? undefined;
    }
    const qty = variant.availableQuantity;
    return {
      supplierId: this.supplierId,
      supplierVariantId: req.supplierVariantId,
      available: qty === undefined || qty === null ? variant.cost.amount > 0 : qty >= req.quantity,
      unitCost: variant.cost,
      shippingCost: shipping,
      maximumQuantity: qty ?? undefined,
      estimatedDeliveryMinDays: minDays,
      estimatedDeliveryMaxDays: maxDays,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      rawReference,
    };
  }

  /** @param {string} supplierVariantId */
  async checkInventory(supplierVariantId) {
    const { productId } = decodeVariantId(supplierVariantId);
    const product = await this.getProduct(productId);
    const v = product.variants.find((x) => x.supplierVariantId === supplierVariantId) || product.variants[0];
    if (!v) return { available: false };
    return { available: v.availableQuantity === undefined ? v.cost.amount > 0 : v.availableQuantity > 0, quantity: v.availableQuantity };
  }

  /** @param {import('./types.js').SupplierOrderRequest} req */
  async createPurchaseOrder(req) {
    if (!this.supportsAutomaticPurchasing) throw new UnsupportedOperationError('AliExpress API is not configured; buy manually and record the order number.');
    const previous = getPurchaseRequest(req.idempotencyKey);
    if (previous) return previous; // same key → same result, never a second paid order
    const a = req.shippingAddress;
    /** @type {import('./types.js').SupplierOrderResult} */
    let result;
    try {
      const { orderIds } = await this.#api.placeOrder({
        items: req.lines.map((l) => { const d = decodeVariantId(l.supplierVariantId); return { productId: d.productId, skuAttr: d.skuRef || undefined, quantity: l.quantity }; }),
        address: { name: a.fullName, phone: a.phone, address1: a.line1, address2: a.line2, city: a.city, province: a.region, zip: a.postalCode, country_code: a.countryCode },
        memo: req.externalOrderReference,
      });
      result = { supplierOrderId: orderIds.join(','), status: 'SUBMITTED', message: 'Order placed via AliExpress Dropshipping API' };
    } catch (e) {
      result = { supplierOrderId: '', status: 'REJECTED', message: errorMessage(e) };
    }
    savePurchaseRequest(req.idempotencyKey, this.supplierId, req, result);
    return result;
  }

  /** @param {string} supplierOrderId */
  async getTracking(supplierOrderId) {
    /** @type {import('./types.js').SupplierTracking[]} */
    const out = [];
    for (const id of String(supplierOrderId).split(',').filter(Boolean)) {
      const t = await this.#api.getTracking(id);
      out.push({ supplierOrderId: id, status: t.trackingNumber ? 'SHIPPED' : 'PROCESSING', carrier: t.company ?? undefined, trackingNumber: t.trackingNumber ?? undefined, trackingUrl: t.trackingNumber ? `https://global.cainiao.com/newDetail.htm?mailNoList=${encodeURIComponent(t.trackingNumber)}` : undefined });
    }
    return out;
  }
}

export { encodeVariantId };
