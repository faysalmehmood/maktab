import { IMPORT_COMMIT_ROWS } from '@maktab/shared';
import { describe, expect, it, vi } from 'vitest';
import { commitInChunks } from '@/pages/students/Import';
import { mockApi } from './api-mock';

const header = 'student_name,group,guardian_name,guardian_phone';
const file = (n: number) =>
  new Blob([
    `\uFEFF${header}\r\n${Array.from({ length: n }, (_, i) => `S${i},5-A,G,"0300 ${1000000 + i}"`).join('\r\n')}\r\n`,
  ]);

/** A fake commit endpoint: echoes what a chunk carried, like the server's report. */
function server(failAtOffset?: number) {
  const chunks: { offset: number; runId: string | null; rows: string[] }[] = [];
  const api = mockApi({
    'POST /api/imports/students': async (url: URL, init: RequestInit) => {
      const offset = Number(url.searchParams.get('offset'));
      const total = Number(url.searchParams.get('total'));
      const text = await ((init.body as FormData).get('file') as Blob).text();
      const [head, ...rows] = text.trimEnd().split('\r\n');
      expect(head).toBe(header);
      chunks.push({ offset, runId: url.searchParams.get('run_id'), rows });
      if (offset === failAtOffset) {
        return new Response(
          JSON.stringify({ error: { code: 'import_failed', message: 'stopped' } }),
          { status: 409 },
        );
      }
      return new Response(
        JSON.stringify({
          dry_run: false,
          run_id: 'RUN',
          total: rows.length,
          summary: {
            families: 0,
            guardians: 0,
            students: rows.length,
            enrolments: 0,
            skipped: 0,
            errors: 0,
          },
          rows: rows.map((_, i) => ({
            row: offset + i + 1,
            student_name: '',
            errors: [],
            warnings: [],
            action: 'create',
            family: 'new',
          })),
          applied: rows.length,
          remaining: total - offset - rows.length,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  return { api, chunks };
}

describe('import commit loop', () => {
  it('sends the file in chunks of IMPORT_COMMIT_ROWS, in order, carrying the run id', async () => {
    const { chunks } = server();
    const progress = vi.fn();
    const report = await commitInChunks(file(450), 'kids.csv', progress);
    expect(IMPORT_COMMIT_ROWS).toBe(200);
    expect(chunks.map((c) => [c.offset, c.rows.length, c.runId])).toEqual([
      [0, 200, null],
      [200, 200, 'RUN'],
      [400, 50, 'RUN'],
    ]);
    // Raw records go through untouched (quoted cells included).
    expect(chunks[1]?.rows[0]).toBe('S200,5-A,G,"0300 1000200"');
    expect(progress.mock.calls.map(([p]) => p)).toEqual([
      { done: 0, total: 450 },
      { done: 200, total: 450 },
      { done: 400, total: 450 },
      { done: 450, total: 450 },
    ]);
    expect(report.summary.students).toBe(450);
    expect(report.rows.at(-1)?.row).toBe(450);
    vi.unstubAllGlobals();
  });

  it('stops at a failed chunk, keeping the progress made (resume = upload again)', async () => {
    const { chunks } = server(200);
    const progress = vi.fn();
    await expect(commitInChunks(file(450), 'kids.csv', progress)).rejects.toMatchObject({
      code: 'import_failed',
    });
    expect(chunks.map((c) => c.offset)).toEqual([0, 200]);
    expect(progress.mock.calls.at(-1)?.[0]).toEqual({ done: 200, total: 450 });
    vi.unstubAllGlobals();
  });
});
