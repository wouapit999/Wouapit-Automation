import { getDb } from '../db.js';
import { refreshAllPublished } from '../sync.js';
getDb();
const results = await refreshAllPublished();
for (const r of results) console.log(r.error ? `✗ ${r.title}: ${r.error}` : `${r.priceMoved ? '↻' : '='} ${r.title}: ${r.changed.length} supplier change(s)`);
