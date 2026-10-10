import type { AttendanceMode, HolidayDto, SchoolDto, SchoolResponse } from '@maktab/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNote, Num } from '@/components/form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { sendJson } from '@/lib/api';
import { useHolidays } from '@/lib/attendance';
import { cn } from '@/lib/utils';

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const;

/** Register mode and the weekly day off (Sunday by default; Friday for some schools). */
export function AttendanceSettingsForm({ school }: { school: SchoolDto }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [mode, setMode] = useState<AttendanceMode>(school.attendance_mode);
  const [off, setOff] = useState<number[]>(school.weekly_off);
  const save = useMutation({
    mutationFn: () =>
      sendJson<SchoolResponse>('PUT', '/api/school/attendance', {
        attendance_mode: mode,
        weekly_off: off,
      }),
    onSuccess: async (r) => {
      qc.setQueryData(['school'], r);
      await qc.invalidateQueries({ queryKey: ['attendance'] });
      toast.success(t('attendance.settingsSaved'));
    },
  });
  const toggle = (d: number) =>
    setOff((o) => (o.includes(d) ? o.filter((x) => x !== d) : [...o, d].sort()));
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="att-mode">{t('attendance.mode')}</Label>
        <Select
          id="att-mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as AttendanceMode)}
        >
          <option value="daily">{t('attendance.modes.daily')}</option>
          <option value="per_subject">{t('attendance.modes.per_subject')}</option>
        </Select>
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-sm font-medium">{t('attendance.weeklyOff')}</legend>
        <div className="flex flex-wrap gap-2">
          {WEEKDAYS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={off.includes(d)}
              onClick={() => toggle(d)}
              className={cn(
                'min-h-11 rounded-md border px-3 text-sm',
                off.includes(d) && 'border-primary bg-primary text-primary-foreground',
              )}
            >
              {t(`attendance.weekdays.d${d}`)}
            </button>
          ))}
        </div>
      </fieldset>
      <ErrorNote error={save.error} />
      <Button type="submit" className="self-start" disabled={save.isPending}>
        {save.isPending ? t('common.saving') : t('common.save')}
      </Button>
    </form>
  );
}

export function HolidaysEditor() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const list = useHolidays().data?.items ?? [];
  const [draft, setDraft] = useState({ date: '', name_en: '', name_ur: '' });
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['holidays'] }),
      qc.invalidateQueries({ queryKey: ['attendance'] }),
    ]);
  const add = useMutation({
    mutationFn: () => sendJson<HolidayDto>('POST', '/api/holidays', draft),
    onSuccess: async () => {
      setDraft({ date: '', name_en: '', name_ur: '' });
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (date: string) => sendJson('DELETE', `/api/holidays/${date}`),
    onSuccess: refresh,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (draft.date && draft.name_en.trim()) add.mutate();
  };
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-medium">{t('attendance.holidays')}</h3>
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('attendance.noHolidays')}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {list.map((h) => (
            <li key={h.date} className="flex min-h-11 items-center gap-3 ps-3">
              <Num>{h.date}</Num>
              <bdi className="flex-1">
                {i18n.language === 'ur' && h.name_ur ? h.name_ur : h.name_en}
              </bdi>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`${t('common.remove')} ${h.date}`}
                disabled={remove.isPending}
                onClick={() => remove.mutate(h.date)}
              >
                <Trash2 aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="grid gap-2 sm:grid-cols-[auto_1fr_1fr_auto] sm:items-end">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hol-date">{t('attendance.date')}</Label>
          <Input
            id="hol-date"
            type="date"
            value={draft.date}
            onChange={(e) => setDraft({ ...draft, date: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hol-en">{t('attendance.holidayName')}</Label>
          <Input
            id="hol-en"
            value={draft.name_en}
            onChange={(e) => setDraft({ ...draft, name_en: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hol-ur">{t('attendance.holidayNameUr')}</Label>
          <Input
            id="hol-ur"
            lang="ur"
            dir="rtl"
            value={draft.name_ur}
            onChange={(e) => setDraft({ ...draft, name_ur: e.target.value })}
          />
        </div>
        <Button type="submit" disabled={add.isPending || !draft.date || !draft.name_en.trim()}>
          {t('attendance.addHoliday')}
        </Button>
      </form>
      <ErrorNote error={add.error ?? remove.error} />
    </div>
  );
}
