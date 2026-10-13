import { TASK_ROLES } from './audience';
import type { GuideTask } from './types';

/* Month-end, parents, staff, keeping data safe, phone tips. */

export const TASKS_B: readonly GuideTask[] = [
  {
    id: 'generate-fees',
    section: 'month',
    roles: TASK_ROLES['generate-fees'],
    title: { en: "Generate the month's fees", ur: 'مہینے کی فیس بنائیں' },
    summary: {
      en: 'One button bills every class for the month. It also runs by itself on the 1st.',
      ur: 'ایک بٹن سے ہر کلاس کی مہینے کی فیس بن جاتی ہے۔ یکم کو یہ خود بھی چلتا ہے۔',
    },
    steps: [
      {
        to: '/fees/billing',
        text: {
          en: '[[nav.fees]] → [[fee.nav.billing]]. Choose the [[fee.billing.period]].',
          ur: '[[nav.fees]] → [[fee.nav.billing]]۔ [[fee.billing.period]] چنیں۔',
        },
      },
      {
        text: {
          en: 'Press [[fee.billing.preview]] and check the counts per class.',
          ur: '[[fee.billing.preview]] دبائیں اور ہر کلاس کی گنتی دیکھیں۔',
        },
      },
      {
        text: {
          en: 'Press [[fee.billing.generate]] and confirm. Pressing it twice never bills twice.',
          ur: '[[fee.billing.generate]] دبا کر تصدیق کریں۔ دو بار دبانے سے دو بار فیس نہیں لگتی۔',
        },
      },
      {
        text: {
          en: 'A class under [[fee.billing.reopenTitle]] had no rate. Add the rate in [[nav.settings]] → [[settings.sections.fees]], press [[fee.billing.reopen]], then [[fee.billing.generate]] again.',
          ur: '[[fee.billing.reopenTitle]] والی کلاس کا ریٹ نہیں تھا۔ [[nav.settings]] → [[settings.sections.fees]] میں ریٹ لکھیں، [[fee.billing.reopen]] دبائیں، پھر دوبارہ [[fee.billing.generate]]۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Changing a rate by editing it: rates are never edited. Add a new rate from a date; old months keep the old rate.',
        ur: 'ریٹ میں ترمیم کرنا: ریٹ بدلا نہیں جاتا۔ کسی تاریخ سے نیا ریٹ لگائیں؛ پرانے مہینے پرانے ریٹ پر رہتے ہیں۔',
      },
      {
        en: 'Skipping [[fee.billing.preview]]: you miss a class with no rate until parents ask.',
        ur: '[[fee.billing.preview]] نہ دیکھنا: بغیر ریٹ والی کلاس کا پتا تب چلتا ہے جب والدین پوچھیں۔',
      },
    ],
    links: [
      { to: '/fees/billing', label: { en: '[[fee.nav.billing]]', ur: '[[fee.nav.billing]]' } },
    ],
    tour: [
      {
        path: '/fees/billing',
        target: 'billing-month',
        title: { en: 'The month', ur: 'مہینہ' },
        body: {
          en: 'Choose the month. The badge says whether it is billed already.',
          ur: 'مہینہ چنیں۔ نشان بتاتا ہے کہ فیس پہلے بن چکی یا نہیں۔',
        },
      },
      {
        path: '/fees/billing',
        target: 'billing-preview',
        title: { en: '[[fee.billing.preview]]', ur: '[[fee.billing.preview]]' },
        body: {
          en: 'Shows what will be billed. Nothing is saved yet.',
          ur: 'دکھاتا ہے کیا بنے گا۔ ابھی کچھ محفوظ نہیں ہوتا۔',
        },
      },
      {
        path: '/fees/billing',
        target: 'billing-generate',
        title: { en: '[[fee.billing.generate]]', ur: '[[fee.billing.generate]]' },
        body: {
          en: 'Bills the month after you confirm. Safe to press again.',
          ur: 'تصدیق کے بعد مہینے کی فیس بنا دیتا ہے۔ دوبارہ دبانا محفوظ ہے۔',
        },
      },
    ],
  },

  {
    id: 'apply-fines',
    section: 'month',
    roles: TASK_ROLES['apply-fines'],
    title: { en: 'Apply late fines', ur: 'لیٹ جرمانہ لگائیں' },
    summary: {
      en: 'After the fine day, add the late fine to unpaid tuition.',
      ur: 'جرمانے کے دن کے بعد، ادا نہ ہونے والی ٹیوشن پر جرمانہ۔',
    },
    steps: [
      {
        to: '/settings?section=fees',
        text: {
          en: 'Once: in [[nav.settings]] → [[settings.sections.fees]] set the late fine (on/off, the day of the month, fixed or percent, optional cap).',
          ur: 'ایک بار: [[nav.settings]] → [[settings.sections.fees]] میں لیٹ جرمانہ طے کریں (آن/آف، مہینے کا دن، مقررہ یا فیصد، حد)۔',
        },
      },
      {
        to: '/fees/billing',
        text: {
          en: '[[fee.nav.billing]] → [[fee.billing.finesPreview]] shows who will be fined and how much.',
          ur: '[[fee.nav.billing]] → [[fee.billing.finesPreview]] دکھاتا ہے کس پر کتنا جرمانہ لگے گا۔',
        },
      },
      {
        text: {
          en: 'Press [[fee.billing.finesApply]]. A fine can be waived at the [[fee.nav.counter]] by the owner or admin.',
          ur: '[[fee.billing.finesApply]] دبائیں۔ مالک یا ایڈمن [[fee.nav.counter]] پر جرمانہ معاف کر سکتا ہے۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Fining before the fine day: nothing is planned yet, and that is correct.',
        ur: 'جرمانے کے دن سے پہلے لگانا: تب کچھ نہیں بنتا، اور یہ درست ہے۔',
      },
      {
        en: "Sponsored shares are never fined; only the family's part is.",
        ur: 'اسپانسر کے حصے پر کبھی جرمانہ نہیں لگتا؛ صرف خاندان کے حصے پر۔',
      },
    ],
    links: [
      { to: '/fees/billing', label: { en: '[[fee.nav.billing]]', ur: '[[fee.nav.billing]]' } },
    ],
    tour: [
      {
        path: '/fees/billing',
        target: 'billing-fines',
        title: { en: 'Late fines', ur: 'لیٹ جرمانہ' },
        body: {
          en: 'Fines live next to the month, on the same screen.',
          ur: 'جرمانے اسی اسکرین پر مہینے کے ساتھ ہیں۔',
        },
      },
      {
        path: '/fees/billing',
        target: 'fines-preview',
        title: { en: '[[fee.billing.finesPreview]]', ur: '[[fee.billing.finesPreview]]' },
        body: {
          en: 'See the list first; [[fee.billing.finesApply]] appears when there is something to fine.',
          ur: 'پہلے فہرست دیکھیں؛ کچھ لگانا ہو تو [[fee.billing.finesApply]] نظر آئے گا۔',
        },
      },
    ],
  },

  {
    id: 'defaulters',
    section: 'month',
    roles: TASK_ROLES.defaulters,
    title: { en: 'Defaulters and reminders', ur: 'نادہندگان اور یاد دہانی' },
    summary: {
      en: 'Who owes past the due date, and one reminder per family.',
      ur: 'کس کی فیس مقررہ تاریخ سے لیٹ ہے، اور ہر خاندان کو ایک یاد دہانی۔',
    },
    steps: [
      {
        to: '/fees/defaulters',
        text: {
          en: '[[nav.fees]] → [[fee.nav.defaulters]]. Filter by class, months overdue or amount.',
          ur: '[[nav.fees]] → [[fee.nav.defaulters]]۔ کلاس، لیٹ مہینوں یا رقم سے چھانٹیں۔',
        },
      },
      {
        text: {
          en: 'Press [[fee.defaulters.remindAll]]. One message per family goes to the send queue; families reminded in the last few days are skipped.',
          ur: '[[fee.defaulters.remindAll]] دبائیں۔ ہر خاندان کا ایک پیغام قطار میں جاتا ہے؛ حال ہی میں یاد دلائے گئے خاندان چھوڑ دیے جاتے ہیں۔',
        },
      },
      {
        text: {
          en: 'Then send them from [[shell.nav.messages]] as usual. [[fee.defaulters.print]] gives class teachers a paper copy.',
          ur: 'پھر معمول کے مطابق [[shell.nav.messages]] سے بھیجیں۔ [[fee.defaulters.print]] سے کلاس ٹیچر کو کاغذی فہرست دیں۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Expecting [[fee.defaulters.remindAll]] to send by itself: it only queues. Open [[shell.nav.messages]] to send.',
        ur: 'یہ سمجھنا کہ [[fee.defaulters.remindAll]] خود بھیج دے گا: یہ صرف قطار میں ڈالتا ہے۔ بھیجنے کے لیے [[shell.nav.messages]] کھولیں۔',
      },
      {
        en: "A sponsored child never makes the family a defaulter for the sponsor's share.",
        ur: 'اسپانسر والے بچے کا اسپانسر حصہ خاندان کو نادہندہ نہیں بناتا۔',
      },
    ],
    links: [
      {
        to: '/fees/defaulters',
        label: { en: '[[fee.nav.defaulters]]', ur: '[[fee.nav.defaulters]]' },
      },
    ],
    tour: [
      {
        path: '/fees/defaulters',
        target: 'def-filters',
        title: { en: 'Narrow the list', ur: 'فہرست چھوٹی کریں' },
        body: {
          en: 'One class, two months or more, above an amount.',
          ur: 'ایک کلاس، دو یا زیادہ مہینے، کسی رقم سے اوپر۔',
        },
      },
      {
        path: '/fees/defaulters',
        target: 'def-remind',
        title: { en: '[[fee.defaulters.remindAll]]', ur: '[[fee.defaulters.remindAll]]' },
        body: {
          en: 'Queues one reminder per family in their language.',
          ur: 'ہر خاندان کو اس کی زبان میں ایک یاد دہانی قطار میں ڈالتا ہے۔',
        },
      },
      {
        path: '/fees/defaulters',
        target: 'def-print',
        title: { en: '[[fee.defaulters.print]]', ur: '[[fee.defaulters.print]]' },
        body: { en: 'A paper list for class teachers.', ur: 'کلاس ٹیچر کے لیے کاغذی فہرست۔' },
      },
    ],
  },

  {
    id: 'income-expense',
    section: 'month',
    roles: TASK_ROLES['income-expense'],
    title: { en: 'Income vs expense', ur: 'آمدنی اور خرچ' },
    summary: {
      en: 'How the month went: fees in, expenses and salaries out.',
      ur: 'مہینہ کیسا رہا: فیس آئی، خرچ اور تنخواہیں گئیں۔',
    },
    steps: [
      {
        to: '/expenses',
        text: {
          en: 'During the month, record every expense in [[money.nav.expenses]] with category, amount and where it was paid from (drawer or bank). A bill photo helps.',
          ur: 'مہینے بھر ہر خرچ [[money.nav.expenses]] میں درج کریں: قسم، رقم، اور کہاں سے دیا (دراز یا بینک)۔ بل کی تصویر بہتر ہے۔',
        },
      },
      {
        to: '/reports/income-expense',
        text: {
          en: '[[money.nav.reports]] → [[money.reports.incomeExpense]]. Choose the months. You see income, expenses, salaries and the net.',
          ur: '[[money.nav.reports]] → [[money.reports.incomeExpense]]۔ مہینے چنیں۔ آمدنی، خرچ، تنخواہیں اور خالص بچت سامنے آئے گی۔',
        },
      },
      {
        text: {
          en: 'Every report prints and downloads as CSV for a spreadsheet.',
          ur: 'ہر رپورٹ پرنٹ ہوتی ہے اور اسپریڈشیٹ کے لیے CSV میں بھی آتی ہے۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Deleting a wrong expense: money is never deleted. Void it with a reason and enter it again.',
        ur: 'غلط خرچ مٹانا: پیسوں کا اندراج مٹتا نہیں۔ وجہ لکھ کر منسوخ کریں اور دوبارہ درج کریں۔',
      },
      {
        en: 'Counting a handover to the owner as an expense: it is a transfer, use [[fee.cash.transfer]].',
        ur: 'مالک کو دی گئی نقدی کو خرچ لکھنا: یہ منتقلی ہے، [[fee.cash.transfer]] استعمال کریں۔',
      },
    ],
    links: [
      {
        to: '/reports/income-expense',
        label: { en: '[[money.reports.incomeExpense]]', ur: '[[money.reports.incomeExpense]]' },
      },
      { to: '/expenses', label: { en: '[[money.nav.expenses]]', ur: '[[money.nav.expenses]]' } },
    ],
    tour: [
      {
        path: '/reports',
        target: 'reports-income-expense',
        click: true,
        title: { en: 'Reports', ur: 'رپورٹیں' },
        body: {
          en: 'All reports are here. Next opens income vs expense.',
          ur: 'تمام رپورٹیں یہاں ہیں۔ "آگے" سے آمدنی اور خرچ کھلے گی۔',
        },
      },
      {
        path: '/reports/income-expense',
        target: 'ie-range',
        title: { en: 'Choose the months', ur: 'مہینے چنیں' },
        body: {
          en: 'From and to; one month or a whole term.',
          ur: 'سے اور تک؛ ایک مہینہ یا پوری ٹرم۔',
        },
      },
      {
        path: '/reports/income-expense',
        target: 'ie-totals',
        wait: true,
        title: { en: 'The totals', ur: 'کل رقم' },
        body: {
          en: 'Income, expenses, salaries and the net for the months chosen.',
          ur: 'چنے گئے مہینوں کی آمدنی، خرچ، تنخواہیں اور خالص۔',
        },
      },
    ],
  },

  {
    id: 'parent-links',
    section: 'parents',
    roles: TASK_ROLES['parent-links'],
    title: {
      en: 'Create, renew or revoke a parent link',
      ur: 'والدین کا لنک: بنائیں، نیا کریں، بند کریں',
    },
    summary: {
      en: "Each guardian gets a private link to the family's page. No login.",
      ur: 'ہر سرپرست کو خاندان کے صفحے کا نجی لنک ملتا ہے۔ کوئی لاگ اِن نہیں۔',
    },
    steps: [
      {
        to: '/students',
        text: {
          en: 'Open the student. Under Guardians find [[msg.link.title]].',
          ur: 'طالب علم کھولیں۔ Guardians کے نیچے [[msg.link.title]] دیکھیں۔',
        },
      },
      {
        text: {
          en: "[[msg.link.create]]: choose the check before dues (school default, child's birth year, or a PIN), then [[msg.link.copy]] or [[msg.link.sendWa]]. It is shown only once.",
          ur: '[[msg.link.create]]: بقایا دکھانے سے پہلے کی جانچ چنیں (اسکول کی ترتیب، بچے کا سالِ پیدائش، یا PIN)، پھر [[msg.link.copy]] یا [[msg.link.sendWa]]۔ لنک صرف ایک بار دکھتا ہے۔',
        },
      },
      {
        text: {
          en: 'Phone lost or link forwarded? [[msg.link.rotate]]: the old one stops working at once.',
          ur: 'فون گم ہو گیا یا لنک آگے چلا گیا؟ [[msg.link.rotate]]: پرانا فوراً بند ہو جاتا ہے۔',
        },
      },
      {
        text: {
          en: '[[msg.link.revoke]] turns the link off with no replacement. [[msg.link.access]] shows when it was opened.',
          ur: '[[msg.link.revoke]] لنک بند کر دیتا ہے، نیا نہیں بنتا۔ [[msg.link.access]] بتاتا ہے کب کھولا گیا۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Sending the link in a class WhatsApp group: it is private to one family.',
        ur: 'لنک کلاس کے واٹس ایپ گروپ میں بھیجنا: یہ ایک خاندان کا نجی لنک ہے۔',
      },
      {
        en: 'Looking for an old link later: Maktab does not keep it. Make a [[msg.link.rotate]].',
        ur: 'پرانا لنک بعد میں ڈھونڈنا: مکتب اسے محفوظ نہیں رکھتا۔ [[msg.link.rotate]] بنائیں۔',
      },
    ],
    links: [{ to: '/students', label: { en: '[[nav.students]]', ur: '[[nav.students]]' } }],
    tour: [
      {
        path: '/students',
        target: 'students-list',
        title: { en: 'Open the student', ur: 'طالب علم کھولیں' },
        body: {
          en: 'Tap a child of the family. The tour waits for you.',
          ur: 'خاندان کے کسی بچے پر ٹیپ کریں۔ ٹور آپ کا انتظار کرے گا۔',
        },
      },
      {
        path: '/students/:id',
        target: 'parent-link',
        wait: true,
        title: { en: '[[msg.link.title]]', ur: '[[msg.link.title]]' },
        body: {
          en: '[[msg.link.create]], [[msg.link.rotate]] or [[msg.link.revoke]], for each guardian.',
          ur: 'ہر سرپرست کے لیے [[msg.link.create]]، [[msg.link.rotate]] یا [[msg.link.revoke]]۔',
        },
      },
    ],
  },

  {
    id: 'parent-view',
    section: 'parents',
    roles: TASK_ROLES['parent-view'],
    title: { en: 'What parents see', ur: 'والدین کو کیا نظر آتا ہے' },
    summary: {
      en: 'Attendance, dues, receipts and notices, in Urdu or English, with a Listen button.',
      ur: 'حاضری، بقایا، رسیدیں اور نوٹس، اردو یا انگریزی میں، سننے کے بٹن کے ساتھ۔',
    },
    steps: [
      {
        text: {
          en: "The link opens the family's page on the parent's phone, without a login.",
          ur: 'لنک والدین کے فون پر خاندان کا صفحہ کھولتا ہے، بغیر لاگ اِن کے۔',
        },
      },
      {
        text: {
          en: "Anyone with the link sees today's attendance, this month's attendance % and notices.",
          ur: 'لنک والا کوئی بھی آج کی حاضری، اس مہینے کی حاضری کا فیصد اور نوٹس دیکھ سکتا ہے۔',
        },
      },
      {
        text: {
          en: "Dues and receipts first ask a question: by default the birth year of one of the children (or the school's PIN). Five wrong answers lock it for 15 minutes.",
          ur: 'بقایا اور رسیدوں سے پہلے ایک سوال آتا ہے: عام طور پر کسی بچے کا سالِ پیدائش (یا اسکول کا PIN)۔ پانچ غلط جواب پر 15 منٹ کے لیے بند۔',
        },
      },
      {
        text: {
          en: 'The [[msg.parent.listen]] button reads the page aloud, for parents who prefer to hear it.',
          ur: '[[msg.parent.listen]] کا بٹن صفحہ پڑھ کر سناتا ہے، ان والدین کے لیے جو سننا پسند کریں۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Treating the birth-year check as a password: it only slows down a forwarded link.',
        ur: 'سالِ پیدائش کی جانچ کو پاس ورڈ سمجھنا: یہ صرف آگے بھیجے گئے لنک کو روکتی ہے۔',
      },
      {
        en: 'A parent says [[errors.gate_failed]]: check the date of birth on the student page.',
        ur: 'والدین کہیں [[errors.gate_failed]]: طالب علم کے صفحے پر تاریخ پیدائش دیکھیں۔',
      },
    ],
    links: [],
  },

  {
    id: 'invite-staff',
    section: 'staff',
    roles: TASK_ROLES['invite-staff'],
    title: { en: 'Invite staff', ur: 'عملے کو دعوت دیں' },
    summary: {
      en: 'Each person signs in with their own Google email after you invite it.',
      ur: 'دعوت کے بعد ہر شخص اپنے گوگل ای میل سے سائن اِن کرتا ہے۔',
    },
    steps: [
      {
        to: '/settings?section=staff',
        text: {
          en: '[[nav.settings]] → [[settings.sections.staff]]. In [[staff.invite]] type the [[staff.email]], name and role (and the groups for a teacher).',
          ur: '[[nav.settings]] → [[settings.sections.staff]]۔ [[staff.invite]] میں [[staff.email]]، نام اور کردار لکھیں (استاد کے لیے گروپ بھی)۔',
        },
      },
      {
        text: {
          en: 'Save. They sign in with that Google account; nobody else can.',
          ur: 'محفوظ کریں۔ وہ اسی گوگل اکاؤنٹ سے سائن اِن کریں گے؛ کوئی اور نہیں کر سکتا۔',
        },
      },
      {
        text: {
          en: 'Staff who never use the app (a guard on the payroll): [[staff.addProfile]].',
          ur: 'جو عملہ ایپ استعمال نہیں کرتا (تنخواہ والا چوکیدار): [[staff.addProfile]]۔',
        },
      },
      {
        text: {
          en: 'Someone leaves: disable them in the staff list. Their past entries stay.',
          ur: 'کوئی چھوڑ کر جائے: عملے کی فہرست میں بند کر دیں۔ پرانے اندراج محفوظ رہتے ہیں۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'A typo in the email: [[auth.inviteOnly]] Check it letter by letter.',
        ur: 'ای میل میں غلطی: [[auth.inviteOnly]] حرف بہ حرف دیکھیں۔',
      },
      {
        en: 'Sharing one account between two people: the audit log cannot tell who did what.',
        ur: 'دو لوگوں کا ایک اکاؤنٹ: آڈٹ لاگ میں پتا نہیں چلتا کس نے کیا کیا۔',
      },
    ],
    links: [
      {
        to: '/settings?section=staff',
        label: { en: '[[settings.sections.staff]]', ur: '[[settings.sections.staff]]' },
      },
    ],
    tour: [
      {
        path: '/settings',
        target: 'settings-tab-staff',
        click: true,
        title: { en: '[[settings.sections.staff]]', ur: '[[settings.sections.staff]]' },
        body: { en: 'Next opens the staff section.', ur: '"آگے" سے عملے کا حصہ کھلے گا۔' },
      },
      {
        path: '/settings',
        target: 'staff-invite',
        wait: true,
        title: { en: '[[staff.invite]]', ur: '[[staff.invite]]' },
        body: {
          en: 'Google email, name, role. They can sign in right after.',
          ur: 'گوگل ای میل، نام، کردار۔ اس کے فوراً بعد سائن اِن کر سکتے ہیں۔',
        },
      },
    ],
  },

  {
    id: 'roles',
    section: 'staff',
    roles: TASK_ROLES.roles,
    title: { en: 'Roles: who can do what', ur: 'کردار: کون کیا کر سکتا ہے' },
    summary: {
      en: '[[staff.roles.owner]], [[staff.roles.admin]], [[staff.roles.accountant]], [[staff.roles.teacher]]. Each sees only their work.',
      ur: '[[staff.roles.owner]]، [[staff.roles.admin]]، [[staff.roles.accountant]]، [[staff.roles.teacher]]۔ ہر ایک کو صرف اپنا کام نظر آتا ہے۔',
    },
    steps: [
      {
        text: {
          en: '[[staff.roles.owner]]: everything, including staff roles, backup and the audit log.',
          ur: '[[staff.roles.owner]]: سب کچھ، عملے کے کردار، بیک اپ اور آڈٹ لاگ سمیت۔',
        },
      },
      {
        text: {
          en: '[[staff.roles.admin]]: like the owner except roles, backup and the audit log. Bills fees, gives concessions, approves payslips, corrects registers.',
          ur: '[[staff.roles.admin]]: مالک جیسا، سوائے کردار، بیک اپ اور آڈٹ لاگ کے۔ فیس بناتا، رعایت دیتا، تنخواہ منظور کرتا، رجسٹر درست کرتا ہے۔',
        },
      },
      {
        text: {
          en: "[[staff.roles.accountant]]: students, fee counter, receipts, own cash drawer, expenses, payroll (not the owner's pay), messages. Cannot reverse receipts or bill the month.",
          ur: '[[staff.roles.accountant]]: طلبہ، فیس کاؤنٹر، رسیدیں، اپنا کیش دراز، خرچ، تنخواہیں (مالک کی نہیں)، پیغامات۔ رسید واپس یا مہینے کی فیس نہیں بنا سکتا۔',
        },
      },
      {
        text: {
          en: '[[staff.roles.teacher]]: own groups only: attendance, those students, absence messages, own payslips. No money.',
          ur: '[[staff.roles.teacher]]: صرف اپنے گروپ: حاضری، وہی طلبہ، غیر حاضری کے پیغام، اپنی تنخواہ کی پرچی۔ پیسوں تک رسائی نہیں۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Making the accountant an admin "to be safe": admins can bill and give concessions.',
        ur: 'احتیاطاً اکاؤنٹنٹ کو ایڈمن بنانا: ایڈمن فیس بنا اور رعایت دے سکتا ہے۔',
      },
      {
        en: 'Nobody approves their own payslip. An owner on the payroll needs a second [[staff.roles.owner]] or [[staff.roles.admin]].',
        ur: 'کوئی اپنی تنخواہ خود منظور نہیں کرتا۔ تنخواہ لینے والے مالک کو دوسرا [[staff.roles.owner]] یا [[staff.roles.admin]] چاہیے۔',
      },
    ],
    links: [
      {
        to: '/settings?section=staff',
        label: { en: '[[settings.sections.staff]]', ur: '[[settings.sections.staff]]' },
      },
    ],
  },

  {
    id: 'payslips',
    section: 'staff',
    roles: TASK_ROLES.payslips,
    title: { en: 'Payslips', ur: 'تنخواہ کی پرچیاں' },
    summary: {
      en: 'Prepare, check, approve, pay, print. Once a month.',
      ur: 'تیار کریں، دیکھیں، منظور کریں، ادا کریں، پرنٹ کریں۔ مہینے میں ایک بار۔',
    },
    steps: [
      {
        to: '/salary',
        text: {
          en: '[[shell.nav.payroll]]: choose the month and press [[money.salary.generate]].',
          ur: '[[shell.nav.payroll]]: مہینہ چنیں اور [[money.salary.generate]] دبائیں۔',
        },
      },
      {
        text: {
          en: 'Open each slip and check the lines: allowances, deductions, advance recovery.',
          ur: 'ہر پرچی کھول کر لائنیں دیکھیں: الاؤنس، کٹوتی، ایڈوانس کی واپسی۔',
        },
      },
      {
        text: {
          en: '[[money.salary.approve]] (owner or admin, never your own slip). Then [[money.salary.payButton]]: amount and the account it is paid from.',
          ur: '[[money.salary.approve]] (مالک یا ایڈمن، اپنی پرچی کبھی نہیں)۔ پھر [[money.salary.payButton]]: رقم اور جس اکاؤنٹ سے دی۔',
        },
      },
      {
        text: {
          en: '[[money.salary.printSlip]] for the staff member. Teachers see their own under [[money.nav.myPayslips]].',
          ur: 'ملازم کے لیے [[money.salary.printSlip]]۔ اساتذہ اپنی پرچی [[money.nav.myPayslips]] میں دیکھتے ہیں۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Paying salary as an expense: use [[money.salary.payButton]] on the slip, so the salary register stays right.',
        ur: 'تنخواہ کو خرچ میں لکھنا: پرچی پر [[money.salary.payButton]] استعمال کریں تاکہ تنخواہ رجسٹر درست رہے۔',
      },
      {
        en: 'Lines are frozen once approved: check before you approve.',
        ur: 'منظوری کے بعد لائنیں نہیں بدلتیں: پہلے دیکھ لیں۔',
      },
    ],
    links: [
      { to: '/salary', label: { en: '[[shell.nav.payroll]]', ur: '[[shell.nav.payroll]]' } },
      { to: '/advances', label: { en: '[[money.nav.advances]]', ur: '[[money.nav.advances]]' } },
    ],
    tour: [
      {
        path: '/salary',
        target: 'salary-month',
        title: { en: 'The month', ur: 'مہینہ' },
        body: { en: 'Pick the month to pay.', ur: 'جس مہینے کی تنخواہ دینی ہے وہ چنیں۔' },
      },
      {
        path: '/salary',
        target: 'salary-prepare',
        title: { en: '[[money.salary.generate]]', ur: '[[money.salary.generate]]' },
        body: {
          en: 'Makes a draft slip for every paid staff member. Safe to press again.',
          ur: 'ہر ملازم کی کچی پرچی بنا دیتا ہے۔ دوبارہ دبانا محفوظ ہے۔',
        },
      },
    ],
  },

  {
    id: 'my-payslips',
    section: 'staff',
    roles: TASK_ROLES['my-payslips'],
    title: { en: 'My payslips', ur: 'میری تنخواہ کی پرچیاں' },
    summary: {
      en: 'Your own approved slips, to view and print.',
      ur: 'آپ کی اپنی منظور شدہ پرچیاں، دیکھنے اور پرنٹ کے لیے۔',
    },
    steps: [
      {
        to: '/my/payslips',
        text: {
          en: 'Open [[money.nav.myPayslips]] from the menu (on the phone: [[shell.nav.more]]).',
          ur: 'مینو سے [[money.nav.myPayslips]] کھولیں (فون پر: [[shell.nav.more]])۔',
        },
      },
      {
        text: {
          en: 'Tap a month to see the lines, then [[money.salary.printSlip]] if you need paper.',
          ur: 'کسی مہینے پر ٹیپ کر کے لائنیں دیکھیں، کاغذ چاہیے تو [[money.salary.printSlip]]۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'A month is missing: it is not approved yet. Ask the office.',
        ur: 'کوئی مہینہ نظر نہیں آ رہا: ابھی منظور نہیں ہوا۔ دفتر سے پوچھیں۔',
      },
    ],
    links: [
      {
        to: '/my/payslips',
        label: { en: '[[money.nav.myPayslips]]', ur: '[[money.nav.myPayslips]]' },
      },
    ],
  },

  {
    id: 'backups',
    section: 'safe',
    roles: TASK_ROLES.backups,
    title: { en: 'Backups', ur: 'بیک اپ' },
    summary: {
      en: 'An encrypted copy every night, in two places. Check that it ran.',
      ur: 'ہر رات دو جگہ خفیہ کاپی۔ دیکھتے رہیں کہ بنی یا نہیں۔',
    },
    steps: [
      {
        to: '/settings?section=backup',
        text: {
          en: '[[nav.settings]] → [[settings.sections.backup]] → [[backup.status.title]] shows the last run (OK / Partial / Failed), its size and copies.',
          ur: '[[nav.settings]] → [[settings.sections.backup]] → [[backup.status.title]] میں آخری بیک اپ (OK / Partial / Failed)، سائز اور کاپیاں نظر آتی ہیں۔',
        },
      },
      {
        text: {
          en: 'It runs every night at 02:30 Pakistan time. Failed, or an alarm that backups have not run: tell the maintainer the same day.',
          ur: 'یہ ہر رات 02:30 (پاکستانی وقت) چلتا ہے۔ Failed ہو یا الارم آئے کہ بیک اپ نہیں بنا: اسی دن مینٹینر کو بتائیں۔',
        },
      },
      {
        text: {
          en: 'A wrong change noticed within 7 days can be undone by the maintainer; everything entered after that minute is typed in again from paper.',
          ur: '7 دن کے اندر پکڑی گئی غلطی مینٹینر واپس کر سکتا ہے؛ اس منٹ کے بعد کا سب کچھ کاغذ سے دوبارہ لکھنا ہو گا۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Ignoring the red banner on Home: it means the backup did not run.',
        ur: 'ہوم پر سرخ پٹی کو نظر انداز کرنا: اس کا مطلب بیک اپ نہیں بنا۔',
      },
      {
        en: 'Losing the backup key: the key is held by two trustees. Without it, no backup can be opened.',
        ur: 'بیک اپ کی چابی کھو دینا: چابی دو امانت داروں کے پاس ہے۔ اس کے بغیر کوئی بیک اپ نہیں کھلتا۔',
      },
    ],
    links: [
      {
        to: '/settings?section=backup',
        label: { en: '[[settings.sections.backup]]', ur: '[[settings.sections.backup]]' },
      },
    ],
    tour: [
      {
        path: '/settings',
        target: 'settings-tab-backup',
        click: true,
        title: { en: '[[settings.sections.backup]]', ur: '[[settings.sections.backup]]' },
        body: { en: 'Next opens the backup section.', ur: '"آگے" سے بیک اپ کا حصہ کھلے گا۔' },
      },
      {
        path: '/settings',
        target: 'backup-status',
        wait: true,
        title: { en: '[[backup.status.title]]', ur: '[[backup.status.title]]' },
        body: {
          en: 'The last run and where the copies are. OK is what you want to see.',
          ur: 'آخری بیک اپ اور کاپیاں کہاں ہیں۔ OK نظر آنا چاہیے۔',
        },
      },
      {
        path: '/settings',
        target: 'backup-drill',
        title: { en: '[[backup.status.kinds.drill]]', ur: '[[backup.status.kinds.drill]]' },
        body: {
          en: 'Once a term, with the maintainer. Record it here.',
          ur: 'ہر ٹرم میں ایک بار، مینٹینر کے ساتھ۔ یہاں درج کریں۔',
        },
      },
    ],
  },

  {
    id: 'restore-drill',
    section: 'safe',
    roles: TASK_ROLES['restore-drill'],
    title: { en: 'Restore drill', ur: 'ریسٹور کی مشق' },
    summary: {
      en: 'Once a term, prove the backup opens. Takes about an hour with the maintainer.',
      ur: 'ہر ٹرم ایک بار ثابت کریں کہ بیک اپ کھلتا ہے۔ مینٹینر کے ساتھ تقریباً ایک گھنٹہ۔',
    },
    steps: [
      {
        text: {
          en: 'Agree a time with the maintainer and one key trustee.',
          ur: 'مینٹینر اور چابی کے ایک امانت دار کے ساتھ وقت طے کریں۔',
        },
      },
      {
        text: {
          en: "The maintainer restores last night's backup into a test copy. You check a few things you know: a family's dues, last week's receipts, a register.",
          ur: 'مینٹینر کل رات کا بیک اپ ایک ٹیسٹ کاپی میں کھولتا ہے۔ آپ چند معلوم چیزیں دیکھیں: کسی خاندان کا بقایا، پچھلے ہفتے کی رسیدیں، کوئی رجسٹر۔',
        },
      },
      {
        to: '/settings?section=backup',
        text: {
          en: '[[nav.settings]] → [[settings.sections.backup]] → [[backup.drill.title]]: tick the steps, add a note, [[backup.drill.record]].',
          ur: '[[nav.settings]] → [[settings.sections.backup]] → [[backup.drill.title]]: قدموں پر نشان لگائیں، نوٹ لکھیں، [[backup.drill.record]]۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Skipping the drill because backups say OK: a backup nobody has opened is a guess.',
        ur: 'بیک اپ OK دیکھ کر مشق چھوڑ دینا: جو بیک اپ کبھی کھولا نہ گیا وہ صرف اندازہ ہے۔',
      },
    ],
    links: [
      {
        to: '/settings?section=backup',
        label: { en: '[[settings.sections.backup]]', ur: '[[settings.sections.backup]]' },
      },
    ],
  },

  {
    id: 'download-everything',
    section: 'safe',
    roles: TASK_ROLES['download-everything'],
    title: { en: 'Download everything', ur: 'سب کچھ ڈاؤن لوڈ کریں' },
    summary: {
      en: "Your own copy of all the school's data, once a month.",
      ur: 'اسکول کے سارے ڈیٹا کی اپنی کاپی، مہینے میں ایک بار۔',
    },
    steps: [
      {
        to: '/settings?section=backup',
        text: {
          en: '[[nav.settings]] → [[settings.sections.backup]] → [[backup.everything.start]]. Keep the page open until it says Saved.',
          ur: '[[nav.settings]] → [[settings.sections.backup]] → [[backup.everything.start]]۔ Saved آنے تک صفحہ کھلا رکھیں۔',
        },
      },
      {
        text: {
          en: 'You get one ZIP: a CSV file for every table (opens in Excel), the database structure and a README.',
          ur: 'ایک ZIP ملے گی: ہر ٹیبل کی CSV فائل (Excel میں کھلتی ہے)، ڈیٹابیس کا ڈھانچہ اور README۔',
        },
      },
      {
        text: {
          en: 'Keep it on a USB or a private drive, not in WhatsApp: it holds every family, phone number and CNIC.',
          ur: 'اسے USB یا نجی ڈرائیو میں رکھیں، واٹس ایپ میں نہیں: اس میں ہر خاندان، فون نمبر اور CNIC ہے۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Closing the tab while it prepares: the download stops. Start again.',
        ur: 'تیاری کے دوران ٹیب بند کرنا: ڈاؤن لوڈ رک جاتا ہے۔ دوبارہ شروع کریں۔',
      },
    ],
    links: [
      {
        to: '/settings?section=backup',
        label: { en: '[[settings.sections.backup]]', ur: '[[settings.sections.backup]]' },
      },
    ],
    tour: [
      {
        path: '/settings',
        target: 'settings-tab-backup',
        click: true,
        title: { en: '[[settings.sections.backup]]', ur: '[[settings.sections.backup]]' },
        body: { en: 'Next opens the backup section.', ur: '"آگے" سے بیک اپ کا حصہ کھلے گا۔' },
      },
      {
        path: '/settings',
        target: 'backup-everything',
        wait: true,
        title: { en: '[[backup.everything.start]]', ur: '[[backup.everything.start]]' },
        body: {
          en: 'One ZIP with all the data. Keep it somewhere private.',
          ur: 'سارا ڈیٹا ایک ZIP میں۔ کسی نجی جگہ رکھیں۔',
        },
      },
    ],
  },

  {
    id: 'install-app',
    section: 'phone',
    roles: TASK_ROLES['install-app'],
    title: { en: 'Install the app on the phone', ur: 'فون پر ایپ انسٹال کریں' },
    summary: {
      en: 'Opens like an app from the home screen, and works without internet.',
      ur: 'ہوم اسکرین سے ایپ کی طرح کھلتی ہے، اور انٹرنیٹ کے بغیر بھی چلتی ہے۔',
    },
    steps: [
      {
        text: {
          en: 'Open Maktab in Chrome on the phone and sign in.',
          ur: 'فون پر Chrome میں مکتب کھولیں اور سائن اِن کریں۔',
        },
      },
      {
        text: {
          en: 'When the banner [[pwa.installTitle]] shows, tap [[pwa.install]]. No banner? Chrome menu (⋮) → **Add to Home screen** or **Install app**.',
          ur: 'جب [[pwa.installTitle]] کی پٹی آئے تو [[pwa.install]] دبائیں۔ پٹی نہیں آئی؟ Chrome مینو (⋮) → **Add to Home screen** یا **Install app**۔',
        },
      },
      {
        text: {
          en: 'From now on open Maktab from the home-screen icon.',
          ur: 'اب سے مکتب ہوم اسکرین کے آئیکن سے کھولیں۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Opening Maktab from an old WhatsApp link every day: use the icon, it is faster and works offline.',
        ur: 'ہر روز پرانے واٹس ایپ لنک سے کھولنا: آئیکن استعمال کریں، تیز ہے اور بغیر انٹرنیٹ چلتا ہے۔',
      },
    ],
    links: [],
  },

  {
    id: 'offline',
    section: 'phone',
    roles: TASK_ROLES.offline,
    title: { en: 'Working without internet', ur: 'انٹرنیٹ کے بغیر کام' },
    summary: {
      en: 'Registers save on the phone and go when the internet is back. Money needs the internet.',
      ur: 'حاضری فون میں محفوظ ہو کر انٹرنیٹ آنے پر چلی جاتی ہے۔ پیسوں کے کام کے لیے انٹرنیٹ ضروری ہے۔',
    },
    steps: [
      {
        text: {
          en: 'Open the app and each class register once while online; then they also open offline.',
          ur: 'انٹرنیٹ ہوتے ہوئے ایپ اور ہر کلاس کا رجسٹر ایک بار کھول لیں؛ پھر یہ بغیر انٹرنیٹ بھی کھلیں گے۔',
        },
      },
      {
        text: {
          en: 'Offline, [[attendance.save]] still works: [[attendance.savedOffline]]. The top bar shows how many are waiting.',
          ur: 'بغیر انٹرنیٹ بھی [[attendance.save]] کام کرتا ہے: [[attendance.savedOffline]]۔ اوپر کی پٹی بتاتی ہے کتنے باقی ہیں۔',
        },
      },
      {
        text: {
          en: 'When the phone is online again, open the app: waiting registers are sent by themselves.',
          ur: 'فون دوبارہ آن لائن ہو تو ایپ کھولیں: باقی رجسٹر خود چلے جاتے ہیں۔',
        },
      },
      {
        text: {
          en: 'The fee counter shows the family offline but cannot issue a receipt until you are back online.',
          ur: 'فیس کاؤنٹر بغیر انٹرنیٹ خاندان دکھاتا ہے، مگر رسید انٹرنیٹ آنے پر ہی بنتی ہے۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Signing out with registers waiting: Maktab warns you. Wait for the internet first.',
        ur: 'باقی رجسٹر کے ساتھ سائن آؤٹ: مکتب خبردار کرتا ہے۔ پہلے انٹرنیٹ کا انتظار کریں۔',
      },
      {
        en: "Clearing Chrome's data with registers waiting: they are lost.",
        ur: 'باقی رجسٹر کے ہوتے Chrome کا ڈیٹا صاف کرنا: وہ ضائع ہو جاتے ہیں۔',
      },
    ],
    links: [{ to: '/attendance', label: { en: '[[nav.attendance]]', ur: '[[nav.attendance]]' } }],
  },

  {
    id: 'printing',
    section: 'phone',
    roles: TASK_ROLES.printing,
    title: { en: 'Printing receipts (thermal and A5)', ur: 'رسید پرنٹ (تھرمل اور A5)' },
    summary: {
      en: 'Choose the paper on the receipt screen, then Print. Each fits one page.',
      ur: 'رسید کی اسکرین پر کاغذ چنیں، پھر Print۔ ہر رسید ایک صفحے پر۔',
    },
    steps: [
      {
        text: {
          en: 'On the receipt: [[fee.receipt.thermal]] for a thermal printer, [[fee.receipt.a5]] for a normal printer.',
          ur: 'رسید پر: تھرمل پرنٹر کے لیے [[fee.receipt.thermal]]، عام پرنٹر کے لیے [[fee.receipt.a5]]۔',
        },
      },
      {
        text: {
          en: 'Choose the [[fee.receipt.language]] (English or Urdu), then [[fee.receipt.print]].',
          ur: '[[fee.receipt.language]] چنیں (انگریزی یا اردو)، پھر [[fee.receipt.print]]۔',
        },
      },
      {
        text: {
          en: "In Chrome's print window pick the printer, or **Save as PDF** to send the receipt as a file.",
          ur: 'Chrome کی پرنٹ ونڈو میں پرنٹر چنیں، یا رسید فائل کی شکل میں بھیجنے کے لیے **Save as PDF**۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Margins set to "Default" on a thermal printer cut the sides: choose "None".',
        ur: 'تھرمل پرنٹر پر مارجن "Default" سے کنارے کٹ جاتے ہیں: "None" چنیں۔',
      },
      {
        en: 'Printing twice for a copy is fine; issuing a second receipt is not.',
        ur: 'کاپی کے لیے دوبارہ پرنٹ ٹھیک ہے؛ دوسری رسید جاری کرنا نہیں۔',
      },
    ],
    links: [
      { to: '/fees/counter', label: { en: '[[fee.nav.counter]]', ur: '[[fee.nav.counter]]' } },
    ],
  },

  {
    id: 'whatsapp',
    section: 'phone',
    roles: TASK_ROLES.whatsapp,
    title: { en: 'Handing off to WhatsApp', ur: 'واٹس ایپ پر بھیجنا' },
    summary: {
      en: 'Maktab prepares; WhatsApp sends; you come back and tap Sent.',
      ur: 'مکتب تیار کرتا ہے؛ واٹس ایپ بھیجتا ہے؛ آپ واپس آ کر Sent دباتے ہیں۔',
    },
    steps: [
      {
        text: {
          en: "Use the school's WhatsApp number on the phone you send from (WhatsApp Business is fine).",
          ur: 'جس فون سے بھیجنا ہے اس پر اسکول کا واٹس ایپ نمبر ہو (WhatsApp Business بھی ٹھیک ہے)۔',
        },
      },
      {
        text: {
          en: "[[msg.queue.openWa]] opens the right chat with the text ready, in the guardian's language. Press send in WhatsApp.",
          ur: '[[msg.queue.openWa]] درست چیٹ میں سرپرست کی زبان میں پیغام تیار کھول دیتا ہے۔ واٹس ایپ میں بھیج دیں۔',
        },
      },
      {
        text: {
          en: 'Come back with the back button; Maktab is still where you left it. Tap [[msg.queue.sentNext]].',
          ur: 'بیک بٹن سے واپس آئیں؛ مکتب وہیں کھلا ملے گا۔ [[msg.queue.sentNext]] دبائیں۔',
        },
      },
      {
        text: {
          en: 'Class WhatsApp groups: [[msg.queue.copyAllGroup]] (absence and notice texts only; fee texts are private).',
          ur: 'کلاس کے واٹس ایپ گروپ: [[msg.queue.copyAllGroup]] (صرف غیر حاضری اور نوٹس؛ فیس کے پیغام نجی ہیں)۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Editing away the link at the end of the text: the parent cannot open their page.',
        ur: 'پیغام کے آخر سے لنک ہٹا دینا: والدین اپنا صفحہ نہیں کھول سکتے۔',
      },
      {
        en: 'Pop-up blocked: tap [[msg.queue.openWa]] again, or allow pop-ups for Maktab.',
        ur: 'پاپ اپ بند ہو گیا: دوبارہ [[msg.queue.openWa]] دبائیں، یا مکتب کے لیے پاپ اپ کی اجازت دیں۔',
      },
    ],
    links: [
      { to: '/messages', label: { en: '[[shell.nav.messages]]', ur: '[[shell.nav.messages]]' } },
    ],
  },
];
