import type { StaffRole } from '@maktab/shared';
import { Wand2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { BackupPanel } from '@/components/backup/BackupPanel';
import { AboutPanel, RecycleBin, Retention } from '@/components/backup/DataPanel';
import { FeeSetup } from '@/components/fees/setup';
import { MessageSettings } from '@/components/messages/MessageSettings';
import { AttendanceSettingsForm, HolidaysEditor } from '@/components/setup/attendance';
import { CustomFieldsEditor } from '@/components/setup/customFields';
import { GroupsEditor } from '@/components/setup/groups';
import { ProgrammesEditor, SeedLadderButton, SubjectsEditor } from '@/components/setup/programmes';
import { LogoUpload, SchoolForm } from '@/components/setup/school';
import { SessionForm, SessionsList } from '@/components/setup/sessions';
import { InviteForm, StaffList } from '@/components/setup/staff';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableRow } from '@/components/ui/table';
import { useMe } from '@/lib/api';
import { canManageBackup } from '@/lib/backup';
import { canManageTemplates } from '@/lib/messages';
import { useCurrentSession, useSchool } from '@/lib/queries';
import { canManageRoles, canManageSettings } from '@/lib/roles';
import { cn } from '@/lib/utils';

const SECTIONS = [
  'account',
  'school',
  'sessions',
  'programmes',
  'groups',
  'staff',
  'customFields',
  'attendance',
  'fees',
  'messages',
  'data',
  'backup',
  'about',
] as const;
type Section = (typeof SECTIONS)[number];

/**
 * owner: everything; admin: everything except roles/invite/disable (hidden inside Staff) and Backup;
 * accountant: "settings-lite" = account + read-only school profile; teacher: account only.
 * About is for everyone.
 */
export function visibleSections(roles: readonly StaffRole[]): Section[] {
  if (canManageSettings(roles))
    return SECTIONS.filter(
      (s) =>
        (s !== 'messages' || canManageTemplates(roles)) &&
        (s !== 'backup' || canManageBackup(roles)),
    );
  if (roles.includes('accountant')) return ['account', 'school', 'about'];
  return ['account', 'about'];
}

function AccountCard() {
  const { t } = useTranslation();
  const { data } = useMe();
  if (!data) return null;
  const rows: [string, string][] = [
    [t('settings.name'), data.user.name || '—'],
    [t('settings.email'), data.user.email],
    [t('settings.roles'), data.roles.map((r) => t(`staff.roles.${r}`)).join('، ')],
    [t('settings.status'), t(`staff.statuses.${data.user.status}`)],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.account')}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableBody>
            {rows.map(([label, value]) => (
              <TableRow key={label}>
                <TableHead>{label}</TableHead>
                {/* Emails are Latin; isolate them inside Urdu text. */}
                <TableCell>
                  <bdi>{value}</bdi>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  const roles = useMe().data?.roles ?? [];
  const school = useSchool();
  const current = useCurrentSession();
  const sections = visibleSections(roles);
  const [params] = useSearchParams();
  const wanted = params.get('section') as Section | null;
  const [active, setActive] = useState<Section>(
    wanted && (SECTIONS as readonly string[]).includes(wanted) ? wanted : 'account',
  );
  const shown = sections.includes(active) ? active : 'account';
  const manage = canManageSettings(roles);

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">{t('settings.title')}</h1>
        {roles.includes('owner') && (
          <Button asChild variant="outline" size="sm" className="ms-auto">
            <Link to="/setup">
              <Wand2 aria-hidden />
              {t('setup.runAgain')}
            </Link>
          </Button>
        )}
      </div>
      {sections.length > 1 && (
        // Wraps instead of scrolling: at 360 px (and in longer Urdu labels) every tab, Staff
        // included, stays visible without a hidden overflow.
        <div role="tablist" className="flex flex-wrap gap-1 border-b pb-1">
          {sections.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={s === shown}
              onClick={() => setActive(s)}
              className={cn(
                'min-h-11 shrink-0 rounded-md px-3 text-sm font-medium hover:bg-accent',
                s === shown && 'bg-accent text-accent-foreground',
              )}
            >
              {t(`settings.sections.${s}`)}
            </button>
          ))}
        </div>
      )}

      {shown === 'account' && <AccountCard />}
      {shown === 'school' && school.data && (
        <Section title={t('school.title')}>
          <SchoolForm school={school.data.school} readOnly={!manage} />
          {manage && <LogoUpload school={school.data.school} />}
        </Section>
      )}
      {shown === 'sessions' && (
        <Section title={t('session.title')}>
          <SessionsList />
          <SessionForm />
        </Section>
      )}
      {shown === 'programmes' && (
        <Section title={t('programme.title')}>
          <SeedLadderButton />
          <ProgrammesEditor />
          <SubjectsEditor />
        </Section>
      )}
      {shown === 'groups' && (
        <Section title={t('group.title')}>
          <GroupsEditor sessionId={current?.id ?? null} />
        </Section>
      )}
      {shown === 'staff' && (
        <Section title={t('staff.title')}>
          {canManageRoles(roles) && <InviteForm />}
          <StaffList />
        </Section>
      )}
      {shown === 'attendance' && school.data?.school && (
        <Section title={t('settings.sections.attendance')}>
          <AttendanceSettingsForm school={school.data.school} />
          <HolidaysEditor />
        </Section>
      )}
      {shown === 'fees' && (
        <Section title={t('fee.setup.title')}>
          <FeeSetup />
        </Section>
      )}
      {shown === 'messages' && (
        <Section title={t('msg.settings.title')}>
          <MessageSettings />
        </Section>
      )}
      {shown === 'data' && (
        <Section title={t('settings.sections.data')}>
          <RecycleBin />
          <Retention />
          {sections.includes('messages') && (
            <div className="flex flex-col gap-1">
              <p className="text-sm text-muted-foreground">{t('backup.templatesLink')}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => setActive('messages')}
              >
                {t('backup.openTemplates')}
              </Button>
            </div>
          )}
        </Section>
      )}
      {shown === 'backup' && (
        <Section title={t('settings.sections.backup')}>
          <BackupPanel />
        </Section>
      )}
      {shown === 'about' && (
        <Section title={t('backup.about.title')}>
          <AboutPanel />
        </Section>
      )}
      {shown === 'customFields' && (
        <Section title={t('customField.title')}>
          <CustomFieldsEditor />
        </Section>
      )}
    </section>
  );
}
