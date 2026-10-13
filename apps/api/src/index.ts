import { getDb, runDailyOps, runScheduled } from '@maktab/db';
import { createApp } from './app';
import type { Bindings } from './env';
import { configWarning } from './lib/config';
import { demoTick, isDemo } from './routes/demo';

// Static assets (the built web app) are served by the [assets] binding before this Worker runs;
// only /api/* reaches here (run_worker_first in wrangler.toml). Two variants: the demo routes are
// mounted only on a DEMO_MODE=1 Worker (env is per request, so the app is picked per request).
const deps = { getDb: (env: Bindings) => getDb({ DB: env.DB }) };
const apps = {
  normal: createApp(deps).app,
  demo: null as ReturnType<typeof createApp>['app'] | null,
};
const appFor = (env: Bindings) => {
  if (!isDemo(env)) return apps.normal;
  apps.demo ??= createApp({ ...deps, demo: true }).app;
  return apps.demo;
};

// Workers only see `env` inside a request, so "at start" means the isolate's first request.
let checked = false;

export default {
  fetch(request, env, ctx) {
    if (!checked) {
      checked = true;
      const warning = configWarning(env);
      if (warning) console.warn(warning);
    }
    return appFor(env).fetch(request, env, ctx);
  },
  /**
   * Workers cron (wrangler.toml [triggers]): monthly generation and late fines, a few chunks per
   * invocation, resumable (PLAN §8, §14.5); then the daily alarm/retention pass (M6). Locally: `wrangler dev --test-scheduled`, then
   * GET /__scheduled.
   */
  scheduled(_controller, env, ctx) {
    const db = getDb({ DB: env.DB });
    ctx.waitUntil(
      (async () => {
        // Demo (docs/demo.md): a running reset owns the tick; billing and the daily pass wait.
        if (isDemo(env)) {
          const busy = await demoTick(db, env).catch((err: unknown) => {
            console.error('demo reset step failed', err);
            return true;
          });
          if (busy) return;
        }
        try {
          console.log(JSON.stringify({ cron: await runScheduled(db) }));
        } catch (err) {
          console.error('cron failed', err);
        }
        // M6 daily pass (alarms + retention): once per Karachi day from 03:00, after the 02:30
        // nightly export; one read on every other tick. A failure (e.g. D1 7500 while an export
        // still holds the database) is retried by the next tick.
        try {
          const daily = await runDailyOps(db);
          if (!('skipped' in daily)) console.log(JSON.stringify({ daily }));
        } catch (err) {
          console.error('daily pass failed', err);
        }
      })(),
    );
  },
} satisfies ExportedHandler<Bindings>;
