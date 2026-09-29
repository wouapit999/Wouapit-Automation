// @ts-check
/** @typedef {import('./types.js').SupplierProduct} SupplierProduct */
/** @typedef {import('./types.js').SupplierAddress} SupplierAddress */
/** @typedef {SupplierProduct & { internal?: any }} SupplierProductWithInternal */

/**
 * Variant ids are self-describing so a purchase order can be placed without a database lookup:
 *   "<supplierProductId>:<supplier sku attr or sku id>"   (the second part may be empty)
 */
export function encodeVariantId(productId, skuRef = '') {
  return `${productId}:${skuRef ?? ''}`;
}
/** @returns {{ productId: string, skuRef: string }} */
export function decodeVariantId(supplierVariantId) {
  const s = String(supplierVariantId ?? '');
  const i = s.indexOf(':');
  if (i === -1) return { productId: s, skuRef: '' };
  return { productId: s.slice(0, i), skuRef: s.slice(i + 1) };
}

/**
 * Convert the app's internal imported product (providers/*) into the public SupplierProduct shape.
 * The internal form is kept on a non-enumerable `internal` property for the import UI (pricing, conditions, warnings).
 * @returns {SupplierProductWithInternal}
 */
export function toSupplierProduct(internal, skuRefOf) {
  /** @type {SupplierProductWithInternal} */
  const out = {
    supplierProductId: String(internal.source_product_id ?? ''),
    supplierUrl: internal.source_url,
    title: internal.title,
    description: internal.description_html || undefined,
    images: internal.images ?? [],
    variants: (internal.variants ?? []).map((v) => ({
      supplierVariantId: encodeVariantId(internal.source_product_id, skuRefOf(v)),
      sku: v.sku,
      title: v.title,
      cost: { amount: Number(v.supplierPrice || 0), currency: v.supplierCurrency || 'USD' },
      availableQuantity: v.stock ?? undefined,
      weightKg: internal.conditions?.weightKg ?? undefined,
    })),
  };
  Object.defineProperty(out, 'internal', { value: internal, enumerable: false });
  return out;
}

/** Shopify-style address → SupplierAddress. */
export function toSupplierAddress(a = {}) {
  /** @type {SupplierAddress} */
  const out = {
    fullName: a.name || `${a.first_name || ''} ${a.last_name || ''}`.trim(),
    phone: String(a.phone || ''),
    line1: a.address1 || '',
    line2: a.address2 || undefined,
    city: a.city || '',
    region: a.province || undefined,
    postalCode: a.zip || undefined,
    countryCode: a.country_code || 'CM',
  };
  return out;
}

export class UnsupportedOperationError extends Error {
  /** @param {string} message */
  constructor(message) { super(message); this.name = 'UnsupportedOperationError'; }
}

/** @param {unknown} e */
export const errorMessage = (e) => (e instanceof Error ? e.message : String(e));
