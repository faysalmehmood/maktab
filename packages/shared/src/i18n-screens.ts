/**
 * M7b part 2 dictionary (UI plan §5.5 screens): strings the restyled screens added. Kept out of the
 * first-load `en` bundle (budget headroom ≈ 4 KB): apps/web/src/i18n/screens.ts merges it into
 * i18next as `screens.*` when the first lazy screen that needs it loads. Urdu lives in i18n-ur.ts
 * (`screensUr`), which is already its own chunk. Numbers only as {{placeholders}}.
 */

export const screensEn = {
  att: {
    progress: '{{done}} of {{total}} registers taken',
    progressLabel: 'Registers taken',
    absentSoFar_one: '{{count}} absent so far',
    absentSoFar_other: '{{count}} absent so far',
    toTake: 'To take',
    takenList: 'Taken',
    classes_one: '{{count}} register',
    classes_other: '{{count}} registers',
    allTaken: 'Every register for this day is taken.',
    allPresent: 'All present',
    absentN: '{{n}} absent',
    presentN: '{{n}} present',
    noClassTeacher: 'No class teacher',
    marked: '{{present}} of {{total}} present',
    marksLabel: 'Marks so far',
    correctionMode:
      'This register was already taken. Saving makes a correction: it asks for a reason and keeps the earlier register in history.',
    noteSaved: 'Note',
  },
  profile: {
    overview: 'Overview',
    fees: 'Fees',
    messages: 'Messages',
    sections: 'Student sections',
    collect: 'Collect fee',
    more: 'More actions: {{name}}',
    class: 'Class',
    attendance: 'Attendance this month',
    dues: 'This child owes',
    familyOwes: 'Family owes',
    siblings_one: '{{count}} sibling',
    siblings_other: '{{count}} siblings',
    details: 'Details',
    noSiblings: 'No brothers or sisters admitted yet.',
    noGuardians: 'No guardian added yet.',
    noMessages: 'No messages for this family yet.',
    openQueue: 'Open messages',
  },
  fees: {
    payment: 'Payment',
    fullDue: 'Full due',
    previewEmpty: 'Type an amount to see which months it pays.',
    received: 'Payment received',
    reversedShort: 'Reversed',
    receiptMore: 'More actions: {{no}}',
    amount: 'Amount',
    payer: 'Paid by',
    stillDue: 'Still due',
  },
} as const;
