/**
 * Milestone 6 definition of done, over HTTP against `wrangler dev --local`: "Download everything"
 * as the browser does it (job → every part of every table → formula-safe CSVs → ZIP) with one CSV
 * per table plus schema.sql and README.txt, and no session / access-log data in it; the alarms
 * endpoint shape (and 401 without a session); the recycle bin round trip (subject and empty group:
 * remove → listed → restore → back in the pickers); backup-run reporting (token only); retention.
 *
 *   npm run db:migrate:local && npm run dev -w @maktab/api -- --var BACKUP_REPORT_TOKEN:<32+ chars>
 *   SMOKE_REPORT_TOKEN=<same> npm run smoke:m6 -w @maktab/api
 *
 * Without SMOKE_REPORT_TOKEN the reporting step only checks that a request without the token is
 * refused. Self-contained (random suffix); leaves the retention setting as it found it.
 */
import {
  type AlarmsDto,
  type BackupStatusDto,
  EXPORT_EXCLUDED_TABLES,
  type ExportJobDto,
  type ExportPartDto,
  type GroupDto,
  type ProgrammeDto,
  type RecycleBinDto,
  type RetentionDto,
  type SchoolResponse,
  type SubjectDto,
  toCsvLine,
} from '@maktab/shared';
import { unzipSync, zipSync } from 'fflate';
import { mintDevSession } from './dev-session';
import {
  always,
  BASE,
  EMAIL,
  expectOk,
  finish,
  makeApi,
  ORIGIN,
  runId as run,
  step,
} from './smoke-lib';

let ownerCookie = '';
const api = makeApi(() => ownerCookie);
const enc = (s: string) => new Uint8Array(new TextEncoder().encode(s));
const REPORT_TOKEN = process.env.SMOKE_REPORT_TOKEN ?? '';

