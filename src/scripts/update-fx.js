import { getDb } from '../db.js';
import { refreshFxRates } from '../fx.js';
await getDb();
console.log(await refreshFxRates());
