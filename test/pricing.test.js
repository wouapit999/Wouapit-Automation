import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePrice, DEFAULT_PRICING_RULES, DEFAULT_FX_RATES, roundUpTo, deliveryEstimateDays } from '../src/pricing.js';

test('roundUpTo rounds up to the step', () => {
  assert.equal(roundUpTo(12345, 100), 12400);
  assert.equal(roundUpTo(12300, 100), 12300);
  assert.equal(roundUpTo(12301, 500), 12500);
});

test('computePrice covers cost, margin and gateway fee', () => {
  const rules = { ...DEFAULT_PRICING_RULES, markupPercent: 50, minProfitXaf: 0, transportFeeXaf: 2000, handlingFeeXaf: 0, customsDutyPercent: 10, gatewayFeePercent: 4, gatewayFixedFeeXaf: 0, roundTo: 1 };
  const fx = { ...DEFAULT_FX_RATES, USD: 600 };
  const b = computePrice({ supplierPrice: 10, supplierCurrency: 'USD', supplierShipping: 2 }, rules, fx);
  // goods 6000 + shipping 1200 + duty 600 + transport 2000 = 9800 landed
  assert.equal(b.landedCostXaf, 9800);
  // 9800 * 1.5 = 14700 ; / 0.96 = 15312.5 -> 15313
  assert.equal(b.sellingPriceXaf, 15313);
  assert.ok(b.profitXaf > 4800 && b.profitXaf < 4920, `profit ${b.profitXaf}`);
});

test('minimum profit floor applies to cheap items', () => {
  const rules = { ...DEFAULT_PRICING_RULES, markupPercent: 10, minProfitXaf: 3000, transportFeeXaf: 0, handlingFeeXaf: 0, gatewayFeePercent: 0, roundTo: 1 };
  const b = computePrice({ supplierPrice: 1, supplierCurrency: 'USD' }, rules, { USD: 600, XAF: 1 });
  assert.equal(b.sellingPriceXaf, 3600);
});

test('unknown currency throws a helpful error', () => {
  assert.throws(() => computePrice({ supplierPrice: 1, supplierCurrency: 'JPY' }), /No FX rate for JPY/);
});

test('compareAt is produced only when multiplier > 1', () => {
  const a = computePrice({ supplierPrice: 5, supplierCurrency: 'USD' }, { ...DEFAULT_PRICING_RULES, compareAtMultiplier: 0 });
  const b = computePrice({ supplierPrice: 5, supplierCurrency: 'USD' }, { ...DEFAULT_PRICING_RULES, compareAtMultiplier: 1.25 });
  assert.equal(a.compareAtXaf, null);
  assert.ok(b.compareAtXaf > b.sellingPriceXaf);
});

test('delivery estimate adds buffer and falls back to default', () => {
  assert.deepEqual(deliveryEstimateDays({ leadTimeDays: 10 }, { ...DEFAULT_PRICING_RULES, extraLeadTimeDays: 5 }), { min: 15, max: 22 });
  assert.deepEqual(deliveryEstimateDays({}, { ...DEFAULT_PRICING_RULES, defaultLeadTimeDays: 20, extraLeadTimeDays: 0 }), { min: 20, max: 27 });
});
