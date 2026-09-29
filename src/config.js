import fs from 'node:fs';
import path from 'node:path';

// Minimal .env loader (no dependency). Real environment variables win over .env values.
function loadDotEnv(file = '.env') {
  const p = path.resolve(process.cwd(), file);
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 3000),
  appUrl: (process.env.APP_URL || '').replace(/\/+$/, ''),
  adminPassword: process.env.ADMIN_PASSWORD || '',
  database: {
    // Neon Postgres connection string (Vercel Marketplace "Neon" sets DATABASE_URL). Empty = embedded PGlite in DATABASE_PATH.
    url: process.env.DATABASE_URL || process.env.POSTGRES_URL || '',
    path: process.env.DATABASE_PATH || './data/pg',
    poolMax: num(process.env.PG_POOL_MAX, process.env.VERCEL ? 1 : 5),
  },
  cronSecret: process.env.CRON_SECRET || '',
  shopify: {
    domain: process.env.SHOPIFY_STORE_DOMAIN || '',
    token: process.env.SHOPIFY_ADMIN_TOKEN || '',
    apiSecret: process.env.SHOPIFY_API_SECRET || '',
    apiVersion: process.env.SHOPIFY_API_VERSION || '2025-07',
    defaultStatus: (process.env.SHOPIFY_DEFAULT_STATUS || 'ACTIVE').toUpperCase(),
  },
  aliexpress: {
    appKey: process.env.ALIEXPRESS_APP_KEY || '',
    appSecret: process.env.ALIEXPRESS_APP_SECRET || '',
    accessToken: process.env.ALIEXPRESS_ACCESS_TOKEN || '',
    autoOrder: bool(process.env.ALIEXPRESS_AUTO_ORDER, false),
    get enabled() { return Boolean(this.appKey && this.appSecret && this.accessToken); },
  },
  priceSyncIntervalHours: num(process.env.PRICE_SYNC_INTERVAL_HOURS, 0),
};

export function assertShopifyConfigured() {
  const missing = [];
  if (!config.shopify.domain) missing.push('SHOPIFY_STORE_DOMAIN');
  if (!config.shopify.token) missing.push('SHOPIFY_ADMIN_TOKEN');
  if (missing.length) throw new Error(`Shopify is not configured: fill in ${missing.join(' and ').replace('SHOPIFY_STORE_DOMAIN', 'the store domain').replace('SHOPIFY_ADMIN_TOKEN', 'the Admin API token')} in Settings → Connections`);
}
