/**
 * Settings & backup screens (M6) dictionary: backup status, "Download everything", restore drill,
 * alarms, recycle bin, data retention and About. Merged into i18n.ts as `backup` and into `errors`.
 * English is the source of truth; Urdu must match its shape (type-checked). Numbers only as
 * {{placeholders}} (Latin digits, isolated by the caller).
 */

export const backupErrorsEn = {
  export_finished: 'This download has finished. Start a new one.',
  export_expired: 'This download took too long. Start a new one.',
  name_taken: 'Another item with this name is in use. Rename it first.',
  parent_removed: 'Restore its class first.',
} as const;

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
      backup_stale: 'Nightly backup not running',
      backup_offsite: 'No off-site copy of the backups',
    },
    hints: {
      ledger_consistency:
        'Should never happen. Do not fix by hand: ask the volunteer who runs Maktab to look before more money is entered.',
      messages_stuck: 'Open the send queue and send or skip them.',
      messages_failed: 'Check the phone numbers and try again.',
      gate_lockouts:
        'Someone gave wrong answers 5 times. If it was not the parent, revoke that link.',
      billing_attention: 'Open fee generation and press Generate for that group to see the error.',
      backup_stale:
        'Backups have not run since {{date}}; check GitHub Actions (the nightly-backup workflow) and the Cloudflare API token.',
      backup_offsite:
        'The backups exist only on this server (last off-site copy: {{date}}). A fire or a dead disk would lose them: set up the off-site copy (docs/self-host.md).',
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
    hint: 'Older entries are deleted every night. Minimum 7 days, maximum 3650.',
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
