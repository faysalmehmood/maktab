import type {
  AlarmsDto,
  BackupStatusDto,
  ExportJobDto,
  ExportPartDto,
  RecycleBinDto,
} from '@maktab/shared';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { unzipSync } from 'fflate';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AlarmBanner } from '@/components/backup/AlarmBanner';
import { BackupPanel } from '@/components/backup/BackupPanel';
import { AboutPanel, RecycleBin } from '@/components/backup/DataPanel';
import { initI18n, setLanguage } from '@/i18n';
import { ApiError } from '@/lib/api';
import { buildExport, withRetry } from '@/lib/backup';
import { visibleSections } from '@/pages/Settings';
import { mockApi, renderAt } from './api-mock';

beforeAll(async () => {
  await initI18n('en');
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await act(() => setLanguage('en'));
});

const status: BackupStatusDto = {
  last_nightly: {
    id: 'B1',
    kind: 'nightly',
    status: 'partial',
    started_at: '2026-10-12T21:30:00.000Z',
    finished_at: '2026-10-12T21:34:00.000Z',
    object_key: 'daily/2026-10-12.sql.gz.age',
    bytes: 1_200_000,
    sha256: 'a'.repeat(64),
    targets: [
      { name: 'r2', ok: true },
      { name: 'b2', ok: false, detail: 'skipped' },
    ],
    details: null,
    run_url: 'https://github.com/faysalmehmood/maktab/actions/runs/1',
    note: null,
    created_by_name: null,
  },
  last_drill: null,
  runs: [],
  objects: [
    { key: 'daily/2026-10-12.sql.gz.age', size: 1_200_000, uploaded: '2026-10-12T21:34:00.000Z' },
  ],
  objects_error: null,
  time_travel_days: 7,
  report_configured: true,
};

const alarms: AlarmsDto = {
  at: '2026-10-13T05:00:00.000Z',
  total: 2,
  alarms: [
    { kind: 'ledger_consistency', count: 0, sample: [] },
    { kind: 'messages_stuck', count: 4, sample: [{ id: 'M1', label: 'absence × 4' }] },
    { kind: 'messages_failed', count: 0, sample: [] },
    { kind: 'gate_lockouts', count: 1, sample: [{ id: 'L1', label: 'parent_link' }] },
    { kind: 'billing_attention', count: 0, sample: [] },
    { kind: 'backup_stale', count: 0, sample: [], since: null },
  ],
};

