import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-')), 'test.sqlite');
process.env.SHOPIFY_API_SECRET = 'testsecret';
process.env.ADMIN_PASSWORD = 'pw';

const { verifyShopifyHmac, processPaidOrder, processCancelledOrder } = await import('../src/webhooks.js');
const { insertProduct, updateProduct, listPurchaseOrders, getOrderByShopifyId, getDb } = await import('../src/db.js');
const { createApp } = await import('../src/server.js');

before(() => getDb());

test('verifies Shopify HMAC', () => {
  const body = Buffer.from('{"id":1}');
  const good = crypto.createHmac('sha256', 'testsecret').update(body).digest('base64');
  assert.equal(verifyShopifyHmac(body, good), true);
  assert.equal(verifyShopifyHmac(body, 'nope'), false);
  assert.equal(verifyShopifyHmac(body, good, ''), false);
});

test('paid order creates purchase orders mapped to supplier variants', async () => {
  const id = insertProduct({ provider: 'aliexpress', source_url: 'https://www.aliexpress.com/item/1005.html', source_product_id: '1005', title: 'Earbuds',
    variants: [{ sku: '1005-1', title: 'Red', options: { Color: 'Red' }, skuAttr: '14:29', supplierPrice: 10, supplierShipping: 2, supplierCurrency: 'USD', shopifyVariantId: '555', sellingPriceXaf: 15000 }] });
  updateProduct(id, { shopify_product_id: '999', status: 'published' });
  await processPaidOrder({ id: 42, name: '#1001', currency: 'XAF', total_price: '31000', financial_status: 'paid',
    customer: { first_name: 'Ada', last_name: 'N' }, shipping_address: { city: 'Douala', phone: '+237 6 99 99 99 99' },
    line_items: [{ id: 1, product_id: 999, variant_id: 555, sku: '1005-1', title: 'Earbuds', variant_title: 'Red', quantity: 2, price: '15000' },
                 { id: 2, product_id: 123, variant_id: 1, title: 'Unknown thing', quantity: 1, price: '1000' }] });
  const order = getOrderByShopifyId(42);
  assert.ok(order);
  const pos = listPurchaseOrders({ orderId: order.id });
  assert.equal(pos.length, 2);
  const mapped = pos.find((p) => p.sku === '1005-1');
  assert.equal(mapped.status, 'pending');
  assert.equal(mapped.supplier_unit_cost, 10);
  assert.equal(mapped.supplier_total_xaf, (10 + 2) * 2 * 600);
  assert.equal(mapped.supplier_url, 'https://www.aliexpress.com/item/1005.html');
  const unmapped = pos.find((p) => p.title === 'Unknown thing');
  assert.equal(unmapped.supplier_url, null);
  assert.match(unmapped.notes, /No supplier mapping/);
  // duplicate delivery is ignored
  await processPaidOrder({ id: 42, name: '#1001', line_items: [] });
  assert.equal(listPurchaseOrders({ orderId: order.id }).length, 2);
  // cancellation cancels pending POs
  await processCancelledOrder({ id: 42, name: '#1001', financial_status: 'voided' });
  assert.ok(listPurchaseOrders({ orderId: order.id }).every((p) => p.status === 'cancelled'));
});

test('webhook endpoint rejects bad signatures and accepts good ones', async () => {
  const app = createApp();
  const server = app.listen(0);
  const port = server.address().port;
  const body = JSON.stringify({ id: 77, name: '#1002', line_items: [] });
  const bad = await fetch(`http://127.0.0.1:${port}/webhooks/shopify`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-shopify-topic': 'orders/paid', 'x-shopify-hmac-sha256': 'x' } });
  assert.equal(bad.status, 401);
  const hmac = crypto.createHmac('sha256', 'testsecret').update(body).digest('base64');
  const good = await fetch(`http://127.0.0.1:${port}/webhooks/shopify`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-shopify-topic': 'orders/paid', 'x-shopify-hmac-sha256': hmac, 'x-shopify-webhook-id': 'wh-1' } });
  assert.equal(good.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(getOrderByShopifyId(77));
  // admin UI requires auth
  const ui = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(ui.status, 401);
  const ok = await fetch(`http://127.0.0.1:${port}/`, { headers: { authorization: 'Basic ' + Buffer.from('admin:pw').toString('base64') } });
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Dashboard/);
  server.close();
});
