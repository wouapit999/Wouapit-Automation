import express from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';
import { getDb, logEvent } from './db.js';
import { handleShopifyWebhook } from './webhooks.js';
import { refreshAllPublished } from './sync.js';
import { router as dashboard } from './routes/dashboard.js';
import { router as products } from './routes/products.js';
import { router as orders } from './routes/orders.js';
import { router as settings } from './routes/settings.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // Shopify webhooks: raw body needed for HMAC verification, no auth (signature is the auth).
  app.post('/webhooks/shopify', express.raw({ type: '*/*', limit: '2mb' }), handleShopifyWebhook);
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Admin UI: HTTP Basic auth.
  app.use((req, res, next) => {
    if (!config.adminPassword) return res.status(500).send('Set ADMIN_PASSWORD in .env before using the admin UI.');
    const header = req.get('authorization') || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const [, pass = ''] = Buffer.from(encoded, 'base64').toString('utf8').split(/:(.*)/s);
      const a = Buffer.from(pass), b = Buffer.from(config.adminPassword);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="CM Dropship", charset="UTF-8"');
    res.status(401).send('Authentication required');
  });
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(dashboard);
  app.use(products);
  app.use(orders);
  app.use(settings);

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error(err);
    res.status(500).send(`<pre>${String(err.message || err).replace(/</g, '&lt;')}</pre>`);
  });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  getDb();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`CM Dropship admin: http://localhost:${config.port}  (user: admin, password: ADMIN_PASSWORD)`);
    if (!config.adminPassword) console.warn('WARNING: ADMIN_PASSWORD is not set; the UI will refuse requests.');
  });
  if (config.priceSyncIntervalHours > 0) {
    const ms = config.priceSyncIntervalHours * 3600 * 1000;
    setInterval(() => refreshAllPublished().then((r) => logEvent('price.sync', `Scheduled sync checked ${r.length} product(s)`)).catch((e) => logEvent('price.sync', e.message, null, 'error')), ms).unref();
    console.log(`Supplier price sync every ${config.priceSyncIntervalHours}h`);
  }
}
