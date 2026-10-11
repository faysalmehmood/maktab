import {
  hasGrant,
  MESSAGE_LANGS,
  type MessageLang,
  type MessageSettingsDto,
  type MessageTemplateDto,
  PARENT_GATES,
  TEMPLATE_KEYS,
  type TemplateKey,
  templateProblems,
} from '@maktab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNote } from '@/components/form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { Textarea } from '@/components/ui/textarea';
import { getJson, sendJson } from '@/lib/api';
import { useRoles } from '@/lib/roles';
import { MARK, WithValue } from './common';
import { TemplateEditor } from './TemplateEditor';

const templatesKey = ['message-templates'] as const;
const settingsKey = ['message-settings'] as const;

function TemplateLang({ item }: { item: MessageTemplateDto }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [body, setBody] = useState(item.body);
  useEffect(() => setBody(item.body), [item.body]);
  const save = useMutation({
    mutationFn: (value: string | null) =>
      sendJson<{ item: MessageTemplateDto }>(
        'PUT',
        `/api/messages/templates/${item.key}/${item.lang}`,
        { body: value },
      ),
    onSuccess: (r, value) => {
      qc.setQueryData<{ items: MessageTemplateDto[] }>(templatesKey, (old) =>
        old
          ? {
              items: old.items.map((x) =>
                x.key === r.item.key && x.lang === r.item.lang ? r.item : x,
              ),
            }
          : old,
      );
      setBody(r.item.body);
      toast.success(value === null ? t('msg.settings.resetDone') : t('common.saved'));
    },
  });
  const id = `tpl-${item.key}-${item.lang}`;
  const dirty = body.trim() !== item.body;
  const problems = templateProblems(item.key, body);
  const invalid = !body.trim() || problems.unknown.length > 0 || problems.missing.length > 0;
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={item.is_default ? 'secondary' : 'default'}>
          {item.is_default ? t('msg.settings.default') : t('msg.settings.customised')}
        </Badge>
        {item.updated_by_name && (
          <span className="text-xs text-muted-foreground">
            <WithValue sentence={t('msg.settings.lastChanged', { name: MARK })}>
              {item.updated_by_name}
            </WithValue>
          </span>
        )}
      </div>
      <TemplateEditor
        id={id}
        label={t(`msg.langs.${item.lang}`)}
        previewLabel={t('msg.settings.preview')}
        lang={item.lang}
        value={body}
        onChange={setBody}
        templateKey={item.key}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          id={`${id}-save`}
          disabled={!dirty || invalid || save.isPending}
          onClick={() => save.mutate(body.trim())}
        >
          {save.isPending ? t('common.saving') : t('common.save')}
        </Button>
        <Button
          id={`${id}-reset`}
          variant="outline"
          disabled={item.is_default || save.isPending}
          onClick={() => save.mutate(null)}
        >
          <RotateCcw aria-hidden />
          {t('msg.settings.reset')}
        </Button>
      </div>
      <ErrorNote error={save.error} />
    </div>
  );
}

function TemplatesEditor() {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: templatesKey,
    queryFn: () => getJson<{ items: MessageTemplateDto[] }>('/api/messages/templates'),
  });
  const [key, setKey] = useState<TemplateKey>('absence');
  const items = q.data?.items ?? [];
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-medium">{t('msg.settings.templates')}</h3>
      <p className="text-sm text-muted-foreground">{t('msg.settings.templatesHint')}</p>
      <div className="flex flex-col gap-1">
        <Label htmlFor="tpl-key">{t('msg.queue.template')}</Label>
        <Select id="tpl-key" value={key} onChange={(e) => setKey(e.target.value as TemplateKey)}>
          {TEMPLATE_KEYS.map((k) => (
            <option key={k} value={k}>
              {t(`msg.templates.${k}`)}
            </option>
          ))}
        </Select>
      </div>
      {q.isPending && <p className="text-muted-foreground">{t('common.loading')}</p>}
      <ErrorNote error={q.error} />
      {MESSAGE_LANGS.map((lang: MessageLang) => {
        const item = items.find((x) => x.key === key && x.lang === lang);
        return item ? <TemplateLang key={`${key}-${lang}`} item={item} /> : null;
      })}
    </div>
  );
}

