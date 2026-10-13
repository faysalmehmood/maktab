/**
 * Settings & backup screens (M6) dictionary: backup status, "Download everything", restore drill,
 * alarms, recycle bin, data retention and About. Merged into i18n.ts as `backup` and into `errors`.
 * English is the source of truth; Urdu must match its shape (type-checked). Numbers only as
 * {{placeholders}} (Latin digits, isolated by the caller).
 */

type Shape<T> = { readonly [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };

export const backupErrorsEn = {
  export_finished: 'This download has finished. Start a new one.',
  export_expired: 'This download took too long. Start a new one.',
  name_taken: 'Another item with this name is in use. Rename it first.',
  parent_removed: 'Restore its class first.',
} as const;

export const backupErrorsUr: Shape<typeof backupErrorsEn> = {
  export_finished: 'یہ ڈاؤن لوڈ مکمل ہو چکا ہے۔ نیا شروع کریں۔',
  export_expired: 'اس ڈاؤن لوڈ میں بہت دیر ہو گئی۔ نیا شروع کریں۔',
  name_taken: 'اسی نام کی ایک اور چیز استعمال میں ہے۔ پہلے اس کا نام بدلیں۔',
  parent_removed: 'پہلے اس کی جماعت بحال کریں۔',
};

export const backupEn = {
  templatesLink: 'Message templates and parent-link settings are under Messages.',
  openTemplates: 'Open message templates',
  status: {
    title: 'Nightly backup',
    lastRun: 'Last nightly backup',
    never: 'No nightly backup has reported yet.',
    notConfigured:
      'Backup reports are not set up on this server yet (BACKUP_REPORT_TOKEN). See docs/backup.md.',
    statuses: { ok: 'OK', partial: 'Partial', failed: 'Failed' },
    size: 'Size',
    targets: 'Copies',
    finished: 'Finished',
    file: 'File',
    viewRun: 'View run',
    objects: 'Latest files in the backup bucket',
    noObjects: 'No backup files yet.',
    noBucket: 'The backup bucket is not connected to this server.',
    history: 'Recent runs',
    kinds: { nightly: 'Nightly', drill: 'Restore drill', manual_drill: 'Drill (recorded)' },
  },
  timeTravel: {
    title: 'Undo recent damage (Time Travel)',
    body: 'Cloudflare keeps every change to the database for {{days}} days. A wrong edit or a bad import noticed within that time can be undone to any minute — but the restore replaces everything after that minute, so receipts entered since must be typed in again from the paper copies.',
    how: 'How: a volunteer runs "wrangler d1 time-travel restore" (docs/restore.md, section A).',
  },
  everything: {
    title: 'Download everything',
    body: 'One ZIP with a spreadsheet file (CSV) for every table, the database structure (schema.sql) and a README. Keep it somewhere safe: it holds every family, phone number and CNIC. Sign-in sessions and the parent-page access log are left out; parent links appear only as hashes.',
    start: 'Download everything',
    working: 'Preparing… {{table}} ({{n}} of {{total}})',
    done: 'Saved {{file}}: {{files}} files, {{rows}} rows',
    failed: 'The download stopped. Try again.',
  },
  drill: {
    title: 'Restore drill (once a term)',
    intro: 'Practise a restore so you know the backups work. Tick as you go.',
    steps: {
      key: 'The two trustees confirm they still have the backup key file and PARENT_LINK_SECRET.',
      run: 'Run the "restore-drill" workflow on GitHub (Actions → restore-drill → Run workflow).',
      check: 'The run is green: tables, triggers and views match, and the ledger check is empty.',
      compare:
        'Compare with today: the number of students and the latest receipt number look right.',
      record: 'Record the drill below.',
    },
    last: 'Last drill: {{date}}',
    never: 'No restore drill recorded yet.',
    date: 'Drill done on',
    note: 'Note (optional)',
    record: 'Record drill',
    recorded: 'Drill recorded',
  },
  alarms: {
    title: 'Alarms',
    allClear: 'All clear: nothing needs attention.',
    checked: 'Checked {{at}}',
    refresh: 'Check now',
    kinds: {
      ledger_consistency: 'Money records that do not add up',
      messages_stuck: 'Messages waiting more than 3 days',
      messages_failed: 'Messages that failed (last 7 days)',
      gate_lockouts: 'Parent-page lockouts (last 24 hours)',
      billing_attention: 'Monthly fees failing for a group',
    },
    hints: {
      ledger_consistency:
        'Should never happen. Do not fix by hand: ask the volunteer who runs Maktab to look before more money is entered.',
      messages_stuck: 'Open the send queue and send or skip them.',
      messages_failed: 'Check the phone numbers and try again.',
      gate_lockouts:
        'Someone gave wrong answers 5 times. If it was not the parent, revoke that link.',
      billing_attention: 'Open fee generation and press Generate for that group to see the error.',
    },
    banner: '{{count}} alarm(s) need attention',
    open: 'Open alarms',
    dismiss: 'Dismiss',
  },
  recycle: {
    title: 'Recycle bin',
    intro:
      'Classes, subjects, fee heads and empty groups you removed. Nothing is ever erased: restore brings it back as it was.',
    empty: 'The recycle bin is empty.',
    restore: 'Restore',
    restored: 'Restored',
    removedOn: 'Removed {{date}}',
    kinds: { programme: 'Class', subject: 'Subject', fee_head: 'Fee head', group: 'Group' },
    archiveGroup: 'Move to recycle bin',
    archiveHint: 'Only a group no student was ever enrolled in. Otherwise set it to Closed.',
    archived: 'Moved to the recycle bin',
  },
  series: {
    title: 'Receipt numbers',
    intro: 'Numbers are given out in order and can never be changed or reused.',
    last: 'Last issued',
    none: 'No receipts yet.',
  },
  retention: {
    title: 'Data retention',
    accessLog: 'Keep the parent-page access log for (days)',
    hint: 'Older entries are deleted every night. 7 to 3650 days.',
    saved: 'Retention saved',
  },
  about: {
    title: 'About Maktab',
    body: 'Maktab is free, open-source school and academy management, made for Pakistani community schools.',
    version: 'Version',
    commit: 'Build',
    source: 'Source code',
    contact: 'Contact',
    licence: 'Licence',
    licenceText:
      'GNU Affero General Public License v3.0: you may use, change and share it; changes you offer to others must stay open.',
    issues: 'Report a problem',
  },
} as const;

export const backupUr: Shape<typeof backupEn> = {
  templatesLink: 'پیغامات کے سانچے اور والدین کے لنک کی ترتیبات "پیغامات" میں ہیں۔',
  openTemplates: 'پیغامات کے سانچے کھولیں',
  status: {
    title: 'رات کا بیک اپ',
    lastRun: 'آخری رات کا بیک اپ',
    never: 'ابھی تک کسی رات کے بیک اپ کی اطلاع نہیں آئی۔',
    notConfigured:
      'اس سرور پر بیک اپ کی اطلاع ابھی ترتیب نہیں دی گئی (BACKUP_REPORT_TOKEN)۔ docs/backup.md دیکھیں۔',
    statuses: { ok: 'درست', partial: 'جزوی', failed: 'ناکام' },
    size: 'حجم',
    targets: 'نقول',
    finished: 'مکمل ہوا',
    file: 'فائل',
    viewRun: 'رن دیکھیں',
    objects: 'بیک اپ بکٹ کی تازہ فائلیں',
    noObjects: 'ابھی کوئی بیک اپ فائل نہیں۔',
    noBucket: 'بیک اپ بکٹ اس سرور سے منسلک نہیں۔',
    history: 'حالیہ رن',
    kinds: { nightly: 'رات کا', drill: 'بحالی کی مشق', manual_drill: 'مشق (درج شدہ)' },
  },
  timeTravel: {
    title: 'حالیہ نقصان واپس کریں (ٹائم ٹریول)',
    body: 'کلاؤڈ فلیئر ڈیٹا بیس کی ہر تبدیلی {{days}} دن تک محفوظ رکھتا ہے۔ اس مدت میں پتا چلنے والی غلط تبدیلی یا خراب امپورٹ کسی بھی منٹ تک واپس کی جا سکتی ہے — لیکن بحالی اس منٹ کے بعد کا سب کچھ بدل دیتی ہے، اس لیے اس کے بعد کی رسیدیں کاغذی نقول سے دوبارہ درج کرنی ہوں گی۔',
    how: 'طریقہ: ایک رضاکار "wrangler d1 time-travel restore" چلاتا ہے (docs/restore.md، حصہ A)۔',
  },
  everything: {
    title: 'سب کچھ ڈاؤن لوڈ کریں',
    body: 'ایک ZIP فائل جس میں ہر ٹیبل کی اسپریڈ شیٹ فائل (CSV)، ڈیٹا بیس کا ڈھانچہ (schema.sql) اور ایک README ہے۔ اسے محفوظ جگہ رکھیں: اس میں ہر خاندان، فون نمبر اور شناختی کارڈ نمبر ہے۔ سائن اِن سیشن اور والدین کے صفحے کا رسائی ریکارڈ شامل نہیں؛ والدین کے لنک صرف ہیش کی صورت میں ہیں۔',
    start: 'سب کچھ ڈاؤن لوڈ کریں',
    working: 'تیاری… {{table}} ({{n}} از {{total}})',
    done: '{{file}} محفوظ: {{files}} فائلیں، {{rows}} قطاریں',
    failed: 'ڈاؤن لوڈ رک گیا۔ دوبارہ کوشش کریں۔',
  },
  drill: {
    title: 'بحالی کی مشق (ہر ٹرم میں ایک بار)',
    intro: 'بحالی کی مشق کریں تاکہ معلوم ہو کہ بیک اپ کام کرتے ہیں۔ ہر قدم پر نشان لگائیں۔',
    steps: {
      key: 'دونوں امین تصدیق کریں کہ بیک اپ کی کلید والی فائل اور PARENT_LINK_SECRET ان کے پاس ہیں۔',
      run: 'گِٹ ہب پر "restore-drill" ورک فلو چلائیں (Actions ← restore-drill ← Run workflow)۔',
      check: 'رن سبز ہو: ٹیبل، ٹرگر اور ویو مطابق ہوں اور حساب کی جانچ خالی ہو۔',
      compare: 'آج سے موازنہ کریں: طلبہ کی تعداد اور آخری رسید نمبر درست لگیں۔',
      record: 'نیچے مشق درج کریں۔',
    },
    last: 'آخری مشق: {{date}}',
    never: 'ابھی تک کوئی بحالی کی مشق درج نہیں۔',
    date: 'مشق کی تاریخ',
    note: 'نوٹ (اختیاری)',
    record: 'مشق درج کریں',
    recorded: 'مشق درج ہو گئی',
  },
  alarms: {
    title: 'انتباہات',
    allClear: 'سب ٹھیک ہے: کسی چیز پر توجہ کی ضرورت نہیں۔',
    checked: 'جانچ: {{at}}',
    refresh: 'ابھی جانچیں',
    kinds: {
      ledger_consistency: 'رقم کے ریکارڈ جو آپس میں نہیں ملتے',
      messages_stuck: '3 دن سے زیادہ منتظر پیغامات',
      messages_failed: 'ناکام پیغامات (پچھلے 7 دن)',
      gate_lockouts: 'والدین کے صفحے کی بندشیں (پچھلے 24 گھنٹے)',
      billing_attention: 'کسی گروپ کی ماہانہ فیس بن نہیں رہی',
    },
    hints: {
      ledger_consistency:
        'ایسا کبھی نہیں ہونا چاہیے۔ ہاتھ سے درست نہ کریں: مزید رقم درج کرنے سے پہلے مکتب چلانے والے رضاکار سے جانچ کروائیں۔',
      messages_stuck: 'بھیجنے کی قطار کھولیں اور انہیں بھیجیں یا چھوڑ دیں۔',
      messages_failed: 'فون نمبر جانچیں اور دوبارہ کوشش کریں۔',
      gate_lockouts: 'کسی نے 5 بار غلط جواب دیا۔ اگر یہ والدین نہیں تھے تو وہ لنک منسوخ کریں۔',
      billing_attention:
        'فیس بنانے کا صفحہ کھولیں اور اس گروپ کے لیے "بنائیں" دبا کر خرابی دیکھیں۔',
    },
    banner: '{{count}} انتباہ توجہ چاہتے ہیں',
    open: 'انتباہات کھولیں',
    dismiss: 'بند کریں',
  },
  recycle: {
    title: 'ری سائیکل بن',
    intro:
      'جماعتیں، مضامین، فیس کی مدیں اور خالی گروپ جو آپ نے ہٹائے۔ کچھ بھی مٹایا نہیں جاتا: بحال کرنے سے وہ پہلے جیسا واپس آ جاتا ہے۔',
    empty: 'ری سائیکل بن خالی ہے۔',
    restore: 'بحال کریں',
    restored: 'بحال ہو گیا',
    removedOn: 'ہٹایا گیا {{date}}',
    kinds: { programme: 'جماعت', subject: 'مضمون', fee_head: 'فیس کی مد', group: 'گروپ' },
    archiveGroup: 'ری سائیکل بن میں ڈالیں',
    archiveHint: 'صرف وہ گروپ جس میں کبھی کوئی طالب علم داخل نہ ہوا ہو۔ ورنہ اسے بند کریں۔',
    archived: 'ری سائیکل بن میں ڈال دیا گیا',
  },
  series: {
    title: 'رسید نمبر',
    intro: 'نمبر ترتیب سے دیے جاتے ہیں اور کبھی بدلے یا دوبارہ استعمال نہیں ہوتے۔',
    last: 'آخری جاری',
    none: 'ابھی کوئی رسید نہیں۔',
  },
  retention: {
    title: 'ڈیٹا کی مدت',
    accessLog: 'والدین کے صفحے کا رسائی ریکارڈ رکھیں (دن)',
    hint: 'پرانے اندراج ہر رات حذف ہو جاتے ہیں۔ 7 سے 3650 دن۔',
    saved: 'مدت محفوظ ہو گئی',
  },
  about: {
    title: 'مکتب کا تعارف',
    body: 'مکتب مفت اور اوپن سورس اسکول و اکیڈمی کا انتظامی نظام ہے، جو پاکستانی کمیونٹی اسکولوں کے لیے بنایا گیا ہے۔',
    version: 'ورژن',
    commit: 'بلڈ',
    source: 'سورس کوڈ',
    contact: 'رابطہ',
    licence: 'لائسنس',
    licenceText:
      'GNU Affero General Public License v3.0: آپ اسے استعمال کر سکتے ہیں، بدل سکتے ہیں اور بانٹ سکتے ہیں؛ دوسروں کو دی گئی تبدیلیاں بھی کھلی رہیں گی۔',
    issues: 'مسئلہ بتائیں',
  },
};
