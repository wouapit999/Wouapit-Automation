import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-sup-')), 'pg');
process.env.ADMIN_PASSWORD = 'pw';
process.env.ALIEXPRESS_APP_KEY = 'k'; process.env.ALIEXPRESS_APP_SECRET = 's'; process.env.ALIEXPRESS_ACCESS_TOKEN = 't';

const { encodeVariantId, decodeVariantId, toSupplierProduct, toSupplierAddress, UnsupportedOperationError } = await import('../src/suppliers/common.js');
const { getAdapter, adapterForUrl, listAdapters } = await import('../src/suppliers/registry.js');
const { AliExpressAdapter } = await import('../src/suppliers/aliexpress-adapter.js');
const { getDb, getPurchaseRequest, closeDb } = await import('../src/db.js');

before(async () => { await getDb(); });
after(async () => { await closeDb(); });

test('variant ids round-trip and tolerate colons in sku attrs', () => {
  const id = encodeVariantId('1005', '14:29#Red;5:100014064');
  assert.equal(id, '1005:14:29#Red;5:100014064');
  assert.deepEqual(decodeVariantId(id), { productId: '1005', skuRef: '14:29#Red;5:100014064' });
  assert.deepEqual(decodeVariantId('77'), { productId: '77', skuRef: '' });
});

test('registry resolves adapters by id and by URL', () => {
  assert.equal(getAdapter('aliexpress')?.supplierId, 'aliexpress');
  assert.equal(getAdapter('alibaba')?.supportsAutomaticPurchasing, false);
  assert.equal(getAdapter('nope'), null);
  assert.equal(adapterForUrl('https://www.alibaba.com/product-detail/x_1600123456789.html')?.supplierId, 'alibaba');
  assert.equal(listAdapters().length, 2);
});

test('internal product maps to SupplierProduct', () => {
  const internal = { source_product_id: '1005', source_url: 'u', title: 'T', description_html: '', images: ['i'], conditions: { weightKg: 0.3 },
    variants: [{ sku: 'A', title: 'Red', skuAttr: '14:29', supplierPrice: 9.5, supplierCurrency: 'USD', stock: 4 }] };
  const p = toSupplierProduct(internal, (v) => v.skuAttr);
  assert.equal(p.supplierProductId, '1005');
  assert.deepEqual(p.variants[0], { supplierVariantId: '1005:14:29', sku: 'A', title: 'Red', cost: { amount: 9.5, currency: 'USD' }, availableQuantity: 4, weightKg: 0.3 });
  assert.equal(p.description, undefined);
  assert.equal(JSON.stringify(p).includes('internal'), false); // hidden from serialisation
  assert.equal(p.internal, internal);
});

test('Shopify address maps to SupplierAddress with Cameroon default', () => {
  assert.deepEqual(toSupplierAddress({ name: 'Ada N', phone: '+237 6', address1: 'Rue 1', city: 'Douala' }),
    { fullName: 'Ada N', phone: '+237 6', line1: 'Rue 1', line2: undefined, city: 'Douala', region: undefined, postalCode: undefined, countryCode: 'CM' });
});

test('Alibaba adapter refuses automatic purchasing explicitly', async () => {
  await assert.rejects(() => getAdapter('alibaba').createPurchaseOrder({ idempotencyKey: 'x', externalOrderReference: 'o', shippingAddress: {}, lines: [] }), UnsupportedOperationError);
  assert.deepEqual(await getAdapter('alibaba').getTracking('123'), []);
});

test('AliExpress createPurchaseOrder is idempotent and records rejections', async (t) => {
  let calls = 0;
  let placeOrder = async ({ items, address }) => {
    calls++;
    assert.equal(items[0].productId, '1005'); assert.equal(items[0].skuAttr, '14:29'); assert.equal(items[0].quantity, 2);
    assert.equal(address.country_code, 'CM'); assert.equal(address.name, 'Ada N');
    return { orderIds: ['800123'], raw: {} };
  };
  const adapter = new AliExpressAdapter({ placeOrder: (...a) => placeOrder(...a) });
  assert.equal(adapter.supportsAutomaticPurchasing, true);
  const req = { idempotencyKey: 'shopify:42:aliexpress', externalOrderReference: 'Shop order #1001',
    shippingAddress: toSupplierAddress({ name: 'Ada N', phone: '+237699', address1: 'Rue 1', city: 'Douala' }),
    lines: [{ supplierVariantId: '1005:14:29', quantity: 2, expectedUnitCost: { amount: 10, currency: 'USD' } }] };
  const r1 = await adapter.createPurchaseOrder(req);
  assert.equal(r1.status, 'SUBMITTED'); assert.equal(r1.supplierOrderId, '800123');
  const r2 = await adapter.createPurchaseOrder(req);
  assert.deepEqual(r2, r1);
  assert.equal(calls, 1, 'second call with the same idempotency key must not place a second paid order');
  assert.equal((await getPurchaseRequest('shopify:42:aliexpress')).supplierOrderId, '800123');

  placeOrder = async () => { throw new Error('insufficient balance'); };
  const r3 = await adapter.createPurchaseOrder({ ...req, idempotencyKey: 'po:9' });
  assert.equal(r3.status, 'REJECTED'); assert.match(r3.message, /insufficient balance/);
});

test('AliExpress getTracking maps to SupplierTracking[]', async (t) => {
  const adapter = new AliExpressAdapter({ getTracking: async (id) => ({ trackingNumber: id === '1' ? 'LP123' : null, company: 'Cainiao', raw: {} }) });
  const t1 = await adapter.getTracking('1,2');
  assert.equal(t1.length, 2);
  assert.equal(t1[0].status, 'SHIPPED'); assert.equal(t1[0].trackingNumber, 'LP123'); assert.match(t1[0].trackingUrl, /LP123/);
  assert.equal(t1[1].status, 'PROCESSING'); assert.equal(t1[1].trackingNumber, undefined);
});
