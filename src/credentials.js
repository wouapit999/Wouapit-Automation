// Credentials editable from the admin Settings page. Stored in the database encrypted with AES-256-GCM.
// The encryption key is derived from ENCRYPTION_KEY if set, otherwise from ADMIN_PASSWORD (so changing the
// admin password without ENCRYPTION_KEY means re-entering the secrets). Environment variables remain the
// defaults; a value saved here overrides the corresponding variable.
import crypto from 'node:crypto';
import { config } from './config.js';
import { getSetting, setSetting, logEvent } from './db.js';

export const CREDENTIAL_FIELDS = {
  appUrl:            { label: 'Public URL of this app (APP_URL)', secret: false, apply: (v) => { config.appUrl = v.replace(/\/+$/, ''); }, env: () => process.env.APP_URL || '' },
  shopifyDomain:     { label: 'Shopify store domain', secret: false, apply: (v) => { config.shopify.domain = v; }, env: () => process.env.SHOPIFY_STORE_DOMAIN || '' },
  shopifyToken:      { label: 'Shopify Admin API access token', secret: true, apply: (v) => { config.shopify.token = v; }, env: () => process.env.SHOPIFY_ADMIN_TOKEN || '' },
  shopifyApiSecret:  { label: 'Shopify API secret key (webhook signatures)', secret: true, apply: (v) => { config.shopify.apiSecret = v; }, env: () => process.env.SHOPIFY_API_SECRET || '' },
  shopifyApiVersion: { label: 'Shopify API version', secret: false, apply: (v) => { config.shopify.apiVersion = v; }, env: () => process.env.SHOPIFY_API_VERSION || '2025-07' },
  cronSecret:        { label: 'Cron secret (price sync)', secret: true, apply: (v) => { config.cronSecret = v; }, env: () => process.env.CRON_SECRET || '' },
  aliAppKey:         { label: 'AliExpress app key', secret: false, apply: (v) => { config.aliexpress.appKey = v; }, env: () => process.env.ALIEXPRESS_APP_KEY || '' },
  aliAppSecret:      { label: 'AliExpress app secret', secret: true, apply: (v) => { config.aliexpress.appSecret = v; }, env: () => process.env.ALIEXPRESS_APP_SECRET || '' },
  aliAccessToken:    { label: 'AliExpress access token', secret: true, apply: (v) => { config.aliexpress.accessToken = v; }, env: () => process.env.ALIEXPRESS_ACCESS_TOKEN || '' },
  aliAutoOrder:      { label: 'Place AliExpress orders automatically', secret: false, apply: (v) => { config.aliexpress.autoOrder = /^(1|true|yes|on)$/i.test(v); }, env: () => process.env.ALIEXPRESS_AUTO_ORDER || 'false' },
};

const SETTING_KEY = 'credentials';
const CACHE_MS = 30000;
let cache = { at: 0, values: null };

function key() {
  const material = process.env.ENCRYPTION_KEY || config.adminPassword || 'wouapit-automation-dev';
  return crypto.scryptSync(material, 'wouapit-automation:credentials', 32);
}
export function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
}
export function decrypt(blob) {
  const [iv, tag, ct] = String(blob).split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8'));
}

/** Values saved in the database (decrypted). {} when none or when the key no longer matches. */
export async function loadCredentials({ force = false } = {}) {
  if (!force && cache.values && Date.now() - cache.at < CACHE_MS) return cache.values;
  let values = {};
  const stored = await getSetting(SETTING_KEY, null);
  if (stored?.data) {
    try { values = decrypt(stored.data); }
    catch { await logEvent('credentials.unreadable', 'Saved credentials cannot be decrypted (admin password or ENCRYPTION_KEY changed). Re-enter them in Settings.', null, 'warn'); }
  }
  cache = { at: Date.now(), values };
  return values;
}

/** Save fields from the settings form. Blank secret fields keep their previous value; "__clear__" removes one. */
export async function saveCredentials(input) {
  const current = await loadCredentials({ force: true });
  const next = { ...current };
  for (const [name, def] of Object.entries(CREDENTIAL_FIELDS)) {
    if (!(name in input)) continue;
    const v = String(input[name] ?? '').trim();
    if (v === '__clear__') { delete next[name]; continue; }
    if (v === '' && def.secret) continue; // keep existing secret
    if (v === '') { delete next[name]; continue; }
    next[name] = v;
  }
  await setSetting(SETTING_KEY, { v: 1, data: encrypt(next), updatedAt: new Date().toISOString() });
  cache = { at: 0, values: null };
  await applyCredentials({ force: true });
  return next;
}

/** Overlay saved credentials on top of the environment defaults in `config`. Call at the start of each request. */
export async function applyCredentials({ force = false } = {}) {
  const values = await loadCredentials({ force });
  for (const [name, def] of Object.entries(CREDENTIAL_FIELDS)) {
    const v = values[name] !== undefined && values[name] !== '' ? String(values[name]) : def.env();
    def.apply(v);
  }
  return values;
}

/** For the settings page: what is set, and where it comes from. */
export async function credentialStatus() {
  const values = await loadCredentials();
  const out = {};
  for (const [name, def] of Object.entries(CREDENTIAL_FIELDS)) {
    const fromDb = values[name] !== undefined && values[name] !== '';
    const envVal = def.env();
    out[name] = {
      label: def.label, secret: def.secret,
      value: fromDb ? String(values[name]) : envVal,
      source: fromDb ? 'settings' : envVal ? 'environment' : 'unset',
    };
  }
  return out;
}

export function generateSecret(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}
