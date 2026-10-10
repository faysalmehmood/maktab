import { getDb } from '@maktab/db';
import { createApp } from './app';
import type { Bindings } from './env';
import { configWarning } from './lib/config';

// Static assets (the built web app) are served by the [assets] binding before this Worker runs;
// only /api/* reaches here (run_worker_first in wrangler.toml).
const { app } = createApp({ getDb: (env) => getDb({ DB: env.DB }) });

// Workers only see `env` inside a request, so "at start" means the isolate's first request.
let checked = false;

export default {
  fetch(request, env, ctx) {
    if (!checked) {
      checked = true;
      const warning = configWarning(env);
      if (warning) console.warn(warning);
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Bindings>;
