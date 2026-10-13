import type { GuideSection, L } from './types';

/**
 * The guide's own words (headings, buttons, tour card). They live here, not in the i18n
 * dictionaries, so they ride in the guide's lazy chunk and never in the first load.
 */
export const GUIDE_UI = {
  title: { en: 'Help & guide', ur: 'رہنمائی' },
  intro: {
    en: 'Short, step-by-step help for the work you do in Maktab. Press "Show me" on a task and the app points to each button on the real screen.',
    ur: 'مکتب میں روز کے کام، قدم بہ قدم۔ کسی کام پر "مجھے دکھائیں" دبائیں تو ایپ اصل اسکرین پر ہر بٹن خود دکھائے گی۔',
  },
  startHere: { en: 'Start here', ur: 'یہاں سے شروع کریں' },
  steps: { en: 'Steps', ur: 'طریقہ' },
  mistakes: { en: 'Common mistakes', ur: 'عام غلطیاں' },
  open: { en: 'Open the screen', ur: 'اسکرین کھولیں' },
  showMe: { en: 'Show me', ur: 'مجھے دکھائیں' },
  showMeHint: {
    en: 'Highlights each button on the real screen, one at a time. Nothing is saved by the tour.',
    ur: 'اصل اسکرین پر ایک ایک کر کے بٹن دکھاتا ہے۔ اس دوران کچھ محفوظ نہیں ہوتا۔',
  },
  done: { en: 'Seen', ur: 'دیکھ لیا' },
  stepsCount: { en: '{{n}} steps', ur: '{{n}} قدم' },
  allTasks: { en: 'All help topics', ur: 'تمام موضوعات' },
  fullPage: { en: 'Open full page', ur: 'پورا صفحہ کھولیں' },
  close: { en: 'Close', ur: 'بند کریں' },
  notFound: {
    en: 'This help topic is not for your role.',
    ur: 'یہ موضوع آپ کے کام کا نہیں۔',
  },
  help: { en: 'Help for this screen', ur: 'اس اسکرین کی رہنمائی' },
  // Tour card
  next: { en: 'Next', ur: 'آگے' },
  back: { en: 'Back', ur: 'پیچھے' },
  skip: { en: 'Skip tour', ur: 'ٹور بند کریں' },
  finish: { en: 'Finish', ur: 'ختم' },
  counter: { en: 'Step {{i}} of {{n}}', ur: 'قدم {{i}} از {{n}}' },
  skipped: {
    en: 'A step was skipped: that part is not on this screen right now (it shows once there is data).',
    ur: 'ایک قدم چھوڑ دیا گیا: وہ حصہ ابھی اس اسکرین پر نہیں (ڈیٹا آنے پر نظر آتا ہے)۔',
  },
  waiting: {
    en: 'Waiting for you: do this on the screen, then the tour goes on.',
    ur: 'آپ کا انتظار ہے: اسکرین پر یہ کام کریں، پھر ٹور آگے چلے گا۔',
  },
  tourLabel: { en: 'Guided tour', ur: 'رہنما ٹور' },
} as const satisfies Record<string, L>;

export const GUIDE_SECTIONS: readonly GuideSection[] = [
  {
    id: 'start',
    title: { en: 'Getting started', ur: 'شروعات' },
    blurb: {
      en: 'The first week, in order. Do these once.',
      ur: 'پہلا ہفتہ، ترتیب سے۔ یہ کام ایک بار کرنے ہیں۔',
    },
  },
  {
    id: 'daily',
    title: { en: 'Every day', ur: 'روزانہ' },
    blurb: {
      en: 'Attendance in the morning, messages after.',
      ur: 'صبح حاضری، پھر پیغامات۔',
    },
  },
  {
    id: 'office',
    title: { en: 'At the office', ur: 'دفتر میں' },
    blurb: {
      en: 'Admissions, fees at the counter, the cash drawer.',
      ur: 'داخلے، کاؤنٹر پر فیس، کیش دراز۔',
    },
  },
  {
    id: 'month',
    title: { en: 'Month-end', ur: 'مہینے کا اختتام' },
    blurb: {
      en: 'Bill the month, fines, reminders, and how the month went.',
      ur: 'مہینے کی فیس، جرمانے، یاد دہانی، اور مہینے کا حساب۔',
    },
  },
  {
    id: 'parents',
    title: { en: 'Parents', ur: 'والدین' },
    blurb: {
      en: "Each family's private page, without a login.",
      ur: 'ہر خاندان کا اپنا نجی صفحہ، بغیر لاگ اِن کے۔',
    },
  },
  {
    id: 'staff',
    title: { en: 'Staff', ur: 'عملہ' },
    blurb: {
      en: 'Who can sign in, what they can do, and pay.',
      ur: 'کون سائن اِن کرے، کیا کرے، اور تنخواہ۔',
    },
  },
  {
    id: 'safe',
    title: { en: 'Keeping data safe', ur: 'ڈیٹا کی حفاظت' },
    blurb: {
      en: 'Backups, the restore drill, and your own copy.',
      ur: 'بیک اپ، ریسٹور کی مشق، اور اپنی کاپی۔',
    },
  },
  {
    id: 'phone',
    title: { en: 'Phone tips', ur: 'فون کے لیے' },
    blurb: {
      en: 'Install, work offline, print, hand off to WhatsApp.',
      ur: 'انسٹال، بغیر انٹرنیٹ کام، پرنٹ، واٹس ایپ۔',
    },
  },
];
