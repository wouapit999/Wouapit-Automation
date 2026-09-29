import { getDb } from '../db.js';
import { refreshFxRates } from '../fx.js';
await getDb();
await (await import('../credentials.js')).applyCredentials();
console.log(await refreshFxRates());
