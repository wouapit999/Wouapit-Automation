import { getDb } from '../db.js';
import { refreshAllPublished } from '../sync.js';
await getDb();
await (await import('../credentials.js')).applyCredentials();
for (const r of await refreshAllPublished()) console.log(r.error ? `✗ ${r.title}: ${r.error}` : `${r.priceMoved ? '↻' : '='} ${r.title}: ${r.changed.length} supplier change(s)`);
