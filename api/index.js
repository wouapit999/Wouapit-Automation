// Vercel serverless entry point: every request is rewritten here (see vercel.json) and handled by the Express app.
import { createApp } from '../src/server.js';

const app = createApp();
export default app;