describe('Settings → Backup', () => {
  it('shows the nightly status, the bucket, the alarms and the drill checklist', async () => {
    const { calls } = mockApi({
      'GET /api/backup/status': status,
      'GET /api/alarms': alarms,
      'POST /api/backup/drills': { ...status.last_nightly, kind: 'manual_drill', status: 'ok' },
    });
    renderAt('/settings', '/settings', <BackupPanel />);
    expect(await screen.findByText('Partial')).toBeTruthy();
    expect(screen.getByText('r2 ✓')).toBeTruthy();
    expect(screen.getByText('b2 ✗')).toBeTruthy();
    expect(screen.getAllByText('daily/2026-10-12.sql.gz.age').length).toBe(2);
    expect(await screen.findByText(/Messages waiting more than 3 days/)).toBeTruthy();
    expect(screen.getByText(/Parent-page lockouts/)).toBeTruthy();
    expect(screen.queryByText(/Money records that do not add up/)).toBeNull();
    expect(screen.getByText('No restore drill recorded yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download everything' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Record drill' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/backup/drills')).toBe(true));
    const body = calls.find((c) => c.path === '/api/backup/drills')?.body as { date: string };
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('says so when reporting is not set up and nothing ran yet', async () => {
    mockApi({
      'GET /api/backup/status': {
        ...status,
        last_nightly: null,
        objects: null,
        report_configured: false,
      },
      'GET /api/alarms': {
        ...alarms,
        total: 0,
        alarms: alarms.alarms.map((a) => ({ ...a, count: 0 })),
      },
    });
    renderAt('/settings', '/settings', <BackupPanel />);
    expect(await screen.findByText(/Backup reports are not set up/)).toBeTruthy();
    expect(screen.getByText('No nightly backup has reported yet.')).toBeTruthy();
    expect(screen.getByText('The backup bucket is not connected to this server.')).toBeTruthy();
    expect(await screen.findByText('All clear: nothing needs attention.')).toBeTruthy();
  });

  it('only the owner gets the Backup section; everyone gets About', () => {
    expect(visibleSections(['owner'])).toEqual(
      expect.arrayContaining(['backup', 'data', 'about', 'messages']),
    );
    expect(visibleSections(['admin'])).not.toContain('backup');
    expect(visibleSections(['admin'])).toContain('data');
    expect(visibleSections(['teacher'])).toEqual(['account', 'about']);
    expect(visibleSections(['accountant'])).toEqual(['account', 'school', 'about']);
  });
});

/** Keeps the BOM (TextDecoder drops it by default). */
const strFromU8 = (b: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(b);

describe('Download everything', () => {
  it('pulls every part and builds a ZIP with one CSV per table + schema.sql + README.txt', async () => {
    const job: ExportJobDto = {
      id: 'J1',
      created_at: '2026-10-13T05:00:00.000Z',
      tables: ['family', 'student', 'empty_table'],
      schema: 'CREATE TABLE family (id text);',
    };
    const parts: Record<string, ExportPartDto[]> = {
      family: [
        { table: 'family', columns: ['id', 'name'], rows: [['F1', 'Khan']], next: 1 },
        { table: 'family', columns: ['id', 'name'], rows: [['F2', '=HYPERLINK("x")']], next: null },
      ],
      student: [
        {
          table: 'student',
          columns: ['id', 'name', 'fee'],
          rows: [['S1', 'علی', 500]],
          next: null,
        },
      ],
      empty_table: [{ table: 'empty_table', columns: ['id'], rows: [], next: null }],
    };
    const { calls } = mockApi({
      'POST /api/backup/export': job,
      'GET /api/backup/export/J1/part': (url: URL) => {
        const t = url.searchParams.get('table') ?? '';
        const after = Number(url.searchParams.get('after'));
        return parts[t]?.[after === 0 ? 0 : 1];
      },
      'POST /api/backup/export/J1/finish': { ok: true },
    });
    const progress: string[] = [];
    const r = await buildExport((p) => progress.push(`${p.index}/${p.total}`));
    expect(progress).toEqual(['1/3', '2/3', '3/3']);
    const files = unzipSync(new Uint8Array(await r.blob.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual([
      'README.txt',
      'schema.sql',
      'tables/empty_table.csv',
      'tables/family.csv',
      'tables/student.csv',
    ]);
    expect(r.files).toBe(5);
    expect(r.rows).toBe(3);
    const family = strFromU8(files['tables/family.csv'] as Uint8Array);
    // BOM, header, and the formula-safe cell (a leading apostrophe).
    expect(family).toBe('﻿id,name\r\nF1,Khan\r\nF2,"\'=HYPERLINK(""x"")"\r\n');
    expect(strFromU8(files['tables/student.csv'] as Uint8Array)).toContain('S1,علی,500');
    expect(strFromU8(files['tables/empty_table.csv'] as Uint8Array)).toBe('﻿id\r\n');
    expect(strFromU8(files['README.txt'] as Uint8Array)).toContain('Download everything');
    expect(calls.at(-1)).toEqual({
      method: 'POST',
      path: '/api/backup/export/J1/finish',
      body: { rows: 3, files: 5 },
    });
  });
});

describe('export retries', () => {
  it('retries a failed part (network or 5xx) and still builds the ZIP', async () => {
    let failures = 0;
    const waits: number[] = [];
    mockApi({
      'POST /api/backup/export': { id: 'J2', created_at: 'x', tables: ['family'], schema: '' },
      'GET /api/backup/export/J2/part': () => {
        failures++;
        if (failures === 1) throw new TypeError('Failed to fetch');
        if (failures === 2)
          return new Response(JSON.stringify({ error: { code: 'x', message: 'busy' } }), {
            status: 503,
          });
        return { table: 'family', columns: ['id'], rows: [['F1']], next: null };
      },
      'POST /api/backup/export/J2/finish': { ok: true },
    });
    const r = await buildExport(undefined, { wait: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([1000, 2000]);
    expect(r.rows).toBe(1);
    const files = unzipSync(new Uint8Array(await r.blob.arrayBuffer()));
    expect(strFromU8(files['tables/family.csv'] as Uint8Array)).toBe('\ufeffid\r\nF1\r\n');
  });

  it('gives up after 3 retries, and never retries a 4xx answer', async () => {
    const waits: number[] = [];
    let n = 0;
    const down = () => {
      n++;
      return Promise.reject(new ApiError(502, 'http_error', 'HTTP 502'));
    };
    await expect(withRetry(down, { wait: async (ms) => void waits.push(ms) })).rejects.toThrow(
      'HTTP 502',
    );
    expect(n).toBe(4);
    expect(waits).toEqual([1000, 2000, 4000]);
    n = 0;
    const expired = () => {
      n++;
      return Promise.reject(new ApiError(409, 'export_expired', 'expired'));
    };
    await expect(withRetry(expired, { wait: async () => {} })).rejects.toThrow('expired');
    expect(n).toBe(1);
  });
});

describe('backup_stale alarm', () => {
  const stale = {
    kind: 'backup_stale' as const,
    count: 1,
    since: '2026-10-10T21:40:00Z',
    sample: [{ id: 'B9', label: 'last ok 2026-10-10T21:40' }],
  };

  it('the Backup page explains it in plain words with the last good date', async () => {
    mockApi({
      'GET /api/backup/status': status,
      'GET /api/alarms': { ...alarms, total: 1, alarms: [stale] },
    });
    renderAt('/settings', '/settings', <BackupPanel />);
    expect(await screen.findByText('Nightly backup not running', { exact: false })).toBeTruthy();
    expect(
      screen.getByText(
        'Backups have not run since 10/10/2026; check GitHub Actions (the nightly-backup workflow) and the Cloudflare API token.',
      ),
    ).toBeTruthy();
  });

  it('the dashboard banner carries the same explanation', async () => {
    mockApi({
      'GET /api/alarms/latest': {
        event: {
          day: '2026-10-13',
          at: alarms.at,
          total: 1,
          alarms: [stale],
          acknowledged_at: null,
        },
      },
    });
    renderAt('/', '/', <AlarmBanner />);
    expect(await screen.findByText('1 alarm(s) need attention')).toBeTruthy();
    expect(document.getElementById('alarm-backup-stale')?.textContent).toContain(
      'Backups have not run since 10/10/2026',
    );
  });
});

describe('recycle bin, banner, about', () => {
  it('lists removed items and restores one', async () => {
    const bin: RecycleBinDto = {
      items: [{ kind: 'subject', id: 'SUB1', name: 'Maths', removed_at: '2026-10-01T10:00:00Z' }],
    };
    const { calls } = mockApi({
      'GET /api/recycle-bin': bin,
      'POST /api/recycle-bin/restore': { ok: true },
    });
    renderAt('/settings', '/settings', <RecycleBin />);
    expect(await screen.findByText('Maths')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore: Maths' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/recycle-bin/restore')?.body).toEqual({
        kind: 'subject',
        id: 'SUB1',
      }),
    );
  });

  it('the owner dashboard banner shows the latest pass until dismissed', async () => {
    const { calls } = mockApi({
      'GET /api/alarms/latest': {
        event: {
          day: '2026-10-13',
          at: alarms.at,
          total: 2,
          alarms: alarms.alarms,
          acknowledged_at: null,
        },
      },
      'POST /api/alarms/2026-10-13/ack': { ok: true },
    });
    renderAt('/', '/', <AlarmBanner />);
    expect(await screen.findByText('2 alarm(s) need attention')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open alarms' }).getAttribute('href')).toBe(
      '/settings?section=backup',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === '/api/alarms/2026-10-13/ack')).toBe(true),
    );
  });

  it('no banner for an admin (no request either)', async () => {
    const { calls } = mockApi({});
    renderAt('/', '/', <AlarmBanner />, ['admin']);
    await new Promise((r) => setTimeout(r, 20));
    expect(document.getElementById('alarm-banner')).toBeNull();
    expect(calls.filter((c) => c.path.startsWith('/api/alarms'))).toEqual([]);
  });

  it('About shows version, build, links, contact and licence (also in Urdu)', async () => {
    renderAt('/settings', '/settings', <AboutPanel />, ['teacher']);
    expect(
      screen.getByText('github.com/faysalmehmood/maktab').closest('a')?.getAttribute('href'),
    ).toBe('https://github.com/faysalmehmood/maktab');
    expect(screen.getByText('maktab@conceptlix.com').closest('a')?.getAttribute('href')).toBe(
      'mailto:maktab@conceptlix.com',
    );
    expect(screen.getByText('AGPL-3.0-only')).toBeTruthy();
    expect(screen.getAllByText('dev').length).toBe(2);
    await act(() => setLanguage('ur'));
    expect(screen.getByText('سورس کوڈ')).toBeTruthy();
  });
});
