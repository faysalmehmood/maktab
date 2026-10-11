import {
  type FamilyDetailDto,
  type GuardianDto,
  normalizePkMobile,
  PARENT_GATES,
  type ParentLinkCreatedDto,
  type ParentLinkStatusDto,
  waUrl,
} from '@maktab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ClipboardCopy, Link2, MessageCircle, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNote, Num } from '@/components/form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { getJson, sendJson } from '@/lib/api';
import { copyText, formatDateTime } from '@/lib/messages';
import { cn } from '@/lib/utils';

type GateChoice = 'default' | (typeof PARENT_GATES)[number];
const GATE_CHOICES: GateChoice[] = ['default', ...PARENT_GATES];

export const parentLinkKey = (guardianId: string) => ['parent-link', guardianId] as const;

/**
 * A guardian's parent-page link (PLAN §7, §14.10): status, create / rotate (with the check before
 * dues: school default, none, birth year or a PIN), the new URL shown once with Copy and "Send via
 * WhatsApp", revoke, and the last visits. The caller shows it only with student.write.
 */
export function ParentLinkPanel({
  guardian,
}: {
  guardian: Pick<GuardianDto, 'id' | 'name' | 'phone' | 'whatsapp' | 'lang'>;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [gate, setGate] = useState<GateChoice>('default');
  const [pin, setPin] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const status = useQuery({
    queryKey: parentLinkKey(guardian.id),
    queryFn: () => getJson<ParentLinkStatusDto>(`/api/guardians/${guardian.id}/parent-link`),
    enabled: open,
  });
  const create = useMutation({
    mutationFn: () =>
      sendJson<ParentLinkCreatedDto>('POST', `/api/guardians/${guardian.id}/parent-link`, {
        gate,
        ...(gate === 'pin' ? { pin } : {}),
      }),
    onSuccess: (r) => {
      setCreated(r.url);
      setPin('');
      const { url: _url, ...rest } = r;
      qc.setQueryData(parentLinkKey(guardian.id), rest);
    },
  });
  const revoke = useMutation({
    mutationFn: () =>
      sendJson<ParentLinkStatusDto>('POST', `/api/guardians/${guardian.id}/parent-link/revoke`),
    onSuccess: (r) => {
      setConfirmRevoke(false);
      setCreated(null);
      qc.setQueryData(parentLinkKey(guardian.id), r);
      toast.success(t('msg.link.revoked'));
    },
  });

  const link = status.data?.link ?? null;
  const live = link?.status === 'active';
  const number =
    normalizePkMobile(guardian.whatsapp ?? '') ?? normalizePkMobile(guardian.phone ?? '');
  // The text goes in the guardian's own language; the URL alone on the last line (exp4).
  const waText = created
    ? `${i18n.getFixedT(guardian.lang === 'ur' ? 'ur' : 'en')('msg.link.waText')}\n${created}`
    : '';
  const pinOk = gate !== 'pin' || /^\d{4,6}$/.test(pin);

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start"
        aria-expanded={open}
        aria-controls={`plink-${guardian.id}`}
        onClick={() => setOpen((o) => !o)}
      >
        <Link2 aria-hidden />
        {t('msg.link.title')}
        <ChevronDown aria-hidden className={cn('transition-transform', open && 'rotate-180')} />
      </Button>
      {open && (
        <div id={`plink-${guardian.id}`} className="flex flex-col gap-3 rounded-md border p-3">
          {status.isPending && (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          )}
          <ErrorNote error={status.error} />
          {status.data && !link && (
            <p className="text-sm text-muted-foreground">{t('msg.link.none')}</p>
          )}
          {link && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{t('msg.queue.status')}</dt>
              <dd>
                <Badge id={`plink-status-${guardian.id}`} variant={live ? 'default' : 'secondary'}>
                  {t(`msg.link.statuses.${link.status}`)}
                </Badge>
              </dd>
              <dt className="text-muted-foreground">{t('msg.link.created')}</dt>
              <dd>
                <Num>{formatDateTime(link.created_at)}</Num>
                {link.created_by_name && (
                  <span className="text-muted-foreground">
                    {' · '}
                    <bdi>{link.created_by_name}</bdi>
                  </span>
                )}
              </dd>
              <dt className="text-muted-foreground">{t('msg.link.lastSeen')}</dt>
              <dd>
                {link.last_seen_at ? (
                  <Num>{formatDateTime(link.last_seen_at)}</Num>
                ) : (
                  t('msg.link.never')
                )}
              </dd>
              <dt className="text-muted-foreground">{t('msg.link.expires')}</dt>
              <dd>
                {link.expires_at ? (
                  <Num>{formatDateTime(link.expires_at)}</Num>
                ) : (
                  t('msg.link.never')
                )}
              </dd>
              <dt className="text-muted-foreground">{t('msg.link.gate')}</dt>
              <dd>{t(`msg.link.gates.${link.gate}`)}</dd>
            </dl>
          )}

          {created && (
            <div className="flex flex-col gap-2 rounded-md bg-primary/5 p-2" role="status">
              <p className="text-sm font-medium">{t('msg.link.once')}</p>
              <bdi
                id={`plink-url-${guardian.id}`}
                dir="ltr"
                className="num block break-all rounded border bg-background p-2 text-sm"
              >
                {created}
              </bdi>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void copyText(created).then((ok) => ok && toast.success(t('msg.link.copied')))
                  }
                >
                  <ClipboardCopy aria-hidden />
                  {t('msg.link.copy')}
                </Button>
                {number && (
                  <Button asChild size="sm">
                    <a
                      id={`plink-wa-${guardian.id}`}
                      href={waUrl(number, waText)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <MessageCircle aria-hidden />
                      {t('msg.link.sendWa')}
                    </a>
                  </Button>
                )}
              </div>
            </div>
          )}

          {status.data && (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (pinOk) create.mutate();
              }}
            >
              <div className="flex min-w-40 flex-1 flex-col gap-1">
                <Label htmlFor={`plink-gate-${guardian.id}`}>{t('msg.link.gate')}</Label>
                <Select
                  id={`plink-gate-${guardian.id}`}
                  value={gate}
                  onChange={(e) => setGate(e.target.value as GateChoice)}
                >
                  {GATE_CHOICES.map((g) => (
                    <option key={g} value={g}>
                      {t(`msg.link.gates.${g}`)}
                    </option>
                  ))}
                </Select>
              </div>
              {gate === 'pin' && (
                <div className="flex w-36 flex-col gap-1">
                  <Label htmlFor={`plink-pin-${guardian.id}`}>{t('msg.link.pin')}</Label>
                  <Input
                    id={`plink-pin-${guardian.id}`}
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={6}
                    dir="ltr"
                    className="num"
                    value={pin}
                    aria-invalid={!pinOk}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                  />
                </div>
              )}
              <Button
                id={`plink-create-${guardian.id}`}
                type="submit"
                disabled={create.isPending || !pinOk}
              >
                {live ? <RefreshCw aria-hidden /> : <Link2 aria-hidden />}
                {live ? t('msg.link.rotate') : t('msg.link.create')}
              </Button>
              {live && (
                <p className="w-full text-xs text-muted-foreground">{t('msg.link.rotateHint')}</p>
              )}
            </form>
          )}
          <ErrorNote error={create.error} />

          {live &&
            (confirmRevoke ? (
              <div className="flex flex-col gap-2 rounded-md bg-destructive/10 p-2">
                <p className="text-sm">{t('msg.link.revokeConfirm')}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    id={`plink-revoke-confirm-${guardian.id}`}
                    variant="destructive"
                    size="sm"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate()}
                  >
                    {t('msg.link.revoke')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmRevoke(false)}>
                    {t('common.cancel')}
                  </Button>
                </div>
                <ErrorNote error={revoke.error} />
              </div>
            ) : (
              <Button
                id={`plink-revoke-${guardian.id}`}
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => setConfirmRevoke(true)}
              >
                <Trash2 aria-hidden />
                {t('msg.link.revoke')}
              </Button>
            ))}

          {status.data && link && (
            <div className="flex flex-col gap-1">
              <h4 className="text-sm font-medium">{t('msg.link.access')}</h4>
              {status.data.access.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('msg.link.noAccess')}</p>
              ) : (
                <ul className="flex flex-col divide-y text-sm">
                  {status.data.access.slice(0, 10).map((a) => (
                    <li key={`${a.at}-${a.ip_hash ?? ''}`} className="flex flex-col py-1">
                      <Num>{formatDateTime(a.at)}</Num>
                      <span className="truncate text-xs text-muted-foreground">
                        {a.ua ? <bdi>{a.ua}</bdi> : t('msg.link.unknownDevice')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Every guardian of a family with their parent-page link (family statement page). */
export function FamilyParentLinks({ familyId }: { familyId: string }) {
  const { t } = useTranslation();
  const family = useQuery({
    queryKey: ['family', familyId],
    queryFn: () => getJson<FamilyDetailDto>(`/api/families/${familyId}`),
  });
  const guardians = family.data?.guardians ?? [];
  if (!guardians.length) return null;
  return (
    <Card className="gap-3 py-4 print:hidden">
      <CardHeader className="px-4">
        <CardTitle>{t('msg.link.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col divide-y px-4">
        {guardians.map((g) => (
          <div key={g.id} className="flex flex-col gap-1 py-2">
            <bdi className="font-medium">{g.name}</bdi>
            <ParentLinkPanel guardian={g} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
