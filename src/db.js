import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

let db;

export function getDb() {
  if (db) return db;
  const file = path.resolve(process.cwd(), config.databasePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,                 -- aliexpress | alibaba | manual
    source_url TEXT NOT NULL,
    source_product_id TEXT,
    title TEXT NOT NULL,
    description_html TEXT DEFAULT '',
    images_json TEXT DEFAULT '[]',          -- ["https://..."]
    variants_json TEXT DEFAULT '[]',        -- [{sku, title, options:{Color:"Red"}, supplierPrice, supplierCurrency, supplierShipping, sellingPriceXaf, shopifyVariantId, skuAttr}]
    conditions_json TEXT DEFAULT '{}',      -- {moq, leadTimeDays, shippingMethod, paymentTerms, weightKg, notes}
    pricing_json TEXT DEFAULT '{}',         -- snapshot of the pricing rule inputs used
    shopify_product_id TEXT,
    shopify_handle TEXT,
    status TEXT NOT NULL DEFAULT 'draft',   -- draft | published | archived | error
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_products_shopify ON products(shopify_product_id);

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shopify_order_id TEXT NOT NULL UNIQUE,
    order_number TEXT,
    customer_json TEXT DEFAULT '{}',
    shipping_address_json TEXT DEFAULT '{}',
    currency TEXT,
    total_price REAL,
    financial_status TEXT,
    raw_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id),
    shopify_line_item_id TEXT,
    shopify_variant_id TEXT,
    sku TEXT,
    title TEXT,
    quantity INTEGER NOT NULL,
    sold_unit_price REAL,                   -- what the customer paid per unit (shop currency)
    supplier_url TEXT,
    supplier_sku_attr TEXT,
    supplier_unit_cost REAL,                -- supplier price per unit in supplier currency
    supplier_shipping REAL DEFAULT 0,       -- supplier shipping for this line in supplier currency
    supplier_currency TEXT,
    supplier_total_xaf REAL,                -- what you must pay the supplier, converted to XAF
    status TEXT NOT NULL DEFAULT 'pending', -- pending | ordered | shipped | delivered | cancelled
    supplier_order_ref TEXT,
    supplier_paid_at TEXT,
    tracking_number TEXT,
    tracking_company TEXT,
    tracking_url TEXT,
    shopify_fulfillment_id TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL DEFAULT 'info',
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    data_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS webhook_receipts (
    webhook_id TEXT PRIMARY KEY,
    received_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `);
}

// ---------- helpers ----------
export const j = (v) => JSON.stringify(v ?? null);
export const pj = (s, fallback) => {
  if (s === null || s === undefined || s === '') return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

export function logEvent(type, message, data = null, level = 'info') {
  try {
    getDb().prepare('INSERT INTO events (level, type, message, data_json) VALUES (?, ?, ?, ?)')
      .run(level, type, message, data ? j(data) : null);
  } catch (e) {
    console.error('logEvent failed', e);
  }
  const line = `[${level}] ${type}: ${message}`;
  if (level === 'error') console.error(line); else console.log(line);
}

// ---------- settings ----------
export function getSetting(key, fallback = undefined) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? pj(row.value, fallback) : fallback;
}
export function setSetting(key, value) {
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, j(value));
}

// ---------- products ----------
export function rowToProduct(row) {
  if (!row) return null;
  return {
    ...row,
    images: pj(row.images_json, []),
    variants: pj(row.variants_json, []),
    conditions: pj(row.conditions_json, {}),
    pricing: pj(row.pricing_json, {}),
  };
}
export function insertProduct(p) {
  const res = getDb().prepare(`INSERT INTO products
    (provider, source_url, source_product_id, title, description_html, images_json, variants_json, conditions_json, pricing_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    p.provider, p.source_url, p.source_product_id ?? null, p.title, p.description_html ?? '',
    j(p.images ?? []), j(p.variants ?? []), j(p.conditions ?? {}), j(p.pricing ?? {}), p.status ?? 'draft');
  return Number(res.lastInsertRowid);
}
export function updateProduct(id, fields) {
  const map = {
    title: 'title', description_html: 'description_html', status: 'status', last_error: 'last_error',
    shopify_product_id: 'shopify_product_id', shopify_handle: 'shopify_handle', source_url: 'source_url',
    images: 'images_json', variants: 'variants_json', conditions: 'conditions_json', pricing: 'pricing_json',
  };
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!(k in map)) continue;
    sets.push(`${map[k]} = ?`);
    vals.push(map[k].endsWith('_json') ? j(v) : v);
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  getDb().prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}
export function getProduct(id) {
  return rowToProduct(getDb().prepare('SELECT * FROM products WHERE id = ?').get(id));
}
export function getProductByShopifyId(shopifyProductId) {
  return rowToProduct(getDb().prepare('SELECT * FROM products WHERE shopify_product_id = ?').get(String(shopifyProductId)));
}
export function listProducts({ status } = {}) {
  const rows = status
    ? getDb().prepare('SELECT * FROM products WHERE status = ? ORDER BY id DESC').all(status)
    : getDb().prepare('SELECT * FROM products ORDER BY id DESC').all();
  return rows.map(rowToProduct);
}
export function deleteProduct(id) {
  getDb().prepare('DELETE FROM products WHERE id = ?').run(id);
}

