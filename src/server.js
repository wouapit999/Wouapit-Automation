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

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // Make sure the schema exists before any request touches the database (serverless cold starts included).
  app.use(async (req, res, next) => { try { await getDb(); next(); } catch (e) { next(e); } });

  // Shopify webhooks: raw body needed for HMAC verification, no auth (signature is the auth).
  app.post('/webhooks/shopify', express.raw({ type: '*/*', limit: '2mb' }), handleShopifyWebhook);
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Scheduled supplier price sync (Vercel Cron sends "Authorization: Bearer <CRON_SECRET>").
  app.get('/cron/sync-prices', async (req, res) => {
    const auth = req.get('authorization') || '';
    if (!config.cronSecret || !safeEqual(auth, `Bearer ${config.cronSecret}`)) return res.status(401).send('unauthorized');
    const r = await refreshAllPublished();
    await logEvent('price.sync', `Scheduled sync checked ${r.length} product(s), ${r.filter((x) => x.priceMoved).length} updated`);
    res.json({ checked: r.length, updated: r.filter((x) => x.priceMoved).length, errors: r.filter((x) => x.error).length });
  });

  // Admin UI: HTTP Basic auth.
  app.use((req, res, next) => {
    if (!config.adminPassword) return res.status(500).send('Set ADMIN_PASSWORD before using the admin UI.');
    const header = req.get('authorization') || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const [, pass = ''] = Buffer.from(encoded, 'base64').toString('utf8').split(/:(.*)/s);
      if (safeEqual(pass, config.adminPassword)) return next();
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

// Long-running server (laptop, Docker, VPS, Fly.io). On Vercel, api/index.js imports createApp instead.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await getDb();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`CM Dropship admin: http://localhost:${config.port}  (user: admin, password: ADMIN_PASSWORD)`);
    console.log(`Database: ${config.database.url ? 'Postgres ' + config.database.url.replace(/\/\/.*@/, '//***@') : 'embedded PGlite at ' + config.database.path}`);
    if (!config.adminPassword) console.warn('WARNING: ADMIN_PASSWORD is not set; the UI will refuse requests.');
  });
  if (config.priceSyncIntervalHours > 0) {
    const ms = config.priceSyncIntervalHours * 3600 * 1000;
    setInterval(() => refreshAllPublished().then((r) => logEvent('price.sync', `Scheduled sync checked ${r.length} product(s)`)).catch((e) => logEvent('price.sync', e.message, null, 'error')), ms).unref();
    console.log(`Supplier price sync every ${config.priceSyncIntervalHours}h`);
  }
}
