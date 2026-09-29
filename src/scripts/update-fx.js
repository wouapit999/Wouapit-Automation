import { getDb } from '../db.js';
import { refreshFxRates } from '../fx.js';
getDb();
console.log(await refreshFxRates());
