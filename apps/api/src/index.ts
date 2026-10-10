import { getDb } from '@maktab/db';
import { createApp } from './app';

// Static assets (the built web app) are served by the [assets] binding before this Worker runs;
// only /api/* reaches here (run_worker_first in wrangler.toml).
const { app } = createApp({ getDb: (env) => getDb({ DB: env.DB }) });

export default app;
