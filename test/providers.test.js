import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ali from '../src/providers/aliexpress.js';
import * as alibaba from '../src/providers/alibaba.js';
import { detectProvider } from '../src/providers/index.js';
import { extractJsonAfter, normalizeImageUrl, metaContent } from '../src/util/json-extract.js';

test('detects providers from URLs', () => {
  assert.equal(detectProvider('https://www.aliexpress.com/item/1005006123456789.html?spm=x'), 'aliexpress');
  assert.equal(detectProvider('https://fr.aliexpress.com/item/1005006123456789.html'), 'aliexpress');
  assert.equal(detectProvider('https://a.aliexpress.com/_mKxyz'), 'aliexpress');
  assert.equal(detectProvider('https://www.alibaba.com/product-detail/Wireless-Earbuds_1600123456789.html'), 'alibaba');
  assert.equal(detectProvider('https://m.alibaba.com/product/1600123456789/x.html'), 'alibaba');
  assert.equal(detectProvider('https://example.com/p/1'), null);
});

test('extracts product ids', () => {
  assert.equal(ali.extractProductId('https://www.aliexpress.com/item/1005006123456789.html?x=1'), '1005006123456789');
  assert.equal(ali.extractProductId('https://www.aliexpress.us/item/3256805123456789.html'), '3256805123456789');
  assert.equal(ali.extractProductId('https://www.aliexpress.com/i/1005006123456789.html'), '1005006123456789');
  assert.equal(ali.extractProductId('https://a.aliexpress.com/_mKxyz'), null);
  assert.equal(alibaba.extractProductId('https://www.alibaba.com/product-detail/Wireless-Earbuds_1600123456789.html'), '1600123456789');
  assert.equal(alibaba.extractProductId('https://m.alibaba.com/product/1600123456789/x.html'), '1600123456789');
});

test('AliExpress API signature is deterministic HMAC-SHA256 uppercase hex', () => {
  const sig = ali.signParams({ b: '2', a: '1', method: 'x' }, 'secret');
  assert.match(sig, /^[0-9A-F]{64}$/);
  assert.equal(sig, ali.signParams({ method: 'x', a: '1', b: '2' }, 'secret'));
});

test('extractJsonAfter parses embedded runParams', () => {
  const html = `<script>window.runParams = {"data":{"a":[1,2,{"s":"}{"}]}}; window.other = 1;</script>`;
  assert.deepEqual(extractJsonAfter(html, 'window.runParams'), { data: { a: [1, 2, { s: '}{' }] } });
  assert.equal(extractJsonAfter(html, 'window.missing'), null);
});

test('normalizeImageUrl fixes protocol-relative and thumbnail suffixes', () => {
  assert.equal(normalizeImageUrl('//ae01.alicdn.com/kf/S1.jpg_220x220q75.jpg_.avif'), 'https://ae01.alicdn.com/kf/S1.jpg');
  assert.equal(normalizeImageUrl('https://ae01.alicdn.com/kf/S1_50x50.jpg'), 'https://ae01.alicdn.com/kf/S1.jpg');
  assert.equal(normalizeImageUrl('nope'), null);
});

test('metaContent reads og tags in either attribute order', () => {
  assert.equal(metaContent('<meta property="og:title" content="Hello &amp; bye">', 'og:title'), 'Hello & bye');
  assert.equal(metaContent('<meta content="X" property="og:image">', 'og:image'), 'X');
});

test('parses an AliExpress product page (runParams shape)', () => {
  const run = {
    data: {
      productInfoComponent: { subject: 'Wireless Earbuds TWS' },
      imageComponent: { imagePathList: ['//ae01.alicdn.com/kf/a.jpg_640x640.jpg', 'https://ae01.alicdn.com/kf/b.jpg'] },
      skuComponent: { productSKUPropertyList: [{ skuPropertyId: 14, skuPropertyName: 'Color', skuPropertyValues: [{ propertyValueId: 29, propertyValueDisplayName: 'Red' }, { propertyValueId: 193, propertyValueDisplayName: 'Black' }] }] },
      priceComponent: { skuPriceList: [
        { skuId: 1, skuAttr: '14:29#Red', skuVal: { actSkuCalPrice: '9.99', skuAmount: { currency: 'USD', value: 12.5 }, availQuantity: 10 } },
        { skuId: 2, skuAttr: '14:193', skuVal: { actSkuCalPrice: '10.49', skuAmount: { currency: 'USD', value: 13 }, availQuantity: 0 } },
      ] },
      webGeneralFreightCalculateComponent: { originalLayoutResultList: [{ bizData: { displayAmount: 'US $4.35', deliveryDayMax: 30, company: 'AliExpress Standard Shipping' } }] },
      sellerComponent: { storeName: 'Cool Store' },
    },
  };
  const html = `<html><head><meta property="og:title" content="ignored"></head><body><script>window.runParams = ${JSON.stringify(run)};</script></body></html>`;
  const p = ali.parseProductPage(html, 'https://www.aliexpress.com/item/1005.html', '1005');
  assert.equal(p.title, 'Wireless Earbuds TWS');
  assert.deepEqual(p.images, ['https://ae01.alicdn.com/kf/a.jpg', 'https://ae01.alicdn.com/kf/b.jpg']);
  assert.equal(p.variants.length, 2);
  assert.deepEqual(p.variants[0].options, { Color: 'Red' });
  assert.deepEqual(p.variants[1].options, { Color: 'Black' }); // resolved via property list
  assert.equal(p.variants[0].supplierPrice, 9.99);
  assert.equal(p.variants[0].supplierCurrency, 'USD');
  assert.equal(p.variants[0].supplierShipping, 4.35);
  assert.equal(p.conditions.leadTimeDays, 30);
  assert.equal(p.conditions.storeName, 'Cool Store');
  assert.equal(p.confidence, 'full');
});

test('AliExpress page without price falls back to JSON-LD and warns', () => {
  const html = `<html><head><script type="application/ld+json">{"@type":"Product","name":"Lamp","image":"https://x/i.jpg","offers":{"@type":"AggregateOffer","lowPrice":"3.20","priceCurrency":"USD"}}</script></head></html>`;
  const p = ali.parseProductPage(html, 'https://www.aliexpress.com/item/1.html', '1');
  assert.equal(p.title, 'Lamp');
  assert.equal(p.variants[0].supplierPrice, 3.2);
  assert.ok(p.warnings.some((w) => /Shipping cost/.test(w)));
});

test('parses an Alibaba product page with ladder prices and MOQ', () => {
  const detail = { globalData: { product: { subject: 'Solar Lamp 100W', mediaItems: [{ type: 'image', imageUrl: { big: '//s.alicdn.com/a.jpg' } }, { type: 'video', url: 'v.mp4' }], price: { productLadderPrices: [{ min: 50, max: 499, dollarPrice: '12.50' }, { min: 500, max: null, dollarPrice: '11.00' }] }, moq: '50 pieces' }, seller: { companyName: 'Shenzhen Light Co' } } };
  const html = `<script>window.detailData = ${JSON.stringify(detail)};</script>`;
  const p = alibaba.parseProductPage(html, 'https://www.alibaba.com/product-detail/x_1600.html', '1600');
  assert.equal(p.title, 'Solar Lamp 100W');
  assert.deepEqual(p.images, ['https://s.alicdn.com/a.jpg']);
  assert.equal(p.variants[0].supplierPrice, 12.5);
  assert.equal(p.conditions.moq, 50);
  assert.equal(p.conditions.storeName, 'Shenzhen Light Co');
  assert.equal(p.conditions.priceTiers.length, 2);
});
