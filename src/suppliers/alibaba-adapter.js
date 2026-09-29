// @ts-check
import * as alibaba from '../providers/alibaba.js';
import { decodeVariantId, toSupplierProduct, UnsupportedOperationError } from './common.js';

/** @typedef {import('./types.js').SupplierAdapter} SupplierAdapter */

/**
 * Alibaba.com: no purchasing API for individual buyers, so this adapter reads listings and quotes only.
 * Purchase orders are placed by the operator (Trade Assurance) and recorded in the app.
 * @implements {SupplierAdapter}
 */
export class AlibabaAdapter {
  supplierId = 'alibaba';
  supportsAutomaticPurchasing = false;

  /** @returns {Promise<import('./common.js').SupplierProductWithInternal>} */
  async getProduct(productId) {
    const url = /^https?:\/\//i.test(productId) ? productId : `https://www.alibaba.com/product-detail/_${productId}.html`;
    const internal = await alibaba.importProduct(url);
    return toSupplierProduct(internal, (v) => v.skuId || '');
  }

  /** @param {import('./types.js').SupplierQuoteRequest} req */
  async getQuote(req) {
    const { productId } = decodeVariantId(req.supplierVariantId);
    const product = await this.getProduct(productId);
    const variant = product.variants.find((v) => v.supplierVariantId === req.supplierVariantId) || product.variants[0];
    if (!variant) throw new Error(`Variant ${req.supplierVariantId} not found`);
    const tiers = product.internal?.conditions?.priceTiers ?? [];
    const tier = [...tiers].reverse().find((t) => req.quantity >= t.min);
    const moq = Number(product.internal?.conditions?.moq) || 1;
    return {
      supplierId: this.supplierId,
      supplierVariantId: req.supplierVariantId,
      available: req.quantity >= moq && variant.cost.amount > 0,
      unitCost: tier ? { amount: tier.price, currency: variant.cost.currency } : variant.cost,
      shippingCost: { amount: 0, currency: variant.cost.currency }, // quoted by the supplier per order
      estimatedDeliveryMaxDays: product.internal?.conditions?.leadTimeDays ?? undefined,
      rawReference: moq > 1 ? `MOQ ${moq}` : undefined,
    };
  }

  /** @param {string} supplierVariantId */
  async checkInventory(supplierVariantId) {
    const { productId } = decodeVariantId(supplierVariantId);
    const product = await this.getProduct(productId);
    const v = product.variants.find((x) => x.supplierVariantId === supplierVariantId) || product.variants[0];
    return { available: Boolean(v && v.cost.amount > 0) };
  }

  /**
   * @param {import('./types.js').SupplierOrderRequest} _request
   * @returns {Promise<import('./types.js').SupplierOrderResult>}
   */
  async createPurchaseOrder(_request) {
    throw new UnsupportedOperationError('Alibaba has no purchasing API: place the order on Alibaba and record the order number.');
  }

  /** @returns {Promise<import('./types.js').SupplierTracking[]>} */
  async getTracking(_supplierOrderId) {
    return []; // tracking is entered manually from the Alibaba order page
  }
}
