import {
  type CashSessionDto,
  type FamilyStatementDto,
  type FeeLineDto,
  type FeeSettingsDto,
  RECEIPT_LABELS,
  type ReceiptPrintDto,
} from '@maktab/shared';
import { ids } from './api-mock';

export const fam = ids.family;
export const ali = '01JAAAAAAAAAAAAAAAAAAAAAB1';
export const sara = '01JAAAAAAAAAAAAAAAAAAAAAB2';
export const receiptId = '01JAAAAAAAAAAAAAAAAAAAAAR1';
export const bankAcc = '01JAAAAAAAAAAAAAAAAAAAAAK1';
export const walletAcc = '01JAAAAAAAAAAAAAAAAAAAAAK2';
const RS = (n: number) => n * 100;

export function line(p: Partial<FeeLineDto> & { id: string }): FeeLineDto {
  return {
    student_id: ali,
    student_name: 'Ali',
    admission_no: 'A-1',
    fee_head_id: 'H-TUI',
    head_name: 'Tuition',
    head_name_ur: 'ٹیوشن فیس',
    head_kind: 'tuition',
    period_key: '2026-09',
    due_date: '2026-09-10',
    payer_type: 'family',
    payer_id: fam,
    gross: RS(3000),
    concession: 0,
    fine: 0,
    adjustment: 0,
    net: RS(3000),
    paid: 0,
    due: RS(3000),
    status: 'overdue',
    ...p,
  };
}

/** Deliberately out of order: the preview must sort the way the server allocates. */
export const familyLines: FeeLineDto[] = [
  line({
    id: 'C-SARA-10',
    student_id: sara,
    student_name: 'Sara',
    period_key: '2026-10',
    due_date: '2026-10-10',
    gross: RS(3500),
    concession: -RS(350),
    net: RS(3150),
    due: RS(3150),
    status: 'due',
  }),
  line({ id: 'C-ALI-10-TUI', period_key: '2026-10', due_date: '2026-10-10', status: 'due' }),
  line({
    id: 'C-ALI-10-ADM',
    period_key: '2026-10',
    due_date: '2026-10-10',
    fee_head_id: 'H-ADM',
    head_name: 'Admission',
    head_name_ur: 'داخلہ فیس',
    head_kind: 'admission',
    gross: RS(5000),
    net: RS(5000),
    due: RS(5000),
    status: 'due',
  }),
  line({
    id: 'C-SARA-09',
    student_id: sara,
    student_name: 'Sara',
    gross: RS(3500),
    concession: -RS(350),
    net: RS(3150),
    due: RS(3150),
  }),
  line({
    id: 'C-ALI-09',
    fine: RS(200),
    net: RS(3200),
    paid: RS(1000),
    due: RS(2200),
    status: 'overdue',
  }),
  line({
    id: 'C-ALI-08',
    period_key: '2026-08',
    due_date: '2026-08-10',
    paid: RS(3000),
    due: 0,
    status: 'paid',
  }),
];

export function familyStatement(o: Partial<FamilyStatementDto> = {}): FamilyStatementDto {
  const open = familyLines.filter((l) => l.due > 0);
  const dueBefore = open.reduce((a, l) => a + l.due, 0);
  const credit = RS(500);
  return {
    family: { id: fam, name: 'Raza family', area: null },
    students: [
      {
        id: ali,
        name: 'Ali',
        admission_no: 'A-1',
        status: 'active',
        group: 'Class 5 A',
        sponsored: false,
      },
      {
        id: sara,
        name: 'Sara',
        admission_no: 'A-2',
        status: 'active',
        group: 'Class 5 B',
        sponsored: true,
      },
    ],
    charges: familyLines,
    sponsored: [
      line({
        id: 'S-SARA-10',
        student_id: sara,
        student_name: 'Sara',
        payer_type: 'sponsor',
        payer_id: 'SP1',
        period_key: '2026-10',
        due_date: '2026-10-10',
        gross: RS(1000),
        net: RS(1000),
        due: RS(1000),
        status: 'due',
      }),
    ],
    receipts: [],
    credit,
    dues_hash: 'hash-1',
    totals: {
      gross: 0,
      concession: 0,
      fine: 0,
      net: 0,
      paid: 0,
      due: dueBefore - credit,
      overdue: RS(5350),
      due_before_credit: dueBefore,
    },
    fines: [
      {
        id: 'F-ALI-09',
        root_id: 'C-ALI-09',
        student_id: ali,
        period_key: '2026-09',
        amount: RS(200),
        waived: 0,
        left: RS(200),
      },
    ],
    ...o,
  };
}

export const accounts = {
  accounts: [
    { id: bankAcc, name: 'HBL current', kind: 'bank', holder_staff_id: null },
    { id: walletAcc, name: 'JazzCash 0300', kind: 'wallet', holder_staff_id: null },
  ],
};

export const feeSettings: { fees: FeeSettingsDto } = {
  fees: {
    fine_rule: { enabled: true, grace_day: 15, type: 'fixed', value: RS(200), cap: null },
    sibling_rule: [{ nth: 2, pct: 10 }],
    reminder_cooldown_days: 7,
    due_day: 10,
    receipt_prefix: 'AN',
    receipts_issued: true,
  },
};

export function receiptPrint(o: Partial<ReceiptPrintDto> = {}): ReceiptPrintDto {
  return {
    school: {
      name: 'Al-Noor',
      name_ur: 'النور',
      address: null,
      phone: '0300 1234567',
      has_logo: false,
    },
    labels: RECEIPT_LABELS,
    lang: 'ur',
    receipt: {
      id: receiptId,
      receipt_no: 'AN-2026-00001',
      kind: 'payment',
      reverses_id: null,
      reversed_by: null,
      payer_type: 'family',
      payer_id: fam,
      payer_name: 'Raza family',
      amount: RS(7000),
      method: 'jazzcash',
      account_id: walletAcc,
      collector_id: 'U1',
      collector_name: 'Owner',
      cash_session_id: null,
      business_date: '2026-10-10',
      reference: 'TX123',
      note: null,
      created_at: '2026-10-10T05:00:00Z',
    },
    students: [
      {
        student_id: ali,
        student_name: 'Ali',
        admission_no: 'A-1',
        lines: [
          {
            charge_id: 'C-ALI-09',
            period_key: '2026-09',
            head_name: 'Tuition',
            head_name_ur: 'ٹیوشن فیس',
            amount: RS(2200),
          },
        ],
        subtotal: RS(2200),
      },
    ],
    totals: {
      amount: RS(7000),
      allocated: RS(5350),
      credit_added: RS(1650),
      payer_due: RS(11000),
      payer_credit: RS(2150),
    },
    reversed: false,
    ...o,
  };
}

export const cashSession = (o: Partial<CashSessionDto> = {}): CashSessionDto => ({
  id: 'CS1',
  collector_id: '01JABCDEFGHJKMNPQRSTVWXYZ0',
  collector_name: 'O',
  business_date: '2026-10-10',
  opening: 0,
  expected: RS(7000),
  counted: null,
  variance: null,
  closed_at: null,
  closed_by: null,
  reopened_by: null,
  reopened_at: null,
  reopen_reason: null,
  by_method: [{ method: 'cash', amount: RS(7000), count: 2 }],
  ...o,
});