// ---------- orders / purchase orders ----------
export function rowToOrder(row) {
  if (!row) return null;
  return { ...row, customer: pj(row.customer_json, {}), shipping_address: pj(row.shipping_address_json, {}), raw: pj(row.raw_json, null) };
}
export function getOrderByShopifyId(shopifyOrderId) {
  return rowToOrder(getDb().prepare('SELECT * FROM orders WHERE shopify_order_id = ?').get(String(shopifyOrderId)));
}
export function getOrder(id) {
  return rowToOrder(getDb().prepare('SELECT * FROM orders WHERE id = ?').get(id));
}
export function insertOrder(o) {
  const res = getDb().prepare(`INSERT INTO orders
    (shopify_order_id, order_number, customer_json, shipping_address_json, currency, total_price, financial_status, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    String(o.shopify_order_id), o.order_number ?? null, j(o.customer ?? {}), j(o.shipping_address ?? {}),
    o.currency ?? null, o.total_price ?? null, o.financial_status ?? null, j(o.raw ?? null));
  return Number(res.lastInsertRowid);
}
export function listOrders() {
  return getDb().prepare(`SELECT o.*,
      (SELECT COUNT(*) FROM purchase_orders p WHERE p.order_id = o.id) AS po_count,
      (SELECT COUNT(*) FROM purchase_orders p WHERE p.order_id = o.id AND p.status = 'pending') AS po_pending
    FROM orders o ORDER BY o.id DESC`).all().map(rowToOrder);
}
export function insertPurchaseOrder(po) {
  const res = getDb().prepare(`INSERT INTO purchase_orders
    (order_id, product_id, shopify_line_item_id, shopify_variant_id, sku, title, quantity, sold_unit_price,
     supplier_url, supplier_sku_attr, supplier_unit_cost, supplier_shipping, supplier_currency, supplier_total_xaf, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    po.order_id, po.product_id ?? null, po.shopify_line_item_id ?? null, po.shopify_variant_id ?? null, po.sku ?? null,
    po.title ?? null, po.quantity, po.sold_unit_price ?? null, po.supplier_url ?? null, po.supplier_sku_attr ?? null,
    po.supplier_unit_cost ?? null, po.supplier_shipping ?? 0, po.supplier_currency ?? null, po.supplier_total_xaf ?? null,
    po.status ?? 'pending', po.notes ?? null);
  return Number(res.lastInsertRowid);
}
export function updatePurchaseOrder(id, fields) {
  const allowed = ['status', 'supplier_order_ref', 'supplier_paid_at', 'tracking_number', 'tracking_company', 'tracking_url',
    'shopify_fulfillment_id', 'notes', 'supplier_unit_cost', 'supplier_shipping', 'supplier_currency', 'supplier_total_xaf'];
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`); vals.push(v);
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  getDb().prepare(`UPDATE purchase_orders SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}
export function getPurchaseOrder(id) {
  return getDb().prepare(`SELECT p.*, o.shopify_order_id, o.order_number, o.shipping_address_json, o.customer_json
    FROM purchase_orders p JOIN orders o ON o.id = p.order_id WHERE p.id = ?`).get(id);
}
export function listPurchaseOrders({ status, orderId } = {}) {
  let sql = `SELECT p.*, o.order_number, o.shopify_order_id FROM purchase_orders p JOIN orders o ON o.id = p.order_id`;
  const where = [], vals = [];
  if (status) { where.push('p.status = ?'); vals.push(status); }
  if (orderId) { where.push('p.order_id = ?'); vals.push(orderId); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY p.id DESC';
  return getDb().prepare(sql).all(...vals);
}
export function dashboardStats() {
  const d = getDb();
  const one = (sql, ...a) => Object.values(d.prepare(sql).get(...a))[0];
  return {
    products: one('SELECT COUNT(*) FROM products'),
    published: one("SELECT COUNT(*) FROM products WHERE status = 'published'"),
    orders: one('SELECT COUNT(*) FROM orders'),
    poPending: one("SELECT COUNT(*) FROM purchase_orders WHERE status = 'pending'"),
    poOrdered: one("SELECT COUNT(*) FROM purchase_orders WHERE status = 'ordered'"),
    owedToSuppliersXaf: one("SELECT COALESCE(SUM(supplier_total_xaf),0) FROM purchase_orders WHERE status IN ('pending') AND supplier_paid_at IS NULL"),
    revenue: one('SELECT COALESCE(SUM(total_price),0) FROM orders'),
  };
}
export function recentEvents(limit = 30) {
  return getDb().prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
}
export function webhookSeen(id) {
  if (!id) return false;
  const d = getDb();
  if (d.prepare('SELECT 1 FROM webhook_receipts WHERE webhook_id = ?').get(id)) return true;
  d.prepare('INSERT INTO webhook_receipts (webhook_id) VALUES (?)').run(id);
  return false;
}
