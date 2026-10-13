import { getDb, runDailyOps, runScheduled } from '@maktab/db';
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
   * invocation, resumable (PLAN §8, §14.5); then the daily alarm/retention pass (M6). Locally: `wrangler dev --test-scheduled`, then
   * GET /__scheduled.
   */
  scheduled(_controller, env, ctx) {
    const db = getDb({ DB: env.DB });
    ctx.waitUntil(
      runScheduled(db)
        .then(
          (report) => console.log(JSON.stringify({ cron: report })),
          (err: unknown) => console.error('cron failed', err),
        )
        // M6 daily pass (alarms + retention): once per Karachi day from 03:00, after the 02:30
        // nightly export; one read on every other tick. A failure (e.g. D1 7500 while an export
        // still holds the database) is retried by the next tick.
        .then(() => runDailyOps(db))
        .then(
          (daily) => {
            if (!('skipped' in daily)) console.log(JSON.stringify({ daily }));
          },
          (err: unknown) => console.error('daily pass failed', err),
        ),
    );
  },
} satisfies ExportedHandler<Bindings>;
