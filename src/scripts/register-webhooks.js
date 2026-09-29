import { config } from '../config.js';
import { registerWebhooks, listWebhooks } from '../shopify.js';
if (!config.appUrl) { console.error('Set APP_URL in .env first'); process.exit(1); }
const r = await registerWebhooks(config.appUrl);
console.table(r);
console.table(await listWebhooks());
