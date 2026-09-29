import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-cred-')), 'pg');
process.env.ADMIN_PASSWORD = 'pw';
process.env.SHOPIFY_STORE_DOMAIN = 'env-store.myshopify.com';
process.env.SHOPIFY_ADMIN_TOKEN = 'env-token';

const { config } = await import('../src/config.js');
const { encrypt, decrypt, saveCredentials, applyCredentials, credentialStatus, loadCredentials } = await import('../src/credentials.js');
const { getDb, closeDb, getSetting } = await import('../src/db.js');

before(async () => { await getDb(); });
after(async () => { await closeDb(); });

test('encrypt/decrypt round-trips and rejects tampering', () => {
  const blob = encrypt({ a: 1, s: 'shpat_x' });
  assert.deepEqual(decrypt(blob), { a: 1, s: 'shpat_x' });
  const [iv, tag, ct] = blob.split('.');
  assert.throws(() => decrypt(`${iv}.${tag}.${Buffer.from('zz' + ct.slice(2), 'base64').toString('base64')}`));
});

test('environment values are the defaults until something is saved', async () => {
  await applyCredentials({ force: true });
  assert.equal(config.shopify.domain, 'env-store.myshopify.com');
  const st = await credentialStatus();
  assert.equal(st.shopifyDomain.source, 'environment');
  assert.equal(st.cronSecret.source, 'unset');
});

test('saved credentials override the environment and are stored encrypted', async () => {
  await saveCredentials({ shopifyDomain: 'ui-store.myshopify.com', shopifyToken: 'shpat_ui', cronSecret: 'c1', aliAutoOrder: 'true' });
  assert.equal(config.shopify.domain, 'ui-store.myshopify.com');
  assert.equal(config.shopify.token, 'shpat_ui');
  assert.equal(config.cronSecret, 'c1');
  assert.equal(config.aliexpress.autoOrder, true);
  const raw = await getSetting('credentials');
  assert.ok(!JSON.stringify(raw).includes('shpat_ui'), 'token must not be stored in clear text');
  const st = await credentialStatus();
  assert.equal(st.shopifyDomain.source, 'settings');
  assert.equal(st.shopifyToken.secret, true);
});

test('blank secret keeps the old value, __clear__ removes it, blank non-secret falls back to env', async () => {
  await saveCredentials({ shopifyToken: '', shopifyDomain: '' });
  assert.equal(config.shopify.token, 'shpat_ui');
  assert.equal(config.shopify.domain, 'env-store.myshopify.com');
  await saveCredentials({ shopifyToken: '__clear__' });
  assert.equal(config.shopify.token, 'env-token');
  assert.equal((await loadCredentials({ force: true })).shopifyToken, undefined);
});
