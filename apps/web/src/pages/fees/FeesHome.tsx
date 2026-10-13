import type { I18nKey, StaffRole } from '@maktab/shared';
import {
  BadgePercent,
  BookOpenCheck,
  CalendarPlus,
  HandCoins,
  HeartHandshake,
  type LucideIcon,
  ReceiptText,
  TableProperties,
  UserX,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { FeesTabs } from '@/components/fees/FeesTabs';
import { Page, PageHeader } from '@/components/page';
import { canCollect, canGenerate, canReadFees, canReadMoney, canUseCash } from '@/lib/fees';
import { useRoles } from '@/lib/roles';

type Tile = {
  to: string;
  label: I18nKey;
  hint: I18nKey;
  icon: LucideIcon;
  show: (r: readonly StaffRole[]) => boolean;
};

export const FEE_TILES: Tile[] = [
  {
    to: '/fees/counter',
    label: 'fee.nav.counter',
    hint: 'fee.hub.counter',
    icon: HandCoins,
    show: canCollect,
  },
  {
    to: '/fees/defaulters',
    label: 'fee.nav.defaulters',
    hint: 'fee.hub.defaulters',
    icon: UserX,
    show: canReadFees,
  },
  {
    to: '/fees/billing',
    label: 'fee.nav.billing',
    hint: 'fee.hub.billing',
    icon: CalendarPlus,
    show: canGenerate,
  },
  { to: '/cash', label: 'fee.nav.cash', hint: 'fee.hub.cash', icon: ReceiptText, show: canUseCash },
  {
    to: '/fees/concessions',
    label: 'fee.nav.concessions',
    hint: 'fee.hub.concessions',
    icon: BadgePercent,
    show: canReadMoney,
  },
  {
    to: '/fees/sponsors',
    label: 'fee.nav.sponsors',
    hint: 'fee.hub.sponsors',
    icon: HeartHandshake,
    show: canReadMoney,
  },
  {
    to: '/fees/register',
    label: 'fee.nav.register',
    hint: 'fee.hub.register',
    icon: TableProperties,
    show: canReadMoney,
  },
  {
    to: '/cash#collection-report',
    label: 'fee.nav.collection',
    hint: 'fee.hub.collection',
    icon: BookOpenCheck,
    show: canReadMoney,
  },
];

/** /fees: every fee screen this role can open (PLAN §3: the accountant's main screens). */
export function FeesHome() {
  const { t } = useTranslation();
  const roles = useRoles();
  return (
    <Page>
      <PageHeader title={t('fee.nav.home')} />
      <FeesTabs />
      <ul className="grid gap-3 sm:grid-cols-2">
        {FEE_TILES.filter((x) => x.show(roles)).map(({ to, label, hint, icon: Icon }) => (
          <li key={to}>
            <Link
              to={to}
              className="flex min-h-11 items-start gap-3 rounded-xl border bg-card p-4 hover:bg-accent"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">
                <Icon className="size-5" aria-hidden />
              </span>
              <span className="flex flex-col">
                <span className="font-semibold">{t(label)}</span>
                <span className="text-sm text-muted-foreground">{t(hint)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Page>
  );
}