async function main() {
  let retention: RetentionDto | null = null;
  let tables: string[] = [];

  await step('API reachable', async () => {
    const r = await api<{ status: string }>('GET', '/api/health');
    expectOk(r.status === 200, r);
  });

  await step(`owner session for ${EMAIL}; a school exists`, async () => {
    ownerCookie = (await mintDevSession(EMAIL)).cookie;
    const s = await api<SchoolResponse>('GET', '/api/school');
    if (!s.body.school)
      await api('PUT', '/api/school', { name: 'Smoke Test School', mode: 'both' });
    await api('POST', '/api/programmes/seed-pk');
  });

  await step(
    'download everything: every part of every table → ZIP, one CSV per table',
    async () => {
      const start = await api<ExportJobDto>('POST', '/api/backup/export');
      expectOk(start.status === 201, start);
      const job = start.body;
      tables = job.tables;
      for (const t of EXPORT_EXCLUDED_TABLES) expectOk(!tables.includes(t), `${t} exported`);
      const files: Record<string, Uint8Array> = {};
      let rows = 0;
      let requests = 0;
      for (const table of tables) {
        const lines: string[] = [];
        let after = 0;
        for (;;) {
          const r = await api<ExportPartDto>(
            'GET',
            `/api/backup/export/${job.id}/part?table=${encodeURIComponent(table)}&after=${after}`,
          );
          requests++;
          expectOk(
            r.status === 200 && r.body.rows.length <= 200,
            `${table}: ${r.text.slice(0, 200)}`,
          );
          if (table === 'parent_link')
            expectOk(!r.body.columns.includes('token_salt'), 'token_salt');
          if (!lines.length) lines.push(toCsvLine(r.body.columns));
          for (const row of r.body.rows) lines.push(toCsvLine(row));
          rows += r.body.rows.length;
          if (r.body.next === null) break;
          after = r.body.next;
        }
        files[`tables/${table}.csv`] = enc(`${lines.join('\r\n')}\r\n`);
      }
      files['schema.sql'] = enc(job.schema);
      files['README.txt'] = enc('smoke');
      const zip = zipSync(files, { level: 6 });
      const back = Object.keys(unzipSync(zip));
      const csvs = back.filter((f) => f.startsWith('tables/') && f.endsWith('.csv'));
      expectOk(csvs.length === tables.length, { csvs: csvs.length, tables: tables.length });
      expectOk(back.length === tables.length + 2, back.length);
      const fin = await api('POST', `/api/backup/export/${job.id}/finish`, {
        rows,
        files: back.length,
      });
      expectOk(fin.status === 200, fin);
      const again = await api('GET', `/api/backup/export/${job.id}/part?table=${tables[0]}`);
      expectOk(again.status === 409, again);
      return `${tables.length} tables, ${rows} rows, ${requests} requests, ${zip.length} bytes zipped`;
    },
  );

  await step('alarms: shape, latest pass, 401 without a session', async () => {
    const r = await api<AlarmsDto>('GET', '/api/alarms');
    expectOk(r.status === 200, r);
    const kinds = r.body.alarms.map((a) => a.kind).join(',');
    expectOk(
      kinds ===
        'ledger_consistency,messages_stuck,messages_failed,gate_lockouts,billing_attention,backup_stale',
      kinds,
    );
    expectOk(
      r.body.alarms.every((a) => Number.isInteger(a.count) && Array.isArray(a.sample)),
      r.body,
    );
    expectOk(r.body.alarms.find((a) => a.kind === 'ledger_consistency')?.count === 0, r.body);
    const latest = await api<{ event: unknown }>('GET', '/api/alarms/latest');
    expectOk(latest.status === 200 && 'event' in latest.body, latest);
    const anon = await fetch(`${BASE}/api/alarms`);
    expectOk(anon.status === 401, anon.status);
    return `${r.body.total} firing`;
  });

  await step('recycle bin: subject delete → listed → restore → back', async () => {
    const name = `Smoke M6 ${run}`;
    const s = await api<SubjectDto>('POST', '/api/subjects', { name });
    expectOk(s.status === 201, s);
    expectOk((await api('DELETE', `/api/subjects/${s.body.id}`)).status === 200, 'delete');
    const bin = await api<RecycleBinDto>('GET', '/api/recycle-bin');
    expectOk(
      bin.body.items.some((i) => i.kind === 'subject' && i.id === s.body.id),
      bin.body,
    );
    const r = await api('POST', '/api/recycle-bin/restore', { kind: 'subject', id: s.body.id });
    expectOk(r.status === 200, r);
    const live = await api<{ items: SubjectDto[] }>('GET', '/api/subjects');
    expectOk(
      live.body.items.some((x) => x.id === s.body.id),
      'restored subject missing',
    );
    // Clean up after ourselves: back to the bin (soft delete; nothing is ever erased).
    await api('DELETE', `/api/subjects/${s.body.id}`);
  });

  await step('recycle bin: empty group archive → hidden → restore', async () => {
    const progs = await api<{ items: ProgrammeDto[] }>('GET', '/api/programmes');
    const c5 = progs.body.items.find((p) => p.name === 'Class 5');
    expectOk(c5, 'Class 5 missing');
    const g = await api<GroupDto>('POST', '/api/groups', {
      programme_id: c5?.id,
      name: `M6-${run}`,
    });
    expectOk(g.status === 201, g);
    expectOk((await api('POST', `/api/groups/${g.body.id}/archive`)).status === 200, 'archive');
    const list = await api<{ items: GroupDto[] }>('GET', '/api/groups');
    expectOk(!list.body.items.some((x) => x.id === g.body.id), 'archived group still listed');
    const r = await api('POST', '/api/recycle-bin/restore', { kind: 'group', id: g.body.id });
    expectOk(r.status === 200, r);
    const after = await api<{ items: GroupDto[] }>('GET', '/api/groups');
    expectOk(
      after.body.items.some((x) => x.id === g.body.id),
      'restored group missing',
    );
    await api('POST', `/api/groups/${g.body.id}/archive`);
  });

  await step('retention setting round trip', async () => {
    retention = (await api<RetentionDto>('GET', '/api/settings/retention')).body;
    const r = await api<RetentionDto>('PUT', '/api/settings/retention', { access_log_days: 45 });
    expectOk(r.status === 200 && r.body.access_log_days === 45, r);
  });

  await step('backup run report: token only, then visible on the status page', async () => {
    const body = {
      kind: 'nightly',
      status: 'ok',
      bytes: 1234,
      targets: [{ name: 'r2', ok: true }],
    };
    const noToken = await fetch(`${BASE}/api/backup/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: ownerCookie },
      body: JSON.stringify(body),
    });
    expectOk([401, 503].includes(noToken.status), noToken.status);
    if (!REPORT_TOKEN) return 'SMOKE_REPORT_TOKEN unset: refusal checked only';
    const ok = await fetch(`${BASE}/api/backup/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${REPORT_TOKEN}` },
      body: JSON.stringify({ ...body, note: `smoke ${run}` }),
    });
    expectOk(ok.status === 201, ok.status);
    const s = await api<BackupStatusDto>('GET', '/api/backup/status');
    expectOk(s.body.last_nightly?.note === `smoke ${run}`, s.body.last_nightly);
    expectOk(s.body.report_configured, 'report_configured');
    return `objects: ${s.body.objects === null ? 'no binding' : s.body.objects.length}`;
  });

  await always('cleanup: restore retention', async () => {
    if (retention) await api('PUT', '/api/settings/retention', retention);
  });
  finish();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
