import { getDb } from '../db.js';
import { refreshAllPublished } from '../sync.js';
await getDb();
for (const r of await refreshAllPublished()) console.log(r.error ? `✗ ${r.title}: ${r.error}` : `${r.priceMoved ? '↻' : '='} ${r.title}: ${r.changed.length} supplier change(s)`);
