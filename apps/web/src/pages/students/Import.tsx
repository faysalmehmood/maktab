import type { ImportReport } from '@maktab/shared';
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

/** Upload → dry-run report → commit (idempotent server-side, so a re-upload adds nothing twice). */
export function ImportPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const run = useMutation({
    mutationFn: ({ dry }: { dry: boolean }) => {
      if (!file) throw new Error('required');
      return uploadFile<ImportReport>(
        `/api/imports/students${dry ? '?dry_run=1' : ''}`,
        file,
        file.name,
      );
    },
    onSuccess: async (r) => {
      setReport(r);
      if (!r.dry_run) await qc.invalidateQueries({ queryKey: ['students'] });
    },
  });
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
          }}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={!file || run.isPending}
          onClick={() => run.mutate({ dry: true })}
        >
          {t('import.check')}
        </Button>
        {report?.dry_run && toCreate > 0 && (
          <Button disabled={run.isPending} onClick={() => run.mutate({ dry: false })}>
            {t('import.commit', { n: toCreate })}
          </Button>
        )}
      </div>
      <ErrorNote error={run.error} />
      {report && !report.dry_run && (
        <p className="font-medium text-primary">{t('import.committed')}</p>
      )}
      {report && <ReportView report={report} />}
    </section>
  );
}
