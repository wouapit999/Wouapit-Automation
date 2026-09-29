# CM Dropship — AliExpress/Alibaba → Shopify automation for Cameroon

Paste a supplier link, get a Shopify product priced in FCFA with your markup, transport, customs and the
supplier's conditions built in. When a customer pays you on Shopify, the app tells you exactly what to buy
from which supplier, what you owe them, and pushes the tracking number back to Shopify once the parcel
ships. With the AliExpress Dropshipping API it can even place and pay the supplier order for you.

```
 Supplier link ──► Import & price ──► Publish to Shopify ──► Customer pays YOU (MoMo / card)
 (AliExpress,      (XAF, markup,       (product, images,       │
  Alibaba)          transport,          variants, conditions)   ▼  orders/paid webhook
                    customs, fees)                    Supplier order created here
                                                      │  you (or the API) pay the supplier
                                                      ▼
                                             Tracking → Shopify fulfilment → customer notified
```

No database server, no build step: Node.js 22+, Express and the SQLite that ships with Node.

---

## 1. What you need before starting

| Item | Why |
|------|-----|
| **Shopify store** with currency set to **XAF** (Settings → Store details → Store currency) | Prices are computed in FCFA. |
| **A payment gateway that works in Cameroon** | Shopify Payments is not offered in Cameroon. Use a third‑party gateway that supports MTN MoMo / Orange Money / cards (e.g. Flutterwave, CinetPay, Paystack-compatible providers) or Shopify's *manual payment method* (customer pays by MoMo, you mark the order as paid in Shopify — this also fires the `orders/paid` webhook). |
| **Shopify custom app token** | Settings → Apps and sales channels → Develop apps → Create app → Configure Admin API scopes: `read_products, write_products, read_orders, write_orders, read_fulfillments, write_fulfillments, read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders, read_locations, read_publications, write_publications`. Install the app, copy the **Admin API access token** (`shpat_…`) and the **API secret key**. |
| **A public HTTPS URL** for this app | Shopify must reach `/webhooks/shopify`. On a laptop use `cloudflared tunnel --url http://localhost:3000` or ngrok; in production run it on a small VPS. |
| *(Optional, recommended)* **AliExpress Dropshipping API keys** | Reliable product data, live shipping cost to Cameroon, and automatic ordering/paying of the supplier. Register at https://openservice.aliexpress.com (Dropshipping app), then authorise your AliExpress buyer account to get an access token. Without it, the app reads the public product page, which AliExpress often blocks — you then fill the price in by hand. |

## 2. Install & run

```bash
cd dropship
npm install
cp .env.example .env      # fill in the values described in the file
npm start                  # http://localhost:3000  (user: admin, password: ADMIN_PASSWORD)
```

Then in the app:

1. **Settings → Test connection** to check the Shopify token (it warns if the store currency is not XAF).
2. **Settings → Fetch live rates** (or type your own USD/CNY → XAF rates; add a few % if AliExpress/your bank charges a worse rate).
3. **Settings → Pricing rules**: markup %, minimum profit, transport per unit, customs %, gateway fee %, rounding.
4. **Settings → Register webhooks** (needs `APP_URL`). This subscribes `orders/paid` and `orders/cancelled`.

## 3. Daily workflow

**Import** → paste an AliExpress or Alibaba product link → review page:

* title, description, images (editable),
* every variant with supplier price, supplier shipping to Cameroon, currency → computed **selling price in FCFA** with a profit line and a full breakdown,
* supplier conditions passed on to the customer: minimum quantity, lead time (+ your buffer), shipping method, notes → written into the Shopify description and product metafields,
* per‑product overrides of the pricing rules (e.g. heavier items → higher transport fee).

Click **Save & publish to Shopify**. The product is created (or updated) via the Admin GraphQL API, with
"continue selling when out of stock" and no inventory tracking, tagged `dropship`. Publishing to the Online Store
channel is attempted automatically; if your token lacks `write_publications`, tick the channel once in Shopify admin.

