// Pricing engine: turns a supplier quote into a Cameroon (XAF) selling price.
//
// landedCost   = (supplierPrice + supplierShipping) * fx           (goods delivered by supplier, in XAF)
//              + customsDuty% * goodsValueXaf                       (duty/VAT estimate at Douala/Yaoundé)
//              + transportFeeXaf                                    (your own forwarder / last-mile, per unit)
//              + handlingFeeXaf                                     (packaging, time, misc.)
// withMargin   = landedCost * (1 + markupPercent/100)
// beforeFees   = max(withMargin, landedCost + minProfitXaf)
// selling      = beforeFees / (1 - gatewayFeePercent/100) + gatewayFixedFeeXaf   (so the fee does not eat your margin)
// final        = roundUp(selling, roundTo)

export const DEFAULT_PRICING_RULES = {
  markupPercent: 40,        // your margin on landed cost
  minProfitXaf: 1500,       // never earn less than this per unit
  customsDutyPercent: 0,    // set e.g. 30 if your forwarder charges duty on declared value
  transportFeeXaf: 2500,    // per unit: forwarder + delivery inside Cameroon
  handlingFeeXaf: 500,      // per unit
  gatewayFeePercent: 3.5,   // Mobile Money / card gateway fee (Flutterwave, CinetPay...)
  gatewayFixedFeeXaf: 0,
  roundTo: 100,             // round selling price up to the nearest 100 XAF
  compareAtMultiplier: 0,   // 0 = no "compare at" price; 1.2 shows a struck-through price 20% higher
  defaultLeadTimeDays: 21,  // shown to the customer if the supplier gives none
  extraLeadTimeDays: 5,     // buffer you add on top of the supplier's delivery time
};

export const DEFAULT_FX_RATES = {
  // XAF is pegged to the EUR at exactly 655.957. Others are approximate; refresh with `npm run fx:update`.
  EUR: 655.957,
  USD: 600,
  CNY: 83,
  GBP: 760,
  XAF: 1,
};

export function toXaf(amount, currency, fxRates) {
  const cur = (currency || 'USD').toUpperCase();
  const rate = fxRates?.[cur];
  if (rate === undefined) throw new Error(`No FX rate for ${cur}. Add it in Settings.`);
  return Number(amount || 0) * rate;
}

export function roundUpTo(value, step) {
  if (!step || step <= 0) return Math.ceil(value);
  return Math.ceil(value / step) * step;
}

/**
 * @param {{supplierPrice:number, supplierCurrency:string, supplierShipping?:number}} quote
 * @param {object} rules  see DEFAULT_PRICING_RULES
 * @param {object} fxRates see DEFAULT_FX_RATES
 * @returns pricing breakdown with `sellingPriceXaf`
 */
export function computePrice(quote, rules = DEFAULT_PRICING_RULES, fxRates = DEFAULT_FX_RATES) {
  const r = { ...DEFAULT_PRICING_RULES, ...rules };
  const price = Number(quote.supplierPrice || 0);
  const shipping = Number(quote.supplierShipping || 0);
  const cur = quote.supplierCurrency || 'USD';

  const goodsXaf = toXaf(price, cur, fxRates);
  const supplierShippingXaf = toXaf(shipping, cur, fxRates);
  const customsXaf = goodsXaf * (Number(r.customsDutyPercent) / 100);
  const landedCostXaf = goodsXaf + supplierShippingXaf + customsXaf + Number(r.transportFeeXaf) + Number(r.handlingFeeXaf);

  const withMargin = landedCostXaf * (1 + Number(r.markupPercent) / 100);
  const beforeFees = Math.max(withMargin, landedCostXaf + Number(r.minProfitXaf));

  const feePct = Number(r.gatewayFeePercent) / 100;
  if (feePct >= 1) throw new Error('gatewayFeePercent must be below 100');
  const withFees = beforeFees / (1 - feePct) + Number(r.gatewayFixedFeeXaf);

  const sellingPriceXaf = roundUpTo(withFees, Number(r.roundTo));
  const gatewayFeeXaf = sellingPriceXaf * feePct + Number(r.gatewayFixedFeeXaf);
  const profitXaf = sellingPriceXaf - gatewayFeeXaf - landedCostXaf;
  const compareAtXaf = Number(r.compareAtMultiplier) > 1 ? roundUpTo(sellingPriceXaf * Number(r.compareAtMultiplier), Number(r.roundTo)) : null;

  return {
    supplierCurrency: cur,
    fxRate: fxRates[cur.toUpperCase()],
    goodsXaf: round2(goodsXaf),
    supplierShippingXaf: round2(supplierShippingXaf),
    customsXaf: round2(customsXaf),
    transportFeeXaf: Number(r.transportFeeXaf),
    handlingFeeXaf: Number(r.handlingFeeXaf),
    landedCostXaf: round2(landedCostXaf),
    gatewayFeeXaf: round2(gatewayFeeXaf),
    profitXaf: round2(profitXaf),
    marginPercent: sellingPriceXaf ? round2((profitXaf / sellingPriceXaf) * 100) : 0,
    sellingPriceXaf,
    compareAtXaf,
  };
}

/** Customer-facing delivery estimate in days: supplier lead time + your buffer. */
export function deliveryEstimateDays(conditions, rules = DEFAULT_PRICING_RULES) {
  const r = { ...DEFAULT_PRICING_RULES, ...rules };
  const base = Number(conditions?.leadTimeDays) > 0 ? Number(conditions.leadTimeDays) : Number(r.defaultLeadTimeDays);
  const min = base + Number(r.extraLeadTimeDays);
  return { min, max: min + 7 };
}

export const round2 = (n) => Math.round(n * 100) / 100;

export function formatXaf(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(Math.round(Number(n))) + ' FCFA';
}
