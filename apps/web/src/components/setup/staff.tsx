import {
  formatPkPhone,
  newId,
  STAFF_ROLES,
  type StaffInviteInput,
  type StaffRole,
  type StaffRowDto,
  staffInputSchema,
  staffInviteSchema,
} from '@maktab/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNote, Field, Num } from '@/components/form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { sendJson, useMe } from '@/lib/api';
import { type FieldErrors, issuesToErrors } from '@/lib/form';
import { useStaff } from '@/lib/queries';
import { canManageRoles, useRoles } from '@/lib/roles';

const useRefreshStaff = () => {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['staff'] });
};

export function InviteForm() {
  const { t } = useTranslation();
  const refresh = useRefreshStaff();
  const empty: StaffInviteInput = { email: '', role: 'teacher', name: '', title: '' };
  const [draft, setDraft] = useState<StaffInviteInput>(empty);
  const [errors, setErrors] = useState<FieldErrors>({});
  const invite = useMutation({
    mutationFn: (input: StaffInviteInput) => sendJson('POST', '/api/staff/invite', input),
    onSuccess: async () => {
      toast.success(t('staff.invited'));
      setDraft({ ...empty, role: draft.role });
      await refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = staffInviteSchema.safeParse(draft);
    if (!parsed.success) return setErrors(issuesToErrors(parsed.error.issues, draft));
    setErrors({});
    invite.mutate(draft);
  };
  return (
    <form
      onSubmit={submit}
      noValidate
      data-tour="staff-invite"
      className="flex flex-col gap-3 rounded-md border p-3"
    >
      <h3 className="font-medium">{t('staff.invite')}</h3>
      <Field
        id="invite-email"
        label="staff.email"
        error={errors.email}
        hint={t('staff.inviteHelp')}
        required
      >
        <Input
          id="invite-email"
          type="email"
          dir="ltr"
          autoComplete="off"
          value={draft.email}
          onChange={(e) => setDraft({ ...draft, email: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field id="invite-name" label="staff.name">
          <Input
            id="invite-name"
            value={draft.name ?? ''}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>
        <Field id="invite-role" label="staff.role">
          <Select
            id="invite-role"
            value={draft.role}
            onChange={(e) => setDraft({ ...draft, role: e.target.value as StaffRole })}
          >
            {STAFF_ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`staff.roles.${r}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field id="invite-title" label="staff.jobTitle">
        <Input
          id="invite-title"
          value={draft.title ?? ''}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
      </Field>
      <ErrorNote error={invite.error} />
      <Button type="submit" className="self-start" disabled={invite.isPending}>
        {t('staff.invite')}
      </Button>
    </form>
  );
}

function RolesDialog({ row, onClose }: { row: StaffRowDto; onClose: () => void }) {
  const { t } = useTranslation();
  const refresh = useRefreshStaff();
  const [roles, setRoles] = useState<StaffRole[]>(row.roles);
  const save = useMutation({
    mutationFn: () => sendJson('PUT', `/api/users/${row.user_id}/roles`, { roles }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('staff.editRoles')}</DialogTitle>
          <DialogDescription>
            <bdi>{row.email}</bdi>
          </DialogDescription>
        </DialogHeader>
        {STAFF_ROLES.map((r) => (
          <Checkbox
            key={r}
            label={t(`staff.roles.${r}`)}
            checked={roles.includes(r)}
            onChange={(e) =>
              setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))
            }
          />
        ))}
        <ErrorNote error={save.error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Edit an existing staff profile, or create one (optionally linked to a login). */
function ProfileDialog({
  row,
  onClose,
}: {
  row: StaffRowDto | { user_id: string | null; name: string };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshStaff();
  const existing = 'staff_id' in row && row.staff_id ? row : null;
  const [draft, setDraft] = useState({
    name: row.name,
    phone: existing ? formatPkPhone(existing.phone) : '',
    title: existing?.title ?? '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation({
    mutationFn: () =>
      existing
        ? sendJson('PATCH', `/api/staff/${existing.staff_id}`, draft)
        : sendJson('POST', '/api/staff', { id: newId(), user_id: row.user_id, ...draft }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = staffInputSchema.safeParse(draft);
    if (!parsed.success) return setErrors(issuesToErrors(parsed.error.issues, draft));
    setErrors({});
    save.mutate();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? t('staff.editProfile') : t('staff.addProfile')}</DialogTitle>
          <DialogDescription>{row.name}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="flex flex-col gap-3">
          <Field id="staff-name" label="staff.name" error={errors.name} required>
            <Input
              id="staff-name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>
          <Field id="staff-phone" label="staff.phone" error={errors.phone}>
            <Input
              id="staff-phone"
              type="tel"
              dir="ltr"
              value={draft.phone}
              onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
            />
          </Field>
          <Field id="staff-title" label="staff.jobTitle">
            <Input
              id="staff-title"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </Field>
          <ErrorNote error={save.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function StaffRow({
  row,
  ownerTools,
  onRoles,
  onProfile,
}: {
  row: StaffRowDto;
  ownerTools: boolean;
  onRoles: () => void;
  onProfile: () => void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshStaff();
  const me = useMe().data?.user.id;
  const toggle = useMutation({
    mutationFn: (action: 'disable' | 'enable') =>
      sendJson('POST', `/api/users/${row.user_id}/${action}`),
    onSuccess: refresh,
  });
  const status = row.user_status ?? row.staff_status;
  return (
    <li className="flex flex-col gap-2 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{row.name || row.email}</span>
        {status && (
          <Badge variant={status === 'disabled' || status === 'left' ? 'destructive' : 'outline'}>
            {t(`staff.statuses.${status}`)}
          </Badge>
        )}
        {row.roles.map((r) => (
          <Badge key={r}>{t(`staff.roles.${r}`)}</Badge>
        ))}
        {!row.user_id && <Badge variant="outline">{t('staff.noLogin')}</Badge>}
      </div>
      <div className="flex flex-wrap gap-x-3 text-sm text-muted-foreground">
        {row.email && <bdi>{row.email}</bdi>}
        {row.phone && <Num>{formatPkPhone(row.phone)}</Num>}
        {row.title && <span>{row.title}</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={onProfile}>
          {row.staff_id ? t('staff.editProfile') : t('staff.addProfile')}
        </Button>
        {ownerTools && row.user_id && (
          <>
            <Button size="sm" variant="outline" onClick={onRoles}>
              {t('staff.editRoles')}
            </Button>
            {row.user_id !== me && (
              <Button
                size="sm"
                variant="outline"
                disabled={toggle.isPending}
                onClick={() => toggle.mutate(row.user_status === 'disabled' ? 'enable' : 'disable')}
              >
                {row.user_status === 'disabled' ? t('staff.enable') : t('staff.disable')}
              </Button>
            )}
          </>
        )}
      </div>
      <ErrorNote error={toggle.error} />
    </li>
  );
}

export function StaffList() {
  const { t } = useTranslation();
  const roles = useRoles();
  const staff = useStaff();
  const [rolesFor, setRolesFor] = useState<StaffRowDto | null>(null);
  const [profileFor, setProfileFor] = useState<
    StaffRowDto | { user_id: null; name: string } | null
  >(null);
  const items = staff.data?.items ?? [];
  return (
    <div className="flex flex-col gap-3">
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('staff.empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {items.map((row) => (
            <StaffRow
              key={row.staff_id ?? row.user_id}
              row={row}
              ownerTools={canManageRoles(roles)}
              onRoles={() => setRolesFor(row)}
              onProfile={() => setProfileFor(row)}
            />
          ))}
        </ul>
      )}
      <Button
        variant="outline"
        className="self-start"
        onClick={() => setProfileFor({ user_id: null, name: '' })}
      >
        {t('staff.addProfile')}
      </Button>
      {rolesFor && <RolesDialog row={rolesFor} onClose={() => setRolesFor(null)} />}
      {profileFor && <ProfileDialog row={profileFor} onClose={() => setProfileFor(null)} />}
    </div>
  );
}
