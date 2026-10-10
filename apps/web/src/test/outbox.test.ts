// @vitest-environment node
import 'fake-indexeddb/auto';
import {
  type AttendanceSubmission,
  type AttendanceSyncResult,
  attendanceSubmissionSchema,
  MAX_SUBMISSIONS_PER_SYNC,
  newId,
} from '@maktab/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as ob from '@/offline/outbox';

/**
 * Experiment 6's scenarios (PLAN §12), ported from a live `wrangler dev` server to an in-process
 * fake with the same contract: per submission `applied | replaced | duplicate | rejected` (+ `stale`
 * when the pointer must not move), registers kept as history, and a current pointer per
 * (group, date, subject) that moves only forward in client `taken_at` (PLAN §5.1).
 */

type Register = {
  id: string;
  sub: AttendanceSubmission;
  takenBy: string;
  arrival: number;
};

function fakeServer() {
  const registers = new Map<string, Register>(); // by client_id
  const current = new Map<string, { registerId: string; clientId: string; takenAt: string }>();
  let arrival = 0;
  const state = {
    registers,
    current,
    requests: 0,
    /** Forces every request to this status (401/403/408/429/5xx) when set. */
    forceStatus: null as number | null,
    retryAfter: null as string | null,
  };

  const keyOf = (s: AttendanceSubmission) => `${s.grp_id}|${s.date}|${s.grp_subject_id ?? ''}`;

  function apply(raw: unknown, takenBy: string): AttendanceSyncResult {
    const parsed = attendanceSubmissionSchema.safeParse(raw);
    const clientId = (raw as { client_id?: unknown })?.client_id;
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        client_id: typeof clientId === 'string' ? clientId : null,
        status: 'rejected',
        error: `${issue?.path.join('.')}: ${issue?.message}`,
      };
    }
    const s = parsed.data;
    const seen = registers.get(s.client_id);
    if (seen) return { client_id: s.client_id, status: 'duplicate', register_id: seen.id };
    const reg: Register = { id: newId(), sub: s, takenBy, arrival: arrival++ };
    registers.set(s.client_id, reg);
    const k = keyOf(s);
    const cur = current.get(k);
    if (cur && !(s.taken_at > cur.takenAt)) {
      return { client_id: s.client_id, status: 'stale', register_id: reg.id };
    }
    current.set(k, { registerId: reg.id, clientId: s.client_id, takenAt: s.taken_at });
    return { client_id: s.client_id, status: cur ? 'replaced' : 'applied', register_id: reg.id };
  }

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

  const fetchAs =
    (takenBy: string) =>
    async (_url: string, init: RequestInit): Promise<Response> => {
      state.requests++;
      if (state.forceStatus) {
        return json(
          { error: { code: 'x', message: `forced ${state.forceStatus}` } },
          state.forceStatus,
          state.retryAfter ? { 'retry-after': state.retryAfter } : {},
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(String(init.body));
      } catch {
        return json({ error: { code: 'bad_json', message: 'invalid JSON' } }, 400);
      }
      if (!Array.isArray(body) || body.length > MAX_SUBMISSIONS_PER_SYNC) {
        return json({ error: { code: 'bad_request', message: 'array of <= 50' } }, 400);
      }
      return json({ results: body.map((s) => apply(s, takenBy)) });
    };

  const currentFor = (grp: string, date: string) => {
    const c = current.get(`${grp}|${date}|`);
    return c ? { ...c, register: registers.get(c.clientId) } : undefined;
  };

  return { state, fetch: fetchAs('teacher1'), fetchAs, currentFor };
}

