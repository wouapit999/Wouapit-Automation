// @ts-check
import { AliExpressAdapter } from './aliexpress-adapter.js';
import { AlibabaAdapter } from './alibaba-adapter.js';
import { detectProvider } from '../providers/index.js';

/** @type {Record<string, import('./types.js').SupplierAdapter>} */
const adapters = {
  aliexpress: new AliExpressAdapter(),
  alibaba: new AlibabaAdapter(),
};

/** @returns {import('./types.js').SupplierAdapter | null} */
export function getAdapter(supplierId) {
  return adapters[supplierId] ?? null;
}
export function adapterForUrl(url) {
  const id = detectProvider(url);
  return id ? adapters[id] : null;
}
export function listAdapters() {
  return Object.values(adapters);
}
