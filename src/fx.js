import { getSetting, setSetting, logEvent } from './db.js';
import { DEFAULT_FX_RATES, DEFAULT_PRICING_RULES } from './pricing.js';

export async function getFxRates() {
  return { ...DEFAULT_FX_RATES, ...(await getSetting('fxRates', {}) || {}) };
}
export async function saveFxRates(rates) {
  const clean = {};
  for (const [k, v] of Object.entries(rates || {})) {
    const n = Number(v);
    if (k && !Number.isNaN(n) && n > 0) clean[k.toUpperCase()] = n;
  }
  clean.XAF = 1;
  clean.EUR = 655.957; // fixed peg
  await setSetting('fxRates', clean);
  return clean;
}
export async function getPricingRules() {
  return { ...DEFAULT_PRICING_RULES, ...(await getSetting('pricingRules', {}) || {}) };
}
export async function savePricingRules(rules) {
  const clean = {};
  for (const k of Object.keys(DEFAULT_PRICING_RULES)) {
    if (rules[k] === undefined || rules[k] === '') continue;
    const n = Number(rules[k]);
    if (!Number.isNaN(n)) clean[k] = n;
  }
  await setSetting('pricingRules', clean);
  return { ...DEFAULT_PRICING_RULES, ...clean };
}

/** Pull live rates (free, no API key) and store them. XAF stays pegged to EUR. */
export async function refreshFxRates(fetchImpl = fetch) {
  const res = await fetchImpl('https://open.er-api.com/v6/latest/EUR', { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`FX provider HTTP ${res.status}`);
  const data = await res.json();
  if (data.result !== 'success' || !data.rates) throw new Error('FX provider returned an unexpected payload');
  const xafPerEur = 655.957;
  const out = { ...getFxRates() };
  for (const cur of ['USD', 'CNY', 'GBP', 'EUR']) {
    const perEur = data.rates[cur];
    if (perEur) out[cur] = Math.round((xafPerEur / perEur) * 1000) / 1000;
  }
  const saved = await saveFxRates(out);
  await setSetting('fxUpdatedAt', new Date().toISOString());
  await logEvent('fx.refresh', `FX rates refreshed: 1 USD = ${saved.USD} XAF, 1 CNY = ${saved.CNY} XAF`);
  return saved;
}