/** Deterministic PRNG so the chaos run is reproducible. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const students = Array.from({ length: 60 }, () => newId());
const groups = Array.from({ length: 10 }, () => newId());
let clock = Date.parse('2026-10-01T08:00:00Z');
const sub = (
  grp: string,
  date: string,
  n = 3,
  status: 'P' | 'A' | 'L' | 'E' = 'A',
  over: Partial<AttendanceSubmission> = {},
): AttendanceSubmission => {
  clock += 1000;
  return {
    client_id: newId(),
    grp_id: grp,
    date,
    taken_at: new Date(clock).toISOString(),
    marks: students
      .slice(0, n)
      .map((student_id, i) => ({ student_id, status: i % 2 ? status : 'P', note: i ? null : 'n' })),
    ...over,
  };
};

const offline = async (): Promise<Response> => {
  throw new TypeError('Failed to fetch');
};

let n = 0;
let server: ReturnType<typeof fakeServer>;
beforeEach(() => {
  ob._close();
  ob.configure({
    dbName: `outbox-${n++}`,
    url: '/api/attendance/sync',
    now: () => Date.now(),
    chunk: 25,
  });
  server = fakeServer();
});
afterEach(() => ob._close());

describe('outbox (experiment 6 scenarios)', () => {
  it('1. enqueue offline, then sync when back', async () => {
    const s = sub(groups[0] ?? '', '2026-10-01');
    await ob.enqueue(s);
    const r1 = await ob.sync(offline);
    expect(r1.offline).toBe(true);
    expect(await ob.pending()).toBe(1);
    ob.configure({ now: () => Date.now() + 5000 }); // past the backoff
    const r2 = await ob.sync(server.fetch);
    expect(r2.acked).toBe(1);
    expect(await ob.pending()).toBe(0);
    expect(server.currentFor(s.grp_id, s.date)?.clientId).toBe(s.client_id);
  });

  it('2. double-tap: same client_id twice -> one entry, one server register', async () => {
    const s = sub(groups[1] ?? '', '2026-10-01');
    const a = await Promise.all([ob.enqueue(s), ob.enqueue(structuredClone(s))]);
    expect(a.filter((x) => x.queued).length).toBe(1);
    expect(await ob.pending()).toBe(1);
    await ob.sync(server.fetch);
    expect(server.state.registers.size).toBe(1);
  });

  it('3. app closed mid-sync (response lost): entry survives, re-send => duplicate', async () => {
    const s = sub(groups[2] ?? '', '2026-10-01');
    await ob.enqueue(s);
    const lost = async (u: string, o: RequestInit) => {
      await server.fetch(u, o);
      throw new Error('app killed');
    };
    await ob.sync(lost);
    ob._close(); // process restart: reopen from disk
    expect(await ob.pending()).toBe(1);
    ob.configure({ now: () => Date.now() + 5000 });
    const seen: string[] = [];
    const spy = async (u: string, o: RequestInit) => {
      const r = await server.fetch(u, o);
      const body = (await r.clone().json()) as { results: AttendanceSyncResult[] };
      seen.push(...body.results.map((x) => x.status));
      return r;
    };
    await ob.sync(spy);
    expect(seen).toEqual(['duplicate']);
    expect(await ob.pending()).toBe(0);
    expect(server.state.current.size).toBe(1);
  });

  it('4. server 5xx: stays queued with exponential backoff capped at 60 s', async () => {
    await ob.enqueue(sub(groups[3] ?? '', '2026-10-01'));
    server.state.forceStatus = 503;
    const t = 1_000_000;
    ob.configure({ now: () => t });
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      const r = await ob.sync(server.fetch, { force: true });
      delays.push((r.nextAt ?? 0) - t);
    }
    expect(await ob.pending()).toBe(1);
    expect(await ob.failed()).toEqual([]);
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    const before = server.state.requests;
    await ob.sync(server.fetch); // not due yet => no request
    expect(server.state.requests).toBe(before);
  });

  it('5. per-entry rejection and whole-request 4xx: moved to failed, not retried', async () => {
    const g = groups[4] ?? '';
    const bad = sub(g, '2026-10-01', 2, 'P', { date: 'not-a-date' });
    await ob.enqueue(bad);
    await ob.enqueue(sub(g, '2026-10-02'));
    const r = await ob.sync(server.fetch);
    expect(r).toMatchObject({ failed: 1, acked: 1 });
    expect(await ob.pending()).toBe(0);
    const f = await ob.failed();
    expect(f.length).toBe(1);
    expect(f[0]?.error).toMatch(/date/);
    const before = server.state.requests;
    await ob.sync(server.fetch, { force: true });
    expect(server.state.requests).toBe(before);
    // A whole-request 400/413/422 also -> failed.
    for (const status of [400, 413, 422]) {
      await ob.enqueue(sub(g, `2026-10-1${status % 10}`));
      server.state.forceStatus = status;
      await ob.sync(server.fetch);
    }
    expect((await ob.failed()).length).toBe(4);
    expect(await ob.pending()).toBe(0);
  });

  it('6. re-sending the same submission is harmless (duplicate) and keeps the pointer', async () => {
    const s = sub(groups[5] ?? '', '2026-10-01');
    const post = async (b: unknown) =>
      (
        (await (await server.fetch('/', { method: 'POST', body: JSON.stringify(b) })).json()) as {
          results: AttendanceSyncResult[];
        }
      ).results;
    const a = await post([s]);
    const b = await post([s]);
    const c = await post([s, s]);
    expect(a[0]?.status).toBe('applied');
    expect(b[0]?.status).toBe('duplicate');
    expect(c.map((x) => x.status)).toEqual(['duplicate', 'duplicate']);
    expect(a[0]?.register_id).toBe(b[0]?.register_id);
  });

  it('7. a later correction replaces the pointer, history kept; stale resend stays duplicate', async () => {
    const g = groups[6] ?? '';
    const t1 = sub(g, '2026-10-01', 4, 'A');
    const t2 = sub(g, '2026-10-01', 4, 'L');
    const post = async (as: string, b: unknown) =>
      (
        (await (
          await server.fetchAs(as)('/', { method: 'POST', body: JSON.stringify(b) })
        ).json()) as { results: AttendanceSyncResult[] }
      ).results[0]?.status;
    expect(await post('teacher1', [t1])).toBe('applied');
    expect(await post('office', [t2])).toBe('replaced');
    expect(await post('teacher1', [t1])).toBe('duplicate');
    const cur = server.currentFor(g, '2026-10-01');
    expect(cur?.clientId).toBe(t2.client_id);
    expect(cur?.register?.takenBy).toBe('office');
    expect(cur?.register?.sub.marks.map((m) => m.status)).toEqual(['P', 'L', 'P', 'L']);
    expect(server.state.registers.get(t1.client_id)?.sub.marks.length).toBe(4); // history kept
    // An older register arriving late never moves the pointer back.
    const old = sub(g, '2026-10-01', 4, 'E', { taken_at: '2026-01-01T00:00:00.000Z' });
    expect(await post('teacher1', [old])).toBe('stale');
    expect(server.currentFor(g, '2026-10-01')?.clientId).toBe(t2.client_id);
  });

  it('8. 40 marks in one submission', async () => {
    const s = sub(groups[7] ?? '', '2026-10-01', 40);
    await ob.enqueue(s);
    expect((await ob.sync(server.fetch)).acked).toBe(1);
    expect(server.currentFor(s.grp_id, s.date)?.register?.sub.marks.length).toBe(40);
  });

  it('9. 401/403 pause sync (sign in again) and keep every entry; resume() continues', async () => {
    const g = groups[8] ?? '';
    await ob.enqueue(sub(g, '2026-10-01'));
    await ob.enqueue(sub(g, '2026-10-02'));
    for (const status of [401, 403]) {
      server.state.forceStatus = status;
      const r = await ob.sync(server.fetch, { force: true });
      expect(r.paused).toMatchObject({ status });
      expect(r.nextAt).toBeNull();
      expect(await ob.pending()).toBe(2);
      expect(await ob.failed()).toEqual([]);
      expect(await ob.authPaused()).toMatchObject({ status });
      // While paused nothing is sent, even forced, and the pause survives a reload.
      ob._close();
      const before = server.state.requests;
      expect((await ob.sync(server.fetch, { force: true })).paused).toMatchObject({ status });
      expect(server.state.requests).toBe(before);
      await ob.resume();
    }
    server.state.forceStatus = null;
    const r = await ob.sync(server.fetch);
    expect(r).toMatchObject({ acked: 2, paused: null });
    expect(await ob.pending()).toBe(0);
  });

  it('10. 408 / 429 / 5xx / network retry with backoff; Retry-After is honoured', async () => {
    const g = groups[9] ?? '';
    await ob.enqueue(sub(g, '2026-10-01'));
    const t = 5_000_000;
    ob.configure({ now: () => t });
    for (const status of [408, 429, 500, 502, 503, 504]) {
      server.state.forceStatus = status;
      const r = await ob.sync(server.fetch, { force: true });
      expect(r.retried, `HTTP ${status}`).toBe(1);
      expect(await ob.failed()).toEqual([]);
    }
    server.state.forceStatus = 429;
    server.state.retryAfter = '120';
    const r = await ob.sync(server.fetch, { force: true });
    expect((r.nextAt ?? 0) - t).toBe(120_000); // longer than the 60 s cap
    server.state.forceStatus = null;
    server.state.retryAfter = null;
    ob.configure({ now: () => t + 120_000 });
    expect((await ob.sync(server.fetch)).acked).toBe(1);
  });
});

describe('outbox chaos run', () => {
  it('50 subs, 15% dropped before server, 15% response lost, 10% duplicated -> 1 current/key, last wins', async () => {
    ob.configure({ chunk: 1 });
    const rand = mulberry32(6);
    const keys: [string, string][] = [
      [groups[0] ?? '', '2026-11-01'],
      [groups[0] ?? '', '2026-11-02'],
      [groups[1] ?? '', '2026-11-01'],
      [groups[2] ?? '', '2026-11-01'],
      [groups[3] ?? '', '2026-11-05'],
    ];
    const subs: AttendanceSubmission[] = [];
    for (let i = 0; i < 50; i++) {
      const [g, d] = keys[i % keys.length] ?? ['', ''];
      subs.push(sub(g, d, 5 + (i % 4), (['A', 'E', 'L'] as const)[i % 3]));
    }
    for (const s of subs) await ob.enqueue(s);
    expect(await ob.pending()).toBe(50);

    const firstSeen = new Map<string, number>();
    let order = 0;
    const tally = { dropped: 0, lost: 0, dup: 0 };
    const chaos = async (u: string, o: RequestInit): Promise<Response> => {
      const x = rand();
      if (x < 0.15) {
        tally.dropped++;
        throw new TypeError('dropped before server');
      }
      const resp = await server.fetch(u, o);
      for (const s of JSON.parse(String(o.body)) as AttendanceSubmission[])
        if (!firstSeen.has(s.client_id)) firstSeen.set(s.client_id, order++);
      if (x < 0.3) {
        tally.lost++;
        throw new TypeError('response dropped');
      }
      if (x < 0.4) {
        tally.dup++;
        await server.fetch(u, o);
      }
      return resp;
    };
    let t = Date.now();
    ob.configure({ now: () => t });
    const r = await ob.syncUntilDone(chaos, {
      sleep: async (ms) => {
        t += ms;
      },
      maxPasses: 500,
    });
    expect(r?.nextAt).toBeNull();
    expect(await ob.pending()).toBe(0);
    expect(await ob.failed()).toEqual([]);
    expect(tally.dropped + tally.lost).toBeGreaterThan(0);
    expect(server.state.registers.size).toBe(50); // every submission landed exactly once

    for (const [g, d] of keys) {
      const mine = subs.filter((s) => s.grp_id === g && s.date === d);
      const last = mine.at(-1);
      // Per-key ordering held: the server first saw them in enqueue order.
      const arrival = mine.map((s) => firstSeen.get(s.client_id) ?? -1);
      expect(arrival).toEqual([...arrival].sort((a, b) => a - b));
      const cur = server.currentFor(g, d);
      expect(cur?.clientId, `winner for ${g}/${d}`).toBe(last?.client_id);
      expect(cur?.register?.sub.marks).toEqual(last?.marks);
    }
  });
});