**When a customer pays**, the order appears under *Orders* and one **supplier order (PO)** per line under
*Supplier orders*, showing: supplier link + exact variant, quantity, the customer's address to paste at the
supplier checkout, what you owe the supplier in FCFA and what the customer paid you.

* Manual: buy it on AliExpress/Alibaba, then *Mark as ordered & paid* with the supplier order number.
* Automatic (AliExpress API + `ALIEXPRESS_AUTO_ORDER=true`): the order is placed and paid from your AliExpress
  account the moment the webhook arrives; the PO is marked *ordered* with the AliExpress order id. You can also
  trigger it per PO with the button *Place & pay on AliExpress automatically*.

**When it ships**, enter the tracking number (or *Fetch tracking from AliExpress*) → *Save tracking & mark
shipped on Shopify*: a fulfilment is created on the Shopify order and the customer gets the shipping email/SMS.

**Price drift**: *Refresh supplier price from source* on a product, *Sync all published now* in Settings, or
`npm run prices:sync` from cron / `PRICE_SYNC_INTERVAL_HOURS=12` in `.env`. If the supplier's price moved, the
selling price is recomputed and pushed to Shopify.

## 4. The pricing formula

```
goods          = supplierPrice × FX(supplierCurrency → XAF)
landedCost     = goods + supplierShipping×FX + goods×customsDuty% + transportFeeXaf + handlingFeeXaf
beforeFees     = max(landedCost × (1 + markup%), landedCost + minProfitXaf)
sellingPrice   = roundUp( beforeFees ÷ (1 − gatewayFee%) + gatewayFixedFeeXaf , roundTo )
```

Everything is configurable in *Settings*, and per product. The breakdown is displayed on every product page so
you can see exactly how much you keep after the gateway takes its cut and after you pay the supplier.

## 5. Files

```
src/server.js            Express app, Basic‑auth admin UI, webhook endpoint
src/routes/*.js          dashboard, import/review/publish, orders & supplier orders, settings
src/providers/           aliexpress.js (DS API + page fallback, order placement, tracking), alibaba.js, index.js
src/pricing.js           pricing engine (pure functions, unit‑tested)
src/shopify.js           Admin GraphQL: productSet, publish, price updates, webhooks, fulfilments
src/webhooks.js          HMAC verification, orders/paid → purchase orders, optional auto‑order
src/sync.js              recompute prices, refresh from supplier, push to Shopify
src/db.js                SQLite schema + queries (data/dropship.sqlite — back this folder up)
src/scripts/             register-webhooks, sync-prices, update-fx
test/                    `npm test`
```

## 6. Deploying on a VPS (production)

```bash
# Ubuntu, Node 22+
git clone <your repo> && cd wouapit999/dropship && npm ci --omit=dev
cp .env.example .env && nano .env        # APP_URL=https://shop-admin.yourdomain.com
npm i -g pm2 && pm2 start npm --name cm-dropship -- start && pm2 save && pm2 startup
```
Put Caddy or Nginx in front for HTTPS, restrict the admin UI to your IP if you can, and back up `data/`.

## 7. Limits you should know

* **Scraping is best‑effort.** AliExpress and Alibaba block automated page reads often (HTTP 403, captcha). The
  import never fails hard: you get a review form with warnings and fill in price/shipping by hand. For a real
  business, get the AliExpress Dropshipping API keys.
* **Alibaba has no ordering API** for individual buyers: orders are placed by you on Alibaba (Trade Assurance)
  and recorded here. Alibaba prices are quantity tiers with a **MOQ** — the app uses the lowest tier price and
  writes the MOQ into the listing; shipping must be quoted by the supplier and entered per unit.
* **Automatic supplier ordering** (`ALIEXPRESS_AUTO_ORDER`) spends real money from your AliExpress account.
  Test with one order and `false` first, and check the address mapping (Cameroon phone numbers, city/region).
* **Customs and taxes**: the `customsDutyPercent` rule is an estimate you set; check with your forwarder.
  You remain responsible for declaring and paying duties and for consumer law in Cameroon.
* **Supplier images and text** belong to the supplier. Most allow reuse for reselling; edit the listing if not.
* Refunds/returns are not automated: handle them in Shopify and update the PO status here.