function GeneralForm() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: settingsKey,
    queryFn: () => getJson<MessageSettingsDto>('/api/school/messages'),
  });
  const [draft, setDraft] = useState<MessageSettingsDto | null>(null);
  useEffect(() => {
    if (q.data) setDraft(q.data);
  }, [q.data]);
  const save = useMutation({
    mutationFn: (body: MessageSettingsDto) =>
      sendJson<MessageSettingsDto>('PUT', '/api/school/messages', body),
    onSuccess: (r) => {
      qc.setQueryData(settingsKey, r);
      toast.success(t('msg.settings.saved'));
    },
  });
  if (q.isPending) return <p className="text-muted-foreground">{t('common.loading')}</p>;
  if (!draft) return <ErrorNote error={q.error} />;
  const days = draft.reminder_cooldown_days;
  const daysOk = Number.isInteger(days) && days >= 1 && days <= 90;
  return (
    <form
      id="msg-settings"
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (daysOk)
          save.mutate({
            ...draft,
            announcement_groups_note: draft.announcement_groups_note?.trim() || null,
          });
      }}
    >
      <h3 className="font-medium">{t('msg.settings.general')}</h3>
      <div className="flex flex-col gap-1">
        <Label htmlFor="msg-cooldown">{t('msg.settings.cooldown')}</Label>
        <Input
          id="msg-cooldown"
          type="number"
          inputMode="numeric"
          min={1}
          max={90}
          className="num max-w-28"
          value={Number.isNaN(days) ? '' : days}
          aria-invalid={!daysOk}
          onChange={(e) =>
            setDraft({ ...draft, reminder_cooldown_days: Number.parseInt(e.target.value, 10) })
          }
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="msg-gate">{t('msg.settings.gate')}</Label>
        <Select
          id="msg-gate"
          value={draft.parent_gate}
          onChange={(e) =>
            setDraft({ ...draft, parent_gate: e.target.value as MessageSettingsDto['parent_gate'] })
          }
        >
          {PARENT_GATES.map((g) => (
            <option key={g} value={g}>
              {t(`msg.link.gates.${g}`)}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">{t('msg.settings.gateHint')}</p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="msg-groups-note">{t('msg.settings.groupsNote')}</Label>
        <p className="text-sm text-muted-foreground">{t('msg.settings.groupsHelp')}</p>
        <Textarea
          id="msg-groups-note"
          rows={4}
          maxLength={2000}
          value={draft.announcement_groups_note ?? ''}
          onChange={(e) => setDraft({ ...draft, announcement_groups_note: e.target.value })}
        />
      </div>
      <Button type="submit" className="self-start" disabled={!daysOk || save.isPending}>
        {save.isPending ? t('common.saving') : t('common.save')}
      </Button>
      <ErrorNote error={save.error} />
    </form>
  );
}

/**
 * Owner only (backup.manage): revoke every parent link at once — after PARENT_LINK_SECRET was
 * rotated (old links can no longer be recomputed) or if links may have leaked.
 */
function RevokeAllLinks() {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState(false);
  const run = useMutation({
    mutationFn: () => sendJson<{ revoked: number }>('POST', '/api/parent-links/rotate-all', {}),
    onSuccess: (r) => {
      setConfirm(false);
      toast.success(t('msg.settings.rotateAllDone', { count: r.revoked }));
    },
  });
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-medium">{t('msg.settings.rotateAll')}</h3>
      <p className="text-sm text-muted-foreground">{t('msg.settings.rotateAllHint')}</p>
      {confirm ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm">{t('msg.settings.rotateAllConfirm')}</p>
          <Button
            id="msg-rotate-all-confirm"
            variant="destructive"
            disabled={run.isPending}
            onClick={() => run.mutate()}
          >
            {t('msg.settings.rotateAll')}
          </Button>
          <Button variant="outline" onClick={() => setConfirm(false)}>
            {t('common.cancel')}
          </Button>
        </div>
      ) : (
        <Button
          id="msg-rotate-all"
          variant="outline"
          className="self-start"
          onClick={() => setConfirm(true)}
        >
          {t('msg.settings.rotateAll')}
        </Button>
      )}
      <ErrorNote error={run.error} />
    </div>
  );
}

/** Settings → Messages (template.manage): templates en/ur and the message settings. */
export function MessageSettings() {
  const roles = useRoles();
  return (
    <div className="flex flex-col gap-6">
      <GeneralForm />
      <TemplatesEditor />
      {hasGrant(roles, 'backup', 'manage') && <RevokeAllLinks />}
    </div>
  );
}
