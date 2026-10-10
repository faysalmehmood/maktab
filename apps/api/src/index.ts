import { getDb, runScheduled } from '@maktab/db';
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
  /**
   * Workers cron (wrangler.toml [triggers]): monthly generation and late fines, a few chunks per
   * invocation, resumable (PLAN §8, §14.5). Locally: `wrangler dev --test-scheduled`, then
   * GET /__scheduled.
   */
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      runScheduled(getDb({ DB: env.DB })).then(
        (report) => console.log(JSON.stringify({ cron: report })),
        (err: unknown) => console.error('cron failed', err),
      ),
    );
  },
} satisfies ExportedHandler<Bindings>;
