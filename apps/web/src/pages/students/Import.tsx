import {
  csvRecords,
  IMPORT_COMMIT_ROWS,
  type ImportCommitResult,
  type ImportReport,
} from '@maktab/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNote, Field, Num, PageTitle } from '@/components/form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { uploadFile } from '@/lib/api';

function ReportView({ report }: { report: ImportReport }) {
  const { t } = useTranslation();
  const shown = report.rows.filter((r) => r.action !== 'create' || r.warnings.length);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        {t('import.summary', {
          students: report.summary.students,
          families: report.summary.families,
          skipped: report.summary.skipped,
          errors: report.summary.errors,
        })}
      </p>
      {shown.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('import.row')}</TableHead>
              <TableHead>{t('student.name')}</TableHead>
              <TableHead>{t('import.action')}</TableHead>
              <TableHead>
                {t('import.errors')} / {t('import.warnings')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((r) => (
              <TableRow key={r.row}>
                <TableCell>
                  <Num>{r.row}</Num>
                </TableCell>
                <TableCell>{r.student_name}</TableCell>
                <TableCell>
                  <Badge variant={r.action === 'error' ? 'destructive' : 'outline'}>
                    {t(`import.actions.${r.action}`)}
                  </Badge>
                </TableCell>
                <TableCell className="whitespace-normal">
                  {[...r.errors, ...r.warnings].map((m) => (
                    <bdi key={m} className="block text-xs">
                      {m}
                    </bdi>
                  ))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

type Progress = { done: number; total: number };

/**
 * Commit = the file in chunks of IMPORT_COMMIT_ROWS rows, one request each, in order (the server
 * caps a request at that so it stays inside the free Worker's limits). Rows are keyed by hash on
 * the server, so after a failure the same file can simply be imported again: what is in is skipped.
 */
export async function commitInChunks(
  file: Blob,
  fileName: string,
  onProgress: (p: Progress) => void,
): Promise<ImportReport> {
  const [header, ...records] = csvRecords(await file.text());
  if (header === undefined) throw new Error('required');
  const total = records.length;
  let runId: string | null = null;
  const merged: ImportReport = {
    dry_run: false,
    run_id: null,
    total,
    summary: { families: 0, guardians: 0, students: 0, enrolments: 0, skipped: 0, errors: 0 },
    rows: [],
  };
  onProgress({ done: 0, total });
  for (let offset = 0; offset < total; offset += IMPORT_COMMIT_ROWS) {
    const chunk = records.slice(offset, offset + IMPORT_COMMIT_ROWS);
    const q = new URLSearchParams({ offset: String(offset), total: String(total) });
    if (runId) q.set('run_id', runId);
    const r: ImportCommitResult = await uploadFile<ImportCommitResult>(
      `/api/imports/students?${q}`,
      new Blob([`${[header, ...chunk].join('\r\n')}\r\n`], { type: 'text/csv' }),
      fileName,
    );
    runId = r.run_id;
    merged.run_id = r.run_id;
    merged.rows.push(...r.rows);
    for (const k of Object.keys(merged.summary) as (keyof ImportReport['summary'])[])
      merged.summary[k] += r.summary[k];
    onProgress({ done: total - r.remaining, total });
  }
  return merged;
}

/** Upload → dry-run report (whole file) → commit in chunks with progress (resumable). */
export function ImportPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const check = useMutation({
    mutationFn: () => {
      if (!file) throw new Error('required');
      return uploadFile<ImportReport>('/api/imports/students?dry_run=1', file, file.name);
    },
    onSuccess: (r) => setReport(r),
  });
  const commit = useMutation({
    mutationFn: () => {
      if (!file) throw new Error('required');
      return commitInChunks(file, file.name, setProgress);
    },
    onSuccess: (r) => setReport(r),
    // Some chunks may be in: the lists must show them either way.
    onSettled: () => qc.invalidateQueries({ queryKey: ['students'] }),
  });
  const busy = check.isPending || commit.isPending;
  const toCreate = report?.dry_run ? report.summary.students : 0;
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <PageTitle>{t('import.title')}</PageTitle>
      <p className="text-sm text-muted-foreground">{t('import.help')}</p>
      <Button asChild variant="outline" className="self-start">
        <a href="/api/imports/students/template.csv" download="maktab-students.csv">
          <Download aria-hidden />
          {t('import.template')}
        </a>
      </Button>
      <Field id="import-file" label="import.file">
        <Input
          id="import-file"
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setReport(null);
            setProgress(null);
            commit.reset();
          }}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={!file || busy} onClick={() => check.mutate()}>
          {t('import.check')}
        </Button>
        {report?.dry_run && toCreate > 0 && (
          <Button disabled={busy} onClick={() => commit.mutate()}>
            {t('import.commit', { n: toCreate })}
          </Button>
        )}
      </div>
      {progress && (commit.isPending || commit.isError) && (
        <div className="flex flex-col gap-1">
          <progress
            className="h-2 w-full accent-primary"
            max={Math.max(progress.total, 1)}
            value={progress.done}
            aria-label={t('import.title')}
          />
          <p role="status" className="text-sm">
            {t('import.progress', { done: progress.done, total: progress.total })}
          </p>
        </div>
      )}
      <ErrorNote error={check.error ?? commit.error} />
      {commit.isError && <p className="text-sm">{t('import.resume')}</p>}
      {report && !report.dry_run && (
        <p className="font-medium text-primary">{t('import.committed')}</p>
      )}
      {report && <ReportView report={report} />}
    </section>
  );
}
