import { config } from '../config.js';
import { registerWebhooks, listWebhooks } from '../shopify.js';
if (!config.appUrl) { console.error('Set APP_URL first'); process.exit(1); }
console.table(await registerWebhooks(config.appUrl));
console.table(await listWebhooks());
