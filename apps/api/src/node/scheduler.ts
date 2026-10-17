import { type AppDb, runDailyOps, runScheduled } from '@maktab/db';
import { backupDueToday, karachiDay, nextBackupAt } from './backup';

/**
 * In-process stand-in for the Worker's cron (apps/api/src/index.ts `scheduled()`) on the self-hosted
 * server: every 30 minutes (and once 60 s after start) `runScheduled` then `runDailyOps`, exactly
 * the non-demo branch of the Worker; plus the nightly local backup at 02:30 Karachi.
 *
 * - One job at a time: every job runs through one queue, so a slow tick never overlaps the next
 *   tick or the backup (and a tick that is still running when the next is due is skipped, not
 *   stacked).
 * - Errors are logged, never thrown: a failed tick is retried by the next one, as on Workers.
 * - Missed backup: if the server was down at 02:30, the first tick after it notices that today's
 *   backup has not run yet and runs it (`hasBackupFor`), at most once a day per process.
 * - Timers are unref'd, so they never keep a stopping process alive; `stop()` clears them and waits
 *   for the running job.
 */

export type SchedulerDeps = {
  db: AppDb;
  backup: () => Promise<unknown>;
  /** true = a daily backup for this Karachi day already exists. */
  hasBackupFor: (day: string) => Promise<boolean>;
  now?: () => number;
  tickMs?: number;
  firstTickMs?: number;
  log?: (msg: string) => void;
};

export type Scheduler = {
  /** Runs one cron tick now (queued behind a running job). Resolves when it is done. */
  tick: () => Promise<void>;
  /** Runs the nightly backup now (queued), even if today's was attempted. */
  backupNow: () => Promise<void>;
  /** What the 02:30 timer runs: the backup, unless today's was already attempted. */
  timedBackup: () => Promise<void>;
  stop: () => Promise<void>;
  /** For tests: is a job running. */
  busy: () => boolean;
};

export function startScheduler(deps: SchedulerDeps, { autostart = true } = {}): Scheduler {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.log(m));
  const tickMs = deps.tickMs ?? 30 * 60_000;
  let chain: Promise<void> = Promise.resolve();
  let running = 0;
  let tickQueued = false;
  let stopped = false;
  /** Karachi day of the last backup attempt: the catch-up tries at most once a day (no retry storm). */
  let attemptedDay: string | null = null;
  const backup = async () => {
    attemptedDay = karachiDay(now());
    await deps.backup();
  };
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const enqueue = (name: string, job: () => Promise<void>): Promise<void> => {
    const run = async () => {
      if (stopped) return;
      running++;
      try {
        await job();
      } catch (err) {
        console.error(`[maktab] ${name} failed`, err);
      } finally {
        running--;
      }
    };
    chain = chain.then(run, run);
    return chain;
  };

  const cronTick = async () => {
    try {
      log(JSON.stringify({ cron: await runScheduled(deps.db, { now: now() }) }));
    } catch (err) {
      console.error('cron failed', err);
    }
    try {
      const daily = await runDailyOps(deps.db, { now: now() });
      if (!('skipped' in daily)) log(JSON.stringify({ daily }));
    } catch (err) {
      console.error('daily pass failed', err);
    }
    // Catch-up for a backup missed while the server was down (or the 02:30 timer was late).
    const today = karachiDay(now());
    if (backupDueToday(now()) && attemptedDay !== today && !(await deps.hasBackupFor(today)))
      await backup();
  };

  const tick = () => {
    // A tick already waiting in the queue covers this one: never stack ticks.
    if (tickQueued) return chain;
    tickQueued = true;
    return enqueue('scheduled tick', async () => {
      tickQueued = false;
      await cronTick();
    });
  };

  const backupNow = () =>
    enqueue('nightly backup', async () => {
      await backup();
    });

  /**
   * The 02:30 timer: skipped when today's backup was already attempted (the catch-up on a tick
   * just before 02:30 cannot have run it, but a restart around 02:30 or a manual run can).
   */
  const timedBackup = () =>
    enqueue('nightly backup', async () => {
      if (attemptedDay === karachiDay(now())) return;
      await backup();
    });

  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    t.unref?.();
    timers.add(t);
  };

  const scheduleBackup = () => {
    if (stopped) return;
    later(Math.max(1_000, nextBackupAt(now()) - now()), () => {
      void timedBackup().finally(scheduleBackup);
    });
  };

  if (autostart) {
    later(deps.firstTickMs ?? 60_000, () => void tick());
    const interval = setInterval(() => void tick(), tickMs);
    interval.unref?.();
    timers.add(interval);
    scheduleBackup();
  }

  return {
    tick,
    backupNow,
    timedBackup,
    busy: () => running > 0,
    stop: async () => {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      await chain;
    },
  };
}
