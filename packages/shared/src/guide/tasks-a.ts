import type { GuideTask } from './types';

/*
 * Getting started, every day, at the office. Button names are written exactly as the app shows them
 * (in English, between **…**); the Urdu screen has the same buttons in the same places.
 */

export const TASKS_A: readonly GuideTask[] = [
  {
    id: 'first-week',
    section: 'start',
    roles: ['owner', 'admin'],
    title: { en: 'Your first week', ur: 'آپ کا پہلا ہفتہ' },
    summary: {
      en: 'Set up the school, then do each job once: admit, register, fee, message.',
      ur: 'اسکول کی ترتیب، پھر ہر کام ایک بار: داخلہ، حاضری، فیس، پیغام۔',
    },
    steps: [
      {
        id: 'setup',
        to: '/setup',
        text: {
          en: 'Day 1, setup: open **Settings** → **Run the setup wizard** (it opens by itself on the first sign-in). Enter the school name, Urdu name, phone, logo and receipt prefix (letters before receipt numbers, e.g. `ANS`).',
          ur: 'پہلا دن، ترتیب: **Settings** → **Run the setup wizard** کھولیں (پہلی بار سائن اِن پر یہ خود کھلتا ہے)۔ اسکول کا نام، اردو نام، فون، لوگو اور رسید کا پری فکس (رسید نمبر سے پہلے کے حروف، مثلاً `ANS`) لکھیں۔',
        },
      },
      {
        id: 'classes',
        to: '/settings?section=programmes',
        text: {
          en: 'Classes: press **Add Pakistani classes and subjects** to fill Nursery to Class 10, FSc, ICS and FA. Remove what you do not teach. Then add the groups (sections like 5-A, 5-B, or academy batches) with a class teacher.',
          ur: 'کلاسیں: **Add Pakistani classes and subjects** دبائیں، نرسری سے دسویں، FSc، ICS اور FA خود آ جائیں گی۔ جو آپ نہیں پڑھاتے وہ ہٹا دیں۔ پھر گروپ (سیکشن جیسے 5-A، 5-B، یا اکیڈمی کے بیچ) کلاس ٹیچر کے ساتھ بنائیں۔',
        },
      },
      {
        id: 'fees',
        to: '/settings?section=fees',
        text: {
          en: 'Fees: in **Settings** → **Fees** add the fee heads (Admission, Tuition, Exam) and a rate for each class. Do this before the first admission, so the admission fee is charged.',
          ur: 'فیس: **Settings** → **Fees** میں فیس کی مدیں (داخلہ، ٹیوشن، امتحان) اور ہر کلاس کا ریٹ لکھیں۔ یہ پہلے داخلے سے پہلے کریں تاکہ داخلہ فیس لگ جائے۔',
        },
      },
      {
        id: 'staff',
        to: '/settings?section=staff',
        text: {
          en: 'Staff: **Settings** → **Staff** → **Invite staff** with each person\'s Google email and role. Have two people with Owner or Admin.',
          ur: 'عملہ: **Settings** → **Staff** → **Invite staff** میں ہر شخص کا گوگل ای میل اور کردار لکھیں۔ کم از کم دو لوگ Owner یا Admin ہوں۔',
        },
      },
      {
        id: 'admission',
        to: '/students/new',
        text: {
          en: 'First admissions: **Students** → **Admit** for one child, or **Import CSV** for the whole school at once.',
          ur: 'پہلے داخلے: ایک بچے کے لیے **Students** → **Admit**، یا پورے اسکول کے لیے ایک ساتھ **Import CSV**۔',
        },
      },
      {
        id: 'register',
        to: '/attendance',
        text: {
          en: 'First register: **Attendance** → tap a class → change only the absent ones → **Save attendance**.',
          ur: 'پہلی حاضری: **Attendance** → کلاس پر ٹیپ کریں → صرف غیر حاضر بدلیں → **Save attendance**۔',
        },
      },
      {
        id: 'fee',
        to: '/fees/billing',
        text: {
          en: 'First fee: **Monthly billing** → **Preview** → **Generate** for this month, then take the first payment at the **Fee counter**.',
          ur: 'پہلی فیس: **Monthly billing** → **Preview** → **Generate** اس مہینے کے لیے، پھر **Fee counter** پر پہلی فیس وصول کریں۔',
        },
      },
      {
        id: 'message',
        to: '/messages',
        text: {
          en: 'First message: open **Messages**, tap **Open WhatsApp** on a row, send it in WhatsApp, come back and tap **Sent & next**.',
          ur: 'پہلا پیغام: **Messages** کھولیں، کسی قطار پر **Open WhatsApp** دبائیں، واٹس ایپ میں بھیجیں، واپس آ کر **Sent & next** دبائیں۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Admitting students before adding fee rates: their admission fee is not charged. Add rates first.',
        ur: 'فیس ریٹ سے پہلے داخلے کرنا: داخلہ فیس نہیں لگتی۔ پہلے ریٹ لکھیں۔',
      },
      {
        en: 'Only one owner: if that phone is lost, nobody can manage staff. Invite a second owner or admin.',
        ur: 'صرف ایک مالک: وہ فون گم ہو جائے تو عملہ کوئی نہیں سنبھال سکتا۔ دوسرا Owner یا Admin بنائیں۔',
      },
      {
        en: 'Changing the receipt prefix later: it is locked after the first receipt.',
        ur: 'رسید کا پری فکس بعد میں بدلنا: پہلی رسید کے بعد یہ بند ہو جاتا ہے۔',
      },
    ],
    links: [
      { to: '/settings', label: { en: 'Settings', ur: 'Settings' } },
      { to: '/students', label: { en: 'Students', ur: 'Students' } },
    ],
    tour: [
      {
        path: '/',
        target: 'home-first-week',
        title: { en: 'Your checklist', ur: 'آپ کی فہرست' },
        body: {
          en: 'Home keeps this list until each first job is done. Tap a line to go there.',
          ur: 'ہوم پر یہ فہرست تب تک رہتی ہے جب تک ہر پہلا کام ہو نہ جائے۔ کسی سطر پر ٹیپ کریں تو وہاں پہنچ جائیں گے۔',
        },
      },
      {
        path: '/settings',
        target: 'settings-tab-programmes',
        title: { en: 'Classes', ur: 'کلاسیں' },
        body: {
          en: 'Classes and subjects. **Add Pakistani classes and subjects** fills the usual ladder.',
          ur: 'کلاسیں اور مضامین۔ **Add Pakistani classes and subjects** عام کلاسیں خود بھر دیتا ہے۔',
        },
      },
      {
        path: '/settings',
        target: 'settings-tab-fees',
        title: { en: 'Fees', ur: 'فیس' },
        body: {
          en: 'Fee heads and a rate for each class. Do it before the first admission.',
          ur: 'فیس کی مدیں اور ہر کلاس کا ریٹ۔ پہلے داخلے سے پہلے کریں۔',
        },
      },
      {
        path: '/settings',
        target: 'settings-tab-staff',
        title: { en: 'Staff', ur: 'عملہ' },
        body: {
          en: 'Invite each person with their Google email and a role.',
          ur: 'ہر شخص کو اس کے گوگل ای میل اور کردار کے ساتھ دعوت دیں۔',
        },
      },
      {
        path: '/students',
        target: 'students-admit',
        title: { en: 'Admit', ur: 'داخلہ' },
        body: {
          en: 'One child at a time here; **Import CSV** next to it for many.',
          ur: 'یہاں ایک ایک بچہ؛ زیادہ بچوں کے لیے ساتھ والا **Import CSV**۔',
        },
      },
      {
        path: '/attendance',
        target: 'att-today',
        title: { en: 'Registers', ur: 'حاضری رجسٹر' },
        body: {
          en: "Today's classes. Teachers do this on their phones every morning.",
          ur: 'آج کی کلاسیں۔ اساتذہ ہر صبح اپنے فون پر یہ کرتے ہیں۔',
        },
      },
      {
        path: '/fees/billing',
        target: 'billing-month',
        title: { en: 'Bill the month', ur: 'مہینے کی فیس' },
        body: {
          en: 'Choose the month, **Preview**, then **Generate**. Pressing twice never bills twice.',
          ur: 'مہینہ چنیں، **Preview**، پھر **Generate**۔ دو بار دبانے سے دو بار فیس نہیں لگتی۔',
        },
      },
      {
        path: '/messages',
        target: 'msg-counts',
        title: { en: 'Messages', ur: 'پیغامات' },
        body: {
          en: 'Absence and fee messages wait here. You send them from WhatsApp, one tap each.',
          ur: 'غیر حاضری اور فیس کے پیغامات یہاں انتظار کرتے ہیں۔ آپ واٹس ایپ سے ایک ٹیپ میں بھیجتے ہیں۔',
        },
      },
    ],
  },

  {
    id: 'take-attendance',
    section: 'daily',
    roles: ['owner', 'admin', 'teacher'],
    title: { en: 'Take attendance', ur: 'حاضری لگائیں' },
    summary: {
      en: 'One register per class each morning, on the phone. Works without internet.',
      ur: 'ہر صبح ہر کلاس کا ایک رجسٹر، فون پر۔ انٹرنیٹ کے بغیر بھی۔',
    },
    steps: [
      {
        to: '/attendance',
        text: {
          en: 'Open **Attendance**. Classes under "To take" still need a register today.',
          ur: '**Attendance** کھولیں۔ "To take" کے نیچے والی کلاسوں کی حاضری ابھی باقی ہے۔',
        },
      },
      {
        text: {
          en: 'Tap the class. Everyone starts **Present**.',
          ur: 'کلاس پر ٹیپ کریں۔ سب پہلے سے **Present** ہوتے ہیں۔',
        },
      },
      {
        text: {
          en: 'Tap a student to change: present → absent → late → leave. The note button adds a note.',
          ur: 'بچے پر ٹیپ کریں تو بدلتا ہے: حاضر ← غیر حاضر ← دیر ← چھٹی۔ نوٹ کے بٹن سے نوٹ لکھیں۔',
        },
      },
      {
        text: {
          en: 'Press **Save attendance**. Absence messages for the parents go to the send queue.',
          ur: '**Save attendance** دبائیں۔ والدین کے لیے غیر حاضری کے پیغام قطار میں چلے جاتے ہیں۔',
        },
      },
      {
        text: {
          en: 'No internet? Save anyway. It says "Saved on this phone" and a waiting count shows in the top bar. It is sent by itself when the phone is online and the app is opened.',
          ur: 'انٹرنیٹ نہیں؟ پھر بھی محفوظ کریں۔ "Saved on this phone" لکھا آئے گا اور اوپر انتظار کی گنتی نظر آئے گی۔ فون آن لائن ہو اور ایپ کھلے تو خود چلی جائے گی۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Signing out with registers still waiting: only the same account can send them. Wait for the count to reach 0.',
        ur: 'انتظار والے رجسٹر کے ساتھ سائن آؤٹ کرنا: انہیں صرف وہی اکاؤنٹ بھیج سکتا ہے۔ گنتی 0 ہونے دیں۔',
      },
      {
        en: '"Your phone\'s clock is ahead": set the phone to automatic date and time, then save again.',
        ur: '"Your phone\'s clock is ahead": فون کی تاریخ اور وقت خودکار پر کریں، پھر دوبارہ محفوظ کریں۔',
      },
      {
        en: 'A wrong register cannot be retaken by a teacher. Ask the owner or admin: **Correct this register** with a reason.',
        ur: 'غلط رجسٹر استاد دوبارہ نہیں لگا سکتا۔ مالک یا ایڈمن سے کہیں: وجہ لکھ کر **Correct this register**۔',
      },
    ],
    links: [
      { to: '/attendance', label: { en: 'Attendance', ur: 'Attendance' } },
      { to: '/attendance/report', label: { en: 'Monthly register', ur: 'Monthly register' } },
    ],
    tour: [
      {
        path: '/attendance',
        target: 'att-today',
        title: { en: 'Classes for today', ur: 'آج کی کلاسیں' },
        body: {
          en: '"To take" are the classes still without a register.',
          ur: '"To take" وہ کلاسیں ہیں جن کی حاضری ابھی نہیں لگی۔',
        },
      },
      {
        path: '/attendance',
        target: 'att-group',
        click: true,
        title: { en: 'Open a class', ur: 'کلاس کھولیں' },
        body: {
          en: 'Tap the class to open its register. Next opens the first one for you.',
          ur: 'کلاس پر ٹیپ کریں تو رجسٹر کھلتا ہے۔ "آگے" دبانے سے پہلی کلاس کھل جائے گی۔',
        },
      },
      {
        path: '/attendance/register/:grpId',
        target: 'att-row',
        wait: true,
        title: { en: 'Tap to change', ur: 'ٹیپ سے بدلیں' },
        body: {
          en: 'Everyone starts present. Tap a child: absent, late, leave, then back to present.',
          ur: 'سب حاضر سے شروع ہوتے ہیں۔ بچے پر ٹیپ کریں: غیر حاضر، دیر، چھٹی، پھر واپس حاضر۔',
        },
      },
      {
        path: '/attendance/register/:grpId',
        target: 'att-progress',
        title: { en: 'Count so far', ur: 'اب تک کی گنتی' },
        body: {
          en: 'How many are present, updated as you tap.',
          ur: 'کتنے حاضر ہیں، ہر ٹیپ کے ساتھ بدلتا ہے۔',
        },
      },
      {
        path: '/attendance/register/:grpId',
        target: 'att-save',
        title: { en: 'Save attendance', ur: 'Save attendance' },
        body: {
          en: 'One press. Without internet it is kept on this phone and sent later.',
          ur: 'ایک بار دبائیں۔ انٹرنیٹ نہ ہو تو فون میں محفوظ رہتی ہے اور بعد میں چلی جاتی ہے۔',
        },
      },
      {
        target: 'sync-state',
        title: { en: 'Saved or waiting', ur: 'محفوظ یا انتظار' },
        body: {
          en: 'Green means sent. A number means registers wait on this phone for the internet.',
          ur: 'سبز کا مطلب چلی گئی۔ نمبر کا مطلب اتنے رجسٹر انٹرنیٹ کے انتظار میں فون پر ہیں۔',
        },
      },
    ],
  },

  {
    id: 'send-messages',
    section: 'daily',
    roles: ['owner', 'admin', 'accountant', 'teacher'],
    title: { en: "Send today's messages", ur: 'آج کے پیغامات بھیجیں' },
    summary: {
      en: 'Maktab writes each message; you send it from WhatsApp and tap Sent.',
      ur: 'مکتب پیغام لکھتا ہے؛ آپ واٹس ایپ سے بھیج کر Sent دباتے ہیں۔',
    },
    steps: [
      {
        to: '/messages',
        text: {
          en: 'Open **Messages**. Waiting messages are grouped: absent today, fee due, fee overdue, payment received, notice.',
          ur: '**Messages** کھولیں۔ انتظار والے پیغام قسم وار ہیں: آج غیر حاضر، فیس واجب، فیس لیٹ، فیس وصول، نوٹس۔',
        },
      },
      {
        text: {
          en: 'Press **Start sending** to go one family at a time in large type.',
          ur: '**Start sending** دبائیں، ایک ایک خاندان بڑے حروف میں سامنے آئے گا۔',
        },
      },
      {
        text: {
          en: 'Tap **Open WhatsApp**. WhatsApp opens with the text ready; press send there.',
          ur: '**Open WhatsApp** دبائیں۔ واٹس ایپ میں پیغام تیار ملے گا؛ وہاں بھیج دیں۔',
        },
      },
      {
        text: {
          en: 'Come back to Maktab and tap **Sent & next**. Nothing is marked sent until you tap it.',
          ur: 'مکتب میں واپس آ کر **Sent & next** دبائیں۔ جب تک آپ نہ دبائیں، پیغام بھیجا ہوا نہیں مانا جاتا۔',
        },
      },
      {
        text: {
          en: 'Will not send it? **Skip** and choose a reason (wrong number, told in person…).',
          ur: 'نہیں بھیجنا؟ **Skip** دبا کر وجہ چنیں (غلط نمبر، خود بتا دیا…)۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Tapping **Sent & next** without sending in WhatsApp: the parent never gets it.',
        ur: 'واٹس ایپ میں بھیجے بغیر **Sent & next** دبانا: والدین کو پیغام ملتا ہی نہیں۔',
      },
      {
        en: 'Rows that say "call instead" have no WhatsApp consent or only a landline. Phone the parent; fix the number on the student page.',
        ur: '"call instead" والی قطاروں میں واٹس ایپ کی اجازت نہیں یا صرف لینڈ لائن ہے۔ فون کریں؛ نمبر طالب علم کے صفحے پر ٹھیک کریں۔',
      },
    ],
    links: [{ to: '/messages', label: { en: 'Messages', ur: 'Messages' } }],
    tour: [
      {
        path: '/messages',
        target: 'msg-counts',
        title: { en: 'What is waiting', ur: 'کیا باقی ہے' },
        body: {
          en: 'Waiting, sent today and skipped today.',
          ur: 'باقی، آج بھیجے گئے، اور آج چھوڑے گئے۔',
        },
      },
      {
        path: '/messages',
        target: 'msg-start',
        title: { en: 'Start sending', ur: 'Start sending' },
        body: {
          en: 'One family at a time, big and clear. Best on the phone.',
          ur: 'ایک وقت میں ایک خاندان، بڑا اور صاف۔ فون پر سب سے آسان۔',
        },
      },
      {
        path: '/messages',
        target: 'msg-open-wa',
        title: { en: 'Open WhatsApp', ur: 'Open WhatsApp' },
        body: {
          en: 'Opens WhatsApp with the text ready. Send it there, then come back and tap **Sent & next**.',
          ur: 'واٹس ایپ میں پیغام تیار کھلتا ہے۔ وہاں بھیجیں، پھر واپس آ کر **Sent & next** دبائیں۔',
        },
      },
      {
        path: '/messages',
        target: 'msg-skip',
        title: { en: 'Skip', ur: 'Skip' },
        body: {
          en: 'Not sending this one? Skip it with a reason.',
          ur: 'یہ نہیں بھیجنا؟ وجہ کے ساتھ چھوڑ دیں۔',
        },
      },
    ],
  },

  {
    id: 'admit-student',
    section: 'office',
    roles: ['owner', 'admin', 'accountant'],
    title: { en: 'Admit a student', ur: 'نیا داخلہ' },
    summary: {
      en: "Start with the guardian's phone, then the child, then the class.",
      ur: 'پہلے سرپرست کا فون، پھر بچہ، پھر کلاس۔',
    },
    steps: [
      {
        to: '/students/new',
        text: {
          en: '**Students** → **Admit**. Type the guardian phone and press **Find family**.',
          ur: '**Students** → **Admit**۔ سرپرست کا فون لکھیں اور **Find family** دبائیں۔',
        },
      },
      {
        text: {
          en: 'New family: **No, new family**, then family name, area and address.',
          ur: 'نیا خاندان: **No, new family**، پھر خاندان کا نام، علاقہ اور پتا۔',
        },
      },
      {
        text: {
          en: 'Guardians: name, relation, phone, WhatsApp number, message language. Ask the parent, then tick "Agrees to receive WhatsApp messages from the school".',
          ur: 'سرپرست: نام، رشتہ، فون، واٹس ایپ نمبر، پیغام کی زبان۔ والدین سے پوچھ کر "Agrees to receive WhatsApp messages from the school" پر نشان لگائیں۔',
        },
      },
      {
        text: {
          en: 'Student: name, father name, date of birth, B-form, photo. Leave admission no. blank for the next number.',
          ur: 'طالب علم: نام، والد کا نام، تاریخ پیدائش، ب فارم، تصویر۔ داخلہ نمبر خالی چھوڑیں تو اگلا نمبر خود لگے گا۔',
        },
      },
      {
        text: {
          en: 'Choose the class, then **Admit student**. The admission fee and this month\'s fee are charged from the rates.',
          ur: 'کلاس چنیں، پھر **Admit student**۔ داخلہ فیس اور اس مہینے کی فیس ریٹ کے مطابق لگ جاتی ہے۔',
        },
      },
      {
        to: '/students/import',
        text: {
          en: 'Many at once: **Import CSV** → **Download template** → fill one row per student → **Check file** → **Import N students**.',
          ur: 'بہت سے ایک ساتھ: **Import CSV** → **Download template** → ہر بچے کی ایک سطر بھریں → **Check file** → **Import N students**۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Skipping the phone search: a brother or sister ends up in a second family and fees split.',
        ur: 'فون سے تلاش نہ کرنا: بھائی بہن الگ خاندان میں چلے جاتے ہیں اور فیس بٹ جاتی ہے۔',
      },
      {
        en: 'Leaving out the date of birth: the parent page asks for the child\'s birth year.',
        ur: 'تاریخ پیدائش خالی چھوڑنا: والدین کا صفحہ بچے کا سالِ پیدائش پوچھتا ہے۔',
      },
      {
        en: 'Fees owed from before Maktab go in **Opening balance** on the family statement, not as old months.',
        ur: 'مکتب سے پہلے کا بقایا فیملی اسٹیٹمنٹ میں **Opening balance** میں لکھیں، پرانے مہینے نہ بنائیں۔',
      },
    ],
    links: [
      { to: '/students/new', label: { en: 'Admit', ur: 'Admit' } },
      { to: '/students/import', label: { en: 'Import CSV', ur: 'Import CSV' } },
    ],
    tour: [
      {
        path: '/students',
        target: 'students-admit',
        click: true,
        title: { en: 'Admit', ur: 'Admit' },
        body: {
          en: 'Starts a new admission. Next opens it.',
          ur: 'نیا داخلہ شروع کرتا ہے۔ "آگے" دبائیں تو کھل جائے گا۔',
        },
      },
      {
        path: '/students/new',
        target: 'adm-phone',
        title: { en: 'Guardian phone first', ur: 'پہلے سرپرست کا فون' },
        body: {
          en: 'Type the phone number. A brother or sister may already be here.',
          ur: 'فون نمبر لکھیں۔ ہو سکتا ہے بھائی یا بہن پہلے سے یہاں ہو۔',
        },
      },
      {
        path: '/students/new',
        target: 'adm-find',
        title: { en: 'Find family', ur: 'Find family' },
        body: {
          en: 'Shows the family if the phone is known; otherwise you start a new one.',
          ur: 'فون پہلے سے ہو تو خاندان دکھاتا ہے؛ ورنہ نیا خاندان بنائیں۔',
        },
      },
    ],
  },

  {
    id: 'admit-sibling',
    section: 'office',
    roles: ['owner', 'admin', 'accountant'],
    title: { en: 'Admit a brother or sister', ur: 'بھائی یا بہن کا داخلہ' },
    summary: {
      en: 'Same family, one fee account: find the family by phone first.',
      ur: 'ایک خاندان، ایک فیس کھاتا: پہلے فون سے خاندان تلاش کریں۔',
    },
    steps: [
      {
        to: '/students/new',
        text: {
          en: '**Students** → **Admit**. Type the phone of a guardian already in Maktab → **Find family**.',
          ur: '**Students** → **Admit**۔ مکتب میں پہلے سے موجود سرپرست کا فون لکھیں → **Find family**۔',
        },
      },
      {
        text: {
          en: 'Check the children shown, then tap **Yes, same family**. The guardians are already filled in.',
          ur: 'دکھائے گئے بچے دیکھیں، پھر **Yes, same family** دبائیں۔ سرپرست پہلے سے بھرے ہوں گے۔',
        },
      },
      {
        text: {
          en: 'Fill in the child and class → **Admit student**. If the school gives a sibling concession, Maktab suggests it.',
          ur: 'بچے اور کلاس کی تفصیل بھریں → **Admit student**۔ اگر اسکول بہن بھائی کی رعایت دیتا ہے تو مکتب خود تجویز کرے گا۔',
        },
      },
      {
        text: {
          en: 'At the **Fee counter** the family now pays for all children on one receipt.',
          ur: 'اب **Fee counter** پر خاندان سب بچوں کی فیس ایک رسید پر دیتا ہے۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Choosing **No, new family** for a sibling: two families, two dues, two parent links.',
        ur: 'بہن بھائی کے لیے **No, new family** چننا: دو خاندان، دو بقایا، دو لنک۔',
      },
      {
        en: 'Searching by the child\'s name instead of the phone: use the guardian phone.',
        ur: 'بچے کے نام سے تلاش کرنا: سرپرست کا فون استعمال کریں۔',
      },
    ],
    links: [{ to: '/students/new', label: { en: 'Admit', ur: 'Admit' } }],
    tour: [
      {
        path: '/students/new',
        target: 'adm-phone',
        title: { en: 'Known phone', ur: 'پہلے والا فون' },
        body: {
          en: 'The phone of the guardian who is already in Maktab.',
          ur: 'اس سرپرست کا فون جو پہلے سے مکتب میں ہے۔',
        },
      },
      {
        path: '/students/new',
        target: 'adm-find',
        title: { en: 'Find family', ur: 'Find family' },
        body: { en: 'Looks the family up.', ur: 'خاندان تلاش کرتا ہے۔' },
      },
      {
        path: '/students/new',
        target: 'adm-same-family',
        wait: true,
        title: { en: 'Yes, same family', ur: 'Yes, same family' },
        body: {
          en: 'The new child joins this family: one statement, one receipt.',
          ur: 'نیا بچہ اسی خاندان میں شامل ہو جاتا ہے: ایک کھاتا، ایک رسید۔',
        },
      },
    ],
  },

  {
    id: 'collect-fee',
    section: 'office',
    roles: ['owner', 'admin', 'accountant'],
    title: { en: 'Collect a fee and give the receipt', ur: 'فیس وصول کریں اور رسید دیں' },
    summary: {
      en: 'Find the family, enter the amount, confirm, then print or share the receipt.',
      ur: 'خاندان تلاش کریں، رقم لکھیں، تصدیق کریں، پھر رسید پرنٹ یا شیئر کریں۔',
    },
    steps: [
      {
        to: '/fees/counter',
        text: {
          en: '**Fee counter**: search by name, admission no. or guardian phone, then tap the family. You see every child\'s fees and the total due.',
          ur: '**Fee counter**: نام، داخلہ نمبر یا سرپرست کے فون سے تلاش کریں، پھر خاندان پر ٹیپ کریں۔ ہر بچے کی فیس اور کل بقایا سامنے آ جائے گا۔',
        },
      },
      {
        text: {
          en: 'Enter **Amount received (Rs)** (or tap **Full due**) and choose **Paid by**: Cash, Bank, JazzCash, EasyPaisa, Cheque. Oldest dues are paid first.',
          ur: '**Amount received (Rs)** لکھیں (یا **Full due** دبائیں) اور **Paid by** چنیں: Cash، Bank، JazzCash، EasyPaisa، Cheque۔ پہلے پرانا بقایا ادا ہوتا ہے۔',
        },
      },
      {
        text: {
          en: 'Press **Confirm and issue receipt**, check the box that opens, and confirm. The receipt number is issued.',
          ur: '**Confirm and issue receipt** دبائیں، کھلنے والا خانہ دیکھیں اور تصدیق کریں۔ رسید نمبر جاری ہو جاتا ہے۔',
        },
      },
      {
        text: {
          en: 'On the receipt: choose **A5** (normal printer) or **58 mm** (thermal), the receipt language, then **Print**. Or **Share** to send it from the phone.',
          ur: 'رسید پر: **A5** (عام پرنٹر) یا **58 mm** (تھرمل) اور رسید کی زبان چنیں، پھر **Print**۔ یا فون سے بھیجنے کے لیے **Share**۔',
        },
      },
      {
        text: {
          en: '**Send payment-received** puts a WhatsApp thank-you, with the family\'s private link, in the send queue.',
          ur: '**Send payment-received** شکریے کا واٹس ایپ پیغام، خاندان کے نجی لنک کے ساتھ، قطار میں ڈال دیتا ہے۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'A wrong receipt is never edited. The owner or admin presses **Reverse** with a reason and enters it again.',
        ur: 'غلط رسید بدلی نہیں جاتی۔ مالک یا ایڈمن وجہ لکھ کر **Reverse** کرتا ہے اور دوبارہ درج کرتا ہے۔',
      },
      {
        en: 'One receipt per family visit: do not make a separate receipt for each child.',
        ur: 'ہر آمد پر خاندان کی ایک رسید: ہر بچے کی الگ رسید نہ بنائیں۔',
      },
      {
        en: 'Non-cash needs the account it went into (bank or wallet); add accounts in **Settings** → **Fees**.',
        ur: 'نقد کے علاوہ رقم کے لیے اکاؤنٹ چننا ضروری ہے (بینک یا والٹ)؛ اکاؤنٹ **Settings** → **Fees** میں بنائیں۔',
      },
    ],
    links: [{ to: '/fees/counter', label: { en: 'Fee counter', ur: 'Fee counter' } }],
    tour: [
      {
        path: '/fees/counter',
        target: 'counter-search',
        title: { en: 'Find the family', ur: 'خاندان تلاش کریں' },
        body: {
          en: 'Name, admission no. or phone. Then tap the family in the list.',
          ur: 'نام، داخلہ نمبر یا فون۔ پھر فہرست میں خاندان پر ٹیپ کریں۔',
        },
      },
      {
        path: '/fees/counter',
        target: 'counter-family',
        wait: true,
        title: { en: 'The whole family', ur: 'پورا خاندان' },
        body: {
          en: "Each child's fees and the total due. One receipt covers them all.",
          ur: 'ہر بچے کی فیس اور کل بقایا۔ ایک رسید سب کے لیے۔',
        },
      },
      {
        path: '/fees/counter',
        target: 'counter-amount',
        title: { en: 'Amount received', ur: 'وصول رقم' },
        body: {
          en: 'Type what the parent gave, or tap **Full due**.',
          ur: 'جو والدین نے دیا وہ لکھیں، یا **Full due** دبائیں۔',
        },
      },
      {
        path: '/fees/counter',
        target: 'counter-method',
        title: { en: 'Paid by', ur: 'Paid by' },
        body: {
          en: 'Cash goes into your drawer; bank and wallets need the account.',
          ur: 'نقد آپ کے دراز میں جاتا ہے؛ بینک اور والٹ کے لیے اکاؤنٹ چنیں۔',
        },
      },
      {
        path: '/fees/counter',
        target: 'counter-confirm',
        title: { en: 'Confirm and issue receipt', ur: 'Confirm and issue receipt' },
        body: {
          en: 'You see the details once more, then the receipt is issued and opens for print or share.',
          ur: 'ایک بار پھر تفصیل دکھتی ہے، پھر رسید جاری ہو کر پرنٹ یا شیئر کے لیے کھلتی ہے۔',
        },
      },
    ],
  },

  {
    id: 'reduce-fee',
    section: 'office',
    roles: ['owner', 'admin'],
    title: { en: 'Reduce a fee', ur: 'فیس میں رعایت' },
    summary: {
      en: 'A concession for one child: a reason, a percent or amount, from a date.',
      ur: 'ایک بچے کے لیے رعایت: وجہ، فیصد یا رقم، کسی تاریخ سے۔',
    },
    steps: [
      {
        to: '/students',
        text: {
          en: 'Open the student (**Students** → tap the name) → **Fees** tab.',
          ur: 'طالب علم کھولیں (**Students** → نام پر ٹیپ) → **Fees** ٹیب۔',
        },
      },
      {
        text: {
          en: 'Press **Reduce fee**. Choose the reason (Sibling, Orphan, Staff child…), **Percent** or **Fixed amount**, the fee head and **From date**.',
          ur: '**Reduce fee** دبائیں۔ وجہ (Sibling، Orphan، Staff child…)، **Percent** یا **Fixed amount**، فیس کی مد اور **From date** چنیں۔',
        },
      },
      {
        text: {
          en: 'It applies from the next month that starts on or after that date. To change this month too, press **Regenerate this month**.',
          ur: 'یہ اس تاریخ کے بعد شروع ہونے والے مہینے سے لگتی ہے۔ اس مہینے پر بھی لگانی ہو تو **Regenerate this month** دبائیں۔',
        },
      },
      {
        text: {
          en: 'To stop it, press **End** with a date and reason. To change it, end it and add a new one.',
          ur: 'بند کرنی ہو تو تاریخ اور وجہ کے ساتھ **End** دبائیں۔ بدلنی ہو تو پرانی بند کر کے نئی لگائیں۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Taking less money at the counter instead of a concession: the family then shows as a defaulter.',
        ur: 'رعایت کی بجائے کاؤنٹر پر کم پیسے لینا: پھر خاندان نادہندہ دکھتا ہے۔',
      },
      {
        en: 'Expecting it on a month already billed: use **Regenerate this month**.',
        ur: 'پہلے سے بنی فیس پر خود لگنے کی امید: **Regenerate this month** دبائیں۔',
      },
    ],
    links: [
      { to: '/students', label: { en: 'Students', ur: 'Students' } },
      { to: '/fees/concessions', label: { en: 'Concession register', ur: 'Concession register' } },
    ],
    tour: [
      {
        path: '/students',
        target: 'students-list',
        title: { en: 'Open the student', ur: 'طالب علم کھولیں' },
        body: {
          en: 'Tap the child who gets the concession. The tour waits for you.',
          ur: 'جس بچے کو رعایت دینی ہے اس پر ٹیپ کریں۔ ٹور آپ کا انتظار کرے گا۔',
        },
      },
      {
        path: '/students/:id',
        target: 'profile-tab-fees',
        wait: true,
        click: true,
        title: { en: 'Fees tab', ur: 'Fees ٹیب' },
        body: { en: "The child's fees and concessions.", ur: 'بچے کی فیس اور رعایتیں۔' },
      },
      {
        path: '/students/:id',
        target: 'student-reduce-fee',
        wait: true,
        title: { en: 'Reduce fee', ur: 'Reduce fee' },
        body: {
          en: 'Reason, percent or amount, from date. Every concession is kept in the concession register.',
          ur: 'وجہ، فیصد یا رقم، تاریخ۔ ہر رعایت رعایت رجسٹر میں محفوظ رہتی ہے۔',
        },
      },
    ],
  },

  {
    id: 'close-cash',
    section: 'office',
    roles: ['owner', 'admin', 'accountant'],
    title: { en: 'Close the cash drawer', ur: 'کیش دراز بند کریں' },
    summary: {
      en: 'At the end of the day: count the cash, enter it, close.',
      ur: 'دن کے آخر میں: نقدی گنیں، لکھیں، بند کریں۔',
    },
    steps: [
      {
        to: '/cash',
        text: {
          en: 'Open **Fees** → **Cash**. Today\'s drawer shows **Expected**: cash received minus cash paid out.',
          ur: '**Fees** → **Cash** کھولیں۔ آج کے دراز میں **Expected** لکھا ہے: آئی نقدی منفی دی گئی نقدی۔',
        },
      },
      {
        text: {
          en: 'Count the notes. Enter **Counted cash (Rs)** and look at the **Variance**.',
          ur: 'نوٹ گنیں۔ **Counted cash (Rs)** لکھیں اور **Variance** دیکھیں۔',
        },
      },
      {
        text: {
          en: 'Press **Close drawer**. A closed drawer takes no more entries.',
          ur: '**Close drawer** دبائیں۔ بند دراز میں مزید اندراج نہیں ہوتا۔',
        },
      },
      {
        text: {
          en: 'Handing cash to the owner or depositing it: **Handover / bank deposit** (a transfer, never income or expense).',
          ur: 'نقدی مالک کو دینی ہو یا بینک میں جمع کرانی ہو: **Handover / bank deposit** (یہ منتقلی ہے، آمدنی یا خرچ نہیں)۔',
        },
      },
    ],
    mistakes: [
      {
        en: 'Closing before counting: only the owner or admin can **Reopen**, with a reason.',
        ur: 'گنے بغیر بند کرنا: پھر صرف مالک یا ایڈمن وجہ لکھ کر **Reopen** کر سکتا ہے۔',
      },
      {
        en: 'Entering cash for yesterday: not possible. Record cash on the day it comes in.',
        ur: 'کل کی نقدی آج لکھنا: ممکن نہیں۔ نقدی اسی دن درج کریں۔',
      },
    ],
    links: [{ to: '/cash', label: { en: 'Cash', ur: 'Cash' } }],
    tour: [
      {
        path: '/cash',
        target: 'cash-today',
        title: { en: "Today's drawer", ur: 'آج کا دراز' },
        body: {
          en: '**Expected** is what should be in the drawer now.',
          ur: '**Expected** وہ رقم ہے جو اس وقت دراز میں ہونی چاہیے۔',
        },
      },
      {
        path: '/cash',
        target: 'cash-counted',
        title: { en: 'Counted cash', ur: 'گنی ہوئی نقدی' },
        body: {
          en: 'Type what you counted. The variance shows at once.',
          ur: 'جو گنا وہ لکھیں۔ فرق فوراً نظر آئے گا۔',
        },
      },
      {
        path: '/cash',
        target: 'cash-close',
        title: { en: 'Close drawer', ur: 'Close drawer' },
        body: {
          en: 'Closes today. Tomorrow a new drawer opens with the first cash receipt.',
          ur: 'آج کا دراز بند۔ کل پہلی نقد رسید پر نیا دراز کھل جائے گا۔',
        },
      },
    ],
  },
];
