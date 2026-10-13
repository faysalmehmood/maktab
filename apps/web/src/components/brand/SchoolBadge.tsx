import {
  BRAND_COLORS,
  badgeFontSize,
  badgeLetters,
  brandColor,
  SHORT_NAME_MAX,
  suggestShortName,
} from '@maktab/shared';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/**
 * The school's generated badge (M7b, UI plan §6.2): a white roundel with a ring and the short name
 * in the school colour. Same drawing as `badgeSvg` in @maktab/shared (the parent page and print
 * get that one from the API). Decorative unless `label` is given.
 */
export function SchoolBadge({
  shortName,
  name,
  color,
  size = 36,
  label,
  maxLetters,
  className,
}: {
  shortName?: string | null;
  name?: string | null;
  color?: string | null;
  size?: number;
  label?: string;
  /** Small badges (the phone top bar, 32 px) draw at most 3 letters so they stay legible. */
  maxLetters?: number;
  className?: string;
}) {
  const letters = badgeLetters(shortName, name).slice(0, maxLetters ?? SHORT_NAME_MAX);
  const col = BRAND_COLORS[brandColor(color)].light.brand;
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative unless labelled (then it has a <title>)
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={cn('shrink-0', className)}
      data-badge={letters}
      data-color={brandColor(color)}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {label && <title>{label}</title>}
      <circle cx="32" cy="32" r="31" fill="#fff" />
      <circle cx="32" cy="32" r="26.5" fill="none" stroke={col} strokeWidth="2.5" />
      <text
        x="32"
        y="33"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="system-ui,-apple-system,'Segoe UI',Roboto,sans-serif"
        fontWeight="700"
        fontSize={badgeFontSize(letters)}
        fill={col}
      >
        {letters}
      </text>
    </svg>
  );
}

export type IdentityLike = {
  name: string;
  short_name?: string | null;
  brand_color?: string | null;
};

/**
 * The school's mark: its uploaded logo on a white roundel, else the generated badge. `logoSrc` is
 * the caller's (session route for staff, the public identity route on the sign-in page).
 */
export function SchoolMark({
  school,
  logoSrc,
  size = 36,
  maxLetters,
  className,
}: {
  school: IdentityLike;
  logoSrc?: string | null;
  size?: number;
  maxLetters?: number;
  className?: string;
}) {
  if (logoSrc)
    return (
      <span
        className={cn(
          'grid shrink-0 place-items-center overflow-hidden rounded-full bg-white',
          className,
        )}
        style={{ width: size, height: size }}
      >
        <img
          src={logoSrc}
          alt=""
          width={size}
          height={size}
          className="size-[86%] object-contain"
          data-logo
        />
      </span>
    );
  return (
    <SchoolBadge
      shortName={school.short_name}
      name={school.name}
      color={school.brand_color}
      size={size}
      maxLetters={maxLetters}
      className={className}
    />
  );
}

/**
 * The school on the phone's top bar (UI plan §6.4): the mark at 32 px (badge capped at 3 letters),
 * the short name, and the city when the screen has room for it (≥ 400 px). The setup wizard's
 * preview draws the same thing.
 */
export function SchoolChip({
  school,
  logoSrc,
  city,
}: {
  school: IdentityLike;
  logoSrc?: string | null;
  city?: string | null;
}) {
  const short =
    (school.short_name ?? '').toUpperCase() || suggestShortName(school.name) || school.name;
  return (
    <span className="flex min-w-0 items-center gap-2" data-school-chip>
      <SchoolMark school={school} logoSrc={logoSrc} size={32} maxLetters={3} />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-sm font-bold">
          <bdi>{short}</bdi>
        </span>
        {city && (
          <span className="hidden truncate text-meta text-muted-foreground min-[25rem]:block">
            <bdi>{city}</bdi>
          </span>
        )}
      </span>
    </span>
  );
}

/** The Maktab mark (takhti with meem), for the "Runs on Maktab" line. */
export function MaktabMark({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 512 512" width={size} height={size} className={className} aria-hidden>
      <rect width="512" height="512" rx="112" fill="#0f766e" />
      <path
        fill="#fff"
        d="M256 64a36 36 0 0 1 36 36v36h68a32 32 0 0 1 32 32v248a32 32 0 0 1-32 32H152a32 32 0 0 1-32-32V168a32 32 0 0 1 32-32h68v-36a36 36 0 0 1 36-36z"
      />
      <g fill="none" stroke="#0f766e" strokeWidth="44" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="304" cy="262" r="48" />
        <path d="M256 262v54a56 56 0 0 1-56 56h-26" />
      </g>
    </svg>
  );
}

/** "Runs on Maktab": the maker's mark, small and quiet (UI plan §6.6). */
export function RunsOnMaktab({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <p className={cn('flex items-center gap-1.5 text-meta', className)}>
      <MaktabMark />
      <span>{t('brand.runsOn')}</span>
    </p>
  );
}

/**
 * The school's mark on paper (A5 receipt, payslip): the logo has its own <img>; this is the badge
 * for a school without one, sized by `.receipt-badge` in styles.css (same box as the logo).
 */
export function PrintBadge({ school }: { school: IdentityLike | null | undefined }) {
  if (!school) return null;
  return (
    <SchoolBadge
      shortName={school.short_name}
      name={school.name}
      color={school.brand_color}
      className="receipt-badge"
    />
  );
}
