export const LANGUAGES = ['en', 'ur'] as const;
export type Language = (typeof LANGUAGES)[number];

export const DIRECTION: Record<Language, 'ltr' | 'rtl'> = { en: 'ltr', ur: 'rtl' };

/** English is the source of truth for keys; every other language must match its shape. */
export const en = {
  app: { name: 'Maktab', tagline: 'School and academy management' },
  nav: {
    dashboard: 'Dashboard',
    students: 'Students',
    attendance: 'Attendance',
    fees: 'Fees',
    settings: 'Settings',
    menu: 'Menu',
  },
  auth: {
    signIn: 'Sign in',
    signInWithGoogle: 'Sign in with Google',
    signOut: 'Sign out',
    inviteOnly: 'Only staff invited by the school can sign in.',
    failed: 'Sign-in failed. Ask the school owner to invite your Google email.',
  },
  common: {
    language: 'Language',
    loading: 'Loading…',
    comingSoon: 'Coming in a later milestone.',
    error: 'Something went wrong.',
    retry: 'Try again',
  },
  settings: {
    title: 'Settings',
    account: 'Your account',
    email: 'Email',
    name: 'Name',
    roles: 'Roles',
    status: 'Status',
  },
} as const;

type Shape<T> = { readonly [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };
export type Messages = Shape<typeof en>;

export const ur: Messages = {
  app: { name: 'مکتب', tagline: 'اسکول اور اکیڈمی کا انتظام' },
  nav: {
    dashboard: 'ڈیش بورڈ',
    students: 'طلبہ',
    attendance: 'حاضری',
    fees: 'فیس',
    settings: 'ترتیبات',
    menu: 'مینو',
  },
  auth: {
    signIn: 'سائن اِن',
    signInWithGoogle: 'گوگل کے ساتھ سائن اِن کریں',
    signOut: 'سائن آؤٹ',
    inviteOnly: 'صرف وہی عملہ سائن اِن کر سکتا ہے جسے اسکول نے مدعو کیا ہو۔',
    failed: 'سائن اِن ناکام۔ اسکول کے مالک سے کہیں کہ آپ کا گوگل ای میل مدعو کریں۔',
  },
  common: {
    language: 'زبان',
    loading: 'لوڈ ہو رہا ہے…',
    comingSoon: 'یہ اگلے مرحلے میں آئے گا۔',
    error: 'کچھ غلط ہو گیا۔',
    retry: 'دوبارہ کوشش کریں',
  },
  settings: {
    title: 'ترتیبات',
    account: 'آپ کا اکاؤنٹ',
    email: 'ای میل',
    name: 'نام',
    roles: 'کردار',
    status: 'حیثیت',
  },
};

type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Every valid translation key, e.g. "nav.fees". */
export type I18nKey = Leaves<typeof en>;
