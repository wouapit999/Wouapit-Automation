import * as aliexpress from './aliexpress.js';
import * as alibaba from './alibaba.js';

export const providers = { aliexpress, alibaba };

export function detectProvider(url) {
  if (aliexpress.matches(url)) return 'aliexpress';
  if (alibaba.matches(url)) return 'alibaba';
  return null;
}

/** Import a supplier product from a link. Always returns a product (possibly partial with warnings). */
export async function importFromUrl(rawUrl) {
  let url = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch { throw new Error('That is not a valid link'); }
  const name = detectProvider(url);
  if (!name) {
    // Unknown supplier: create a manual product the operator fills in.
    return {
      provider: 'manual', source_url: url, source_product_id: null, title: '', description_html: '', images: [],
      variants: [{ sku: 'item-1', skuId: '', skuAttr: '', title: 'Default', options: {}, supplierPrice: 0, supplierCurrency: 'USD', supplierShipping: 0, stock: null, image: null }],
      conditions: { moq: 1, leadTimeDays: null, shippingMethod: null, paymentTerms: '', weightKg: null, storeName: null, notes: '' },
      confidence: 'partial',
      warnings: ['Unknown supplier site: only AliExpress and Alibaba are read automatically. Fill the fields manually.'],
    };
  }
  return providers[name].importProduct(url);
}
