import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableRow } from '@/components/ui/table';
import { useMe } from '@/lib/api';

/** Milestone 0: shows what /api/me returns, proving session + permission wiring end to end. */
export function SettingsPage() {
  const { t } = useTranslation();
  const { data } = useMe();
  if (!data) return null;
  const rows: [string, string][] = [
    [t('settings.name'), data.user.name || '—'],
    [t('settings.email'), data.user.email],
    [t('settings.roles'), data.roles.join(', ')],
    [t('settings.status'), data.user.status],
  ];
  return (
    <section className="flex max-w-xl flex-col gap-4">
      <h1 className="text-xl font-semibold">{t('settings.title')}</h1>
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
                  {/* Emails and role codes are Latin; isolate them inside Urdu text. */}
                  <TableCell>
                    <bdi>{value}</bdi>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </section>
  );
}
