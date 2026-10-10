import { newId, type SessionDto, type SessionInput, sessionInputSchema } from '@maktab/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNote, Field, Num } from '@/components/form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { sendJson } from '@/lib/api';
import { type FieldErrors, issuesToErrors } from '@/lib/form';
import { useSessions } from '@/lib/queries';

/** Pakistani schools mostly start in April: before April we are still in last year's session. */
export function defaultSession(now = new Date()): SessionInput {
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return {
    name: `${y}-${String((y + 1) % 100).padStart(2, '0')}`,
    start_date: `${y}-04-01`,
    end_date: `${y + 1}-03-31`,
    is_current: true,
  };
}

export function SessionForm({
  formId,
  onSaved,
}: {
  formId?: string;
  onSaved?: (s: SessionDto) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<SessionInput>(defaultSession);
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation({
    mutationFn: (input: SessionInput) => sendJson<SessionDto>('POST', '/api/sessions', input),
    onSuccess: async (s) => {
      await qc.invalidateQueries({ queryKey: ['sessions'] });
      onSaved?.(s);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const input = { ...draft, id: newId() };
    const parsed = sessionInputSchema.safeParse(input);
    if (!parsed.success) return setErrors(issuesToErrors(parsed.error.issues, input));
    setErrors({});
    save.mutate(input);
  };
  return (
    <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-3">
      <Field id="session-name" label="session.name" error={errors.name} required>
        <Input
          id="session-name"
          dir="ltr"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field id="session-start" label="session.start" error={errors.start_date} required>
          <Input
            id="session-start"
            type="date"
            value={draft.start_date}
            onChange={(e) => setDraft({ ...draft, start_date: e.target.value })}
          />
        </Field>
        <Field id="session-end" label="session.end" error={errors.end_date} required>
          <Input
            id="session-end"
            type="date"
            value={draft.end_date}
            onChange={(e) => setDraft({ ...draft, end_date: e.target.value })}
          />
        </Field>
      </div>
      <ErrorNote error={save.error} />
      {!formId && (
        <Button type="submit" variant="outline" className="self-start" disabled={save.isPending}>
          {t('session.add')}
        </Button>
      )}
    </form>
  );
}

export function SessionsList() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const sessions = useSessions();
  const makeCurrent = useMutation({
    mutationFn: (id: string) =>
      sendJson<{ items: SessionDto[] }>('POST', `/api/sessions/${id}/current`),
    onSuccess: (data) => {
      qc.setQueryData(['sessions'], data);
      void qc.invalidateQueries({ queryKey: ['groups'] });
    },
  });
  const items = sessions.data?.items ?? [];
  if (!items.length) return <p className="text-sm text-muted-foreground">{t('session.empty')}</p>;
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y rounded-md border">
        {items.map((s) => (
          <li key={s.id} className="flex min-h-14 items-center gap-3 px-3 py-2">
            <div className="flex flex-col">
              <span className="font-medium">
                <Num>{s.name}</Num>
              </span>
              <span className="text-xs text-muted-foreground">
                <Num>
                  {s.start_date} → {s.end_date}
                </Num>
              </span>
            </div>
            <div className="ms-auto">
              {s.is_current ? (
                <Badge>{t('session.current')}</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={makeCurrent.isPending}
                  onClick={() => makeCurrent.mutate(s.id)}
                >
                  {t('session.setCurrent')}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <ErrorNote error={makeCurrent.error} />
    </div>
  );
}
