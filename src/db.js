// Database layer on PostgreSQL.
//  - Production (Vercel): Neon, via DATABASE_URL (the Vercel Marketplace "Neon" integration sets it for you).
//  - Laptop / VPS / tests: PGlite, a full Postgres running inside the Node process, stored in DATABASE_PATH.
// Same SQL in both cases. All functions are async.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let backend;   // { query(sql, params) -> { rows, rowCount }, close() }
let ready;

async function createBackend() {
  if (config.database.url) {
    const pg = await import('pg');
    pg.default.types.setTypeParser(20, Number);        // int8 (COUNT) -> number
    pg.default.types.setTypeParser(1700, Number);      // numeric -> number
    const pool = new pg.default.Pool({
      connectionString: config.database.url,
      ssl: /localhost|127\.0\.0\.1/.test(config.database.url) ? undefined : { rejectUnauthorized: true },
      max: config.database.poolMax,
      idleTimeoutMillis: 10000,
    });
    return { kind: 'neon', query: (sql, params) => pool.query(sql, params), exec: (sql) => pool.query(sql), close: () => pool.end() };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = path.resolve(config.database.path);
  fs.mkdirSync(dir, { recursive: true });
  const db = new PGlite(dir);
  await db.waitReady;
  return {
    kind: 'pglite',
    query: async (sql, params) => { const r = await db.query(sql, params); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; },
    exec: (sql) => db.exec(sql),   // multi-statement DDL
    close: () => db.close(),
  };
}

/** Ensure the connection and schema exist. Safe to call many times; runs once per process. */
export function getDb() {
  if (!ready) ready = (async () => { backend = await createBackend(); await migrate(); return backend; })();
  return ready;
}
export async function closeDb() { if (backend) { await backend.close(); backend = undefined; ready = undefined; } }

async function migrate() {
  await backend.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    provider TEXT NOT NULL,
    source_url TEXT NOT NULL,
    source_product_id TEXT,
    title TEXT NOT NULL,
    description_html TEXT DEFAULT '',
    images_json TEXT DEFAULT '[]',
    variants_json TEXT DEFAULT '[]',
    conditions_json TEXT DEFAULT '{}',
    pricing_json TEXT DEFAULT '{}',
    shopify_product_id TEXT,
    shopify_handle TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_products_shopify ON products(shopify_product_id);
  CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    shopify_order_id TEXT NOT NULL UNIQUE,
    order_number TEXT,
    customer_json TEXT DEFAULT '{}',
    shipping_address_json TEXT DEFAULT '{}',
    currency TEXT,
    total_price DOUBLE PRECISION,
    financial_status TEXT,
    raw_json TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS purchase_orders (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    shopify_line_item_id TEXT,
    shopify_variant_id TEXT,
    sku TEXT,
    title TEXT,
    quantity INTEGER NOT NULL,
    sold_unit_price DOUBLE PRECISION,
    supplier_url TEXT,
    supplier_sku_attr TEXT,
    supplier_unit_cost DOUBLE PRECISION,
    supplier_shipping DOUBLE PRECISION DEFAULT 0,
    supplier_currency TEXT,
    supplier_total_xaf DOUBLE PRECISION,
    status TEXT NOT NULL DEFAULT 'pending',
    supplier_order_ref TEXT,
    supplier_paid_at TEXT,
    tracking_number TEXT,
    tracking_company TEXT,
    tracking_url TEXT,
    shopify_fulfillment_id TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);
  CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    level TEXT NOT NULL DEFAULT 'info',
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    data_json TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS supplier_purchase_requests (
    idempotency_key TEXT PRIMARY KEY,
    supplier_id TEXT NOT NULL,
    supplier_order_id TEXT,
    status TEXT NOT NULL,
    request_json TEXT,
    result_json TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS webhook_receipts (
    webhook_id TEXT PRIMARY KEY,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );`);
}

// ---------- low-level helpers ----------
/** Turn "?" placeholders into Postgres "$1, $2…" (none of our SQL contains a literal "?"). */
function positional(sql) { let n = 0; return sql.replace(/\?/g, () => `$${++n}`); }
const fmtDate = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
function normalizeRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = v instanceof Date ? fmtDate(v) : typeof v === 'bigint' ? Number(v) : v;
  return out;
}
async function run(sql, args = []) {
  const b = await getDb();
  return b.query(positional(sql), args);
}
async function get(sql, args = []) {
  const r = await run(sql, args);
  return r.rows[0] ? normalizeRow(r.rows[0]) : undefined;
}
async function all(sql, args = []) {
  const r = await run(sql, args);
  return r.rows.map(normalizeRow);
}
const lastId = (r) => Number(r.rows[0].id);

export const j = (v) => JSON.stringify(v ?? null);
export const pj = (s, fallback) => {
  if (s === null || s === undefined || s === '') return fallback;
  try { return JSON.parse(String(s)); } catch { return fallback; }
};

export async function logEvent(type, message, data = null, level = 'info') {
  const line = `[${level}] ${type}: ${message}`;
  if (level === 'error') console.error(line); else console.log(line);
  try {
    await run('INSERT INTO events (level, type, message, data_json) VALUES (?, ?, ?, ?)', [level, type, message, data ? j(data) : null]);
  } catch (e) {
    console.error('logEvent failed', e);
  }
}

// ---------- settings ----------
export async function getSetting(key, fallback = undefined) {
  const row = await get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? pj(row.value, fallback) : fallback;
}
export async function setSetting(key, value) {
  await run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, j(value)]);
}

// ---------- products ----------
export function rowToProduct(row) {
  if (!row) return null;
  return { ...row, images: pj(row.images_json, []), variants: pj(row.variants_json, []), conditions: pj(row.conditions_json, {}), pricing: pj(row.pricing_json, {}) };
}
export async function insertProduct(p) {
  const r = await run(`INSERT INTO products
    (provider, source_url, source_product_id, title, description_html, images_json, variants_json, conditions_json, pricing_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, [
    p.provider, p.source_url, p.source_product_id ?? null, p.title, p.description_html ?? '',
    j(p.images ?? []), j(p.variants ?? []), j(p.conditions ?? {}), j(p.pricing ?? {}), p.status ?? 'draft']);
  return lastId(r);
}
export async function updateProduct(id, fields) {
  const map = {
    title: 'title', description_html: 'description_html', status: 'status', last_error: 'last_error',
    shopify_product_id: 'shopify_product_id', shopify_handle: 'shopify_handle', source_url: 'source_url',
    images: 'images_json', variants: 'variants_json', conditions: 'conditions_json', pricing: 'pricing_json',
  };
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!(k in map)) continue;
    sets.push(`${map[k]} = ?`);
    vals.push(map[k].endsWith('_json') ? j(v) : v ?? null);
  }
  if (!sets.length) return;
  sets.push("updated_at = now()");
  vals.push(id);
  await run(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`, vals);
}
export async function getProduct(id) {
  return rowToProduct(await get('SELECT * FROM products WHERE id = ?', [id]));
}
export async function getProductByShopifyId(shopifyProductId) {
  return rowToProduct(await get('SELECT * FROM products WHERE shopify_product_id = ?', [String(shopifyProductId)]));
}
export async function listProducts({ status } = {}) {
  const rows = status
    ? await all('SELECT * FROM products WHERE status = ? ORDER BY id DESC', [status])
    : await all('SELECT * FROM products ORDER BY id DESC');
  return rows.map(rowToProduct);
}
export async function deleteProduct(id) {
  await run('DELETE FROM products WHERE id = ?', [id]);
}

// ---------- orders / purchase orders ----------
export function rowToOrder(row) {
  if (!row) return null;
  return { ...row, customer: pj(row.customer_json, {}), shipping_address: pj(row.shipping_address_json, {}), raw: pj(row.raw_json, null) };
}
export async function getOrderByShopifyId(shopifyOrderId) {
  return rowToOrder(await get('SELECT * FROM orders WHERE shopify_order_id = ?', [String(shopifyOrderId)]));
}
export async function getOrder(id) {
  return rowToOrder(await get('SELECT * FROM orders WHERE id = ?', [id]));
}
export async function insertOrder(o) {
  const r = await run(`INSERT INTO orders
    (shopify_order_id, order_number, customer_json, shipping_address_json, currency, total_price, financial_status, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, [
    String(o.shopify_order_id), o.order_number ?? null, j(o.customer ?? {}), j(o.shipping_address ?? {}),
    o.currency ?? null, o.total_price ?? null, o.financial_status ?? null, j(o.raw ?? null)]);
  return lastId(r);
}
export async function updateOrderStatus(id, financialStatus) {
  await run('UPDATE orders SET financial_status = ? WHERE id = ?', [financialStatus, id]);
}
export async function listOrders() {
  const rows = await all(`SELECT o.*,
      (SELECT COUNT(*) FROM purchase_orders p WHERE p.order_id = o.id) AS po_count,
      (SELECT COUNT(*) FROM purchase_orders p WHERE p.order_id = o.id AND p.status = 'pending') AS po_pending
    FROM orders o ORDER BY o.id DESC`);
  return rows.map(rowToOrder);
}
export async function insertPurchaseOrder(po) {
  const r = await run(`INSERT INTO purchase_orders
    (order_id, product_id, shopify_line_item_id, shopify_variant_id, sku, title, quantity, sold_unit_price,
     supplier_url, supplier_sku_attr, supplier_unit_cost, supplier_shipping, supplier_currency, supplier_total_xaf, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, [
    po.order_id, po.product_id ?? null, po.shopify_line_item_id != null ? String(po.shopify_line_item_id) : null,
    po.shopify_variant_id != null ? String(po.shopify_variant_id) : null, po.sku ?? null,
    po.title ?? null, po.quantity, po.sold_unit_price ?? null, po.supplier_url ?? null, po.supplier_sku_attr ?? null,
    po.supplier_unit_cost ?? null, po.supplier_shipping ?? 0, po.supplier_currency ?? null, po.supplier_total_xaf ?? null,
    po.status ?? 'pending', po.notes ?? null]);
  return lastId(r);
}
export async function updatePurchaseOrder(id, fields) {
  const allowed = ['status', 'supplier_order_ref', 'supplier_paid_at', 'tracking_number', 'tracking_company', 'tracking_url',
    'shopify_fulfillment_id', 'notes', 'supplier_unit_cost', 'supplier_shipping', 'supplier_currency', 'supplier_total_xaf'];
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`); vals.push(v ?? null);
  }
  if (!sets.length) return;
  sets.push("updated_at = now()");
  vals.push(id);
  await run(`UPDATE purchase_orders SET ${sets.join(', ')} WHERE id = ?`, vals);
}
export async function getPurchaseOrder(id) {
  return get(`SELECT p.*, o.shopify_order_id, o.order_number, o.shipping_address_json, o.customer_json
    FROM purchase_orders p JOIN orders o ON o.id = p.order_id WHERE p.id = ?`, [id]);
}
export async function listPurchaseOrders({ status, orderId } = {}) {
  let sql = `SELECT p.*, o.order_number, o.shopify_order_id FROM purchase_orders p JOIN orders o ON o.id = p.order_id`;
  const where = [], vals = [];
  if (status) { where.push('p.status = ?'); vals.push(status); }
  if (orderId) { where.push('p.order_id = ?'); vals.push(orderId); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY p.id DESC';
  return all(sql, vals);
}
export async function dashboardStats() {
  const one = async (sql) => Number(Object.values((await get(sql)) || { n: 0 })[0] || 0);
  return {
    products: await one('SELECT COUNT(*) AS n FROM products'),
    published: await one("SELECT COUNT(*) AS n FROM products WHERE status = 'published'"),
    orders: await one('SELECT COUNT(*) AS n FROM orders'),
    poPending: await one("SELECT COUNT(*) AS n FROM purchase_orders WHERE status = 'pending'"),
    poOrdered: await one("SELECT COUNT(*) AS n FROM purchase_orders WHERE status = 'ordered'"),
    owedToSuppliersXaf: await one("SELECT COALESCE(SUM(supplier_total_xaf),0) AS n FROM purchase_orders WHERE status IN ('pending') AND supplier_paid_at IS NULL"),
    revenue: await one('SELECT COALESCE(SUM(total_price),0) AS n FROM orders'),
  };
}
export async function recentEvents(limit = 30) {
  return all('SELECT * FROM events ORDER BY id DESC LIMIT ?', [limit]);
}
/** Returns true if this webhook id was already processed; records it otherwise. */
export async function webhookSeen(id) {
  if (!id) return false;
  const r = await run('INSERT INTO webhook_receipts (webhook_id) VALUES (?) ON CONFLICT (webhook_id) DO NOTHING', [id]);
  return Number(r.rowCount) === 0;
}

// ---------- supplier purchase idempotency ----------
export async function getPurchaseRequest(idempotencyKey) {
  const row = await get('SELECT result_json FROM supplier_purchase_requests WHERE idempotency_key = ?', [idempotencyKey]);
  return row ? pj(row.result_json, null) : null;
}
export async function savePurchaseRequest(idempotencyKey, supplierId, request, result) {
  await run(`INSERT INTO supplier_purchase_requests (idempotency_key, supplier_id, supplier_order_id, status, request_json, result_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (idempotency_key) DO UPDATE SET supplier_order_id = EXCLUDED.supplier_order_id, status = EXCLUDED.status, result_json = EXCLUDED.result_json`,
    [idempotencyKey, supplierId, result?.supplierOrderId || null, result?.status || 'UNKNOWN', j(request), j(result)]);
}
