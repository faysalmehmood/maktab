import { DEFAULT_TEMPLATES } from '@maktab/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import {
  addConcession,
  applyCredit,
  applyLateFines,
  approvePayslip,
  closeSession,
  collect,
  endConcession,
  expectedSql,
  generateChunkOrLog,
  generatePayslips,
  generationCursor,
  openDues,
  openSession,
  paySalary,
  recordAdvance,
  recordExpense,
  recordOpeningBalance,
  recordTransfer,
  refund,
  reverseReceipt,
  runBatch,
  sessionFor,
  sessionIdFor,
  setAccountOpening,
  voidExpense,
  waiveFine,
} from '../ledger';
import {
  addDay,
  CLASS_TEACHER,
  DEMO_SEED,
  DEMO_USERS,
  type DemoCalendar,
  daysOf,
  demoAdmissionSeries,
  demoIds,
  type Family,
  GROUPS,
  hashSeed,
  holidays,
  LEAVER_MONTH,
  monthName,
  officeDayFrom,
  officeDays,
  officeOpen,
  PROGRAMMES,
  RECEIPT_PREFIX,
  rng,
  rupees,
  STAFF,
  type Student,
  SUBJECTS,
  subjectTeachers,
  type World,
  weekday,
  world,
} from './world';

/**
 * The demo dataset as an ordered list of resumable steps (docs/demo.md). A step is called with a
 * cursor (`sub`, starting at 0) and returns the next cursor, or null when it is finished; each call
 * does a small bounded amount of work (a handful of D1 queries) so a Worker invocation on the free
 * plan can run several. Every call is idempotent — deterministic ids, idempotency keys and
 * "already done?" reads — so a call cut short (CPU limit, lost response) is simply run again.
 *
 * Money is written only through the ledger helpers (generateChunkOrLog, collect, reverseReceipt,
 * refund, applyLateFines, waiveFine, recordExpense, recordAdvance, generatePayslips, approvePayslip,
 * paySalary, recordTransfer, closeSession, recordOpeningBalance, addConcession, setAccountOpening);
 * reference data, people, registers and message rows are bulk inserts (json_each, ≤ 150 rows each).
 */

export type StepCtx = {
  db: AppDb;
  w: World;
  /** The seed day and everything dated from it (world.ts). */
  cal: DemoCalendar;
  /** PARENT_LINK_SECRET: parent links are made only when it is known. */
  parentSecret?: string;
  /** The installation owner's Google address (OWNER_EMAIL): an extra owner login for the reset. */
  ownerEmail?: string;
};
export type Step = {
  name: string;
  run: (ctx: StepCtx, sub: number) => Promise<number | null>;
  /** Step calls one run counts as against an invocation's maxCalls (default 1). */
  cost?: number;
};

// ---- ids and small helpers ---------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A ULID-shaped id timed at `date` (so ids sort chronologically), random part from `key`. */
export function dayId(date: string, key: string): string {
  let t = Date.parse(`${date}T04:00:00Z`) + (hashSeed(key) % 3_600_000);
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const r = rng(hashSeed(`id:${key}`));
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[Math.floor(r.next() * 32)];
  return time + rand;
}

const ids = () => demoIds;
const userId = (k: keyof typeof DEMO_USERS) => ids()(`user:${k}`);
const staffId = (k: string) => ids()(`staff:${k}`);
const grpId = (k: string) => ids()(`grp:${k}`);
const progId = (k: string) => ids()(`programme:${k}`);
const ACCOUNTS = {
  drawer: () => ids()('account:drawer'),
  bank: () => ids()('account:bank'),
  wallet: () => ids()('account:wallet'),
};
const HEADS = {
  tuition: () => ids()('head:tuition'),
  academy: () => ids()('head:academy'),
  admission: () => ids()('head:admission'),
  exam: () => ids()('head:exam'),
  activity: () => ids()('head:activity'),
};
const SPONSORS = [
  { key: 'trust', name: 'Haji Abdul Rauf Educational Trust', phone: '924235550190' },
  { key: 'alumna', name: 'Mrs. Shamim Akhtar (alumna)', phone: '923005550191' },
  { key: 'society', name: 'Faisal Town Welfare Society', phone: '924235550192' },
];
const sponsorId = (k: string) => ids()(`sponsor:${k}`);

const tuitionOfProgramme = (k: string) => PROGRAMMES.find((p) => p.key === k)?.tuition ?? 0;
const periodEnd = (p: string) => daysOf(p).at(-1) as string;
const activeIn = (s: Student, p: string) =>
  s.start <= periodEnd(p) && (!s.leftOn || s.leftOn >= `${p}-01`);
const activeOn = (s: Student, d: string) => s.start <= d && (!s.leftOn || s.leftOn >= d);

/** INSERT … SELECT json_extract(…) FROM json_each(?): one bound parameter per ≤ 150 rows. */
function bulk(table: string, rows: Record<string, unknown>[]): SQL[] {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0] as object);
  const out: SQL[] = [];
  for (let i = 0; i < rows.length; i += 150) {
    const json = JSON.stringify(rows.slice(i, i + 150));
    out.push(
      sql`INSERT INTO ${sql.raw(`"${table}" (${cols.map((c) => `"${c}"`).join(', ')})`)}
          SELECT ${sql.raw(cols.map((c) => `json_extract(value, '$.${c}')`).join(', '))}
          FROM json_each(${json})`,
    );
  }
  return out;
}

const exists = async (db: AppDb, q: SQL) => (await db.all(q)).length > 0;

/** A step made of a fixed list of ops: one op per call. */
function opsStep(name: string, ops: ((ctx: StepCtx) => Promise<void>)[]): Step {
  return {
    name,
    run: async (ctx, sub) => {
      const op = ops[sub];
      if (op) await op(ctx);
      return sub + 1 < ops.length ? sub + 1 : null;
    },
  };
}

// ---- reference data and people ---------------------------------------------------------------

/** The eight categories migration 0014 seeds (same ids and codes), re-created after a wipe. */
const EXPENSE_CATEGORIES = [
  ['expcat_rent', 'Rent', 'کرایہ', 'rent', 0, 10],
  ['expcat_utilities', 'Utilities', 'بل (بجلی، گیس، پانی)', 'utilities', 0, 20],
  ['expcat_salaries', 'Salaries', 'تنخواہیں', 'salaries', 1, 30],
  ['expcat_stationery', 'Stationery', 'اسٹیشنری', 'stationery', 0, 40],
  ['expcat_maintenance', 'Maintenance', 'مرمت و دیکھ بھال', 'maintenance', 0, 50],
  ['expcat_transport', 'Transport', 'ٹرانسپورٹ', 'transport', 0, 60],
  ['expcat_exam', 'Exams', 'امتحانات', 'exam', 0, 70],
  ['expcat_misc', 'Miscellaneous', 'متفرق', 'misc', 0, 80],
] as const;

async function baseData(ctx: StepCtx): Promise<void> {
  const { db, cal } = ctx;
  if (await exists(db, sql`SELECT 1 FROM school`)) return;
  const by = userId('principal');
  const stmts: SQL[] = [];
  const users: {
    id: string;
    email: string;
    name: string;
    status: string;
    created_by: string | null;
  }[] = (Object.keys(DEMO_USERS) as (keyof typeof DEMO_USERS)[]).map((k) => ({
    id: userId(k),
    email: DEMO_USERS[k],
    name: STAFF.find((s) => s.login === k)?.name ?? k,
    status: 'active',
    created_by: k === 'principal' ? null : by,
  }));
  const owner = ctx.ownerEmail?.trim().toLowerCase();
  if (owner && !users.some((u) => u.email === owner))
    users.push({
      id: ids()('user:owner'),
      email: owner,
      name: '',
      status: 'active',
      created_by: by,
    });
  stmts.push(...bulk('user', users));
  stmts.push(
    ...bulk('role', [
      ...STAFF.flatMap((s) =>
        s.login ? (s.roles ?? []).map((role) => ({ user_id: userId(s.login as never), role })) : [],
      ),
      ...(users.length > 4 ? [{ user_id: ids()('user:owner'), role: 'owner' }] : []),
    ]),
  );
  stmts.push(
    sql`INSERT INTO school (id, name, name_ur, mode, address, phone, default_lang, short_name, city,
          brand_color, receipt_prefix, setup_completed_at, attendance_mode, weekly_off, fine_rule,
          parent_gate, reminder_cooldown_days, announcement_groups_note, created_by)
        VALUES (${ids()('school')}, 'Al-Noor Community School', 'النور کمیونٹی اسکول', 'both',
          '14-C Main Boulevard, Faisal Town, Lahore', '924235550100', 'en', 'AN', 'Lahore', 'maroon',
          ${RECEIPT_PREFIX}, ${`${addDay(cal.start, -4)}T05:00:00.000Z`}, 'daily', '[0]',
          ${JSON.stringify({ enabled: true, grace_day: 10, type: 'fixed', value: rupees(200), cap: null })},
          'birth_year', 7, 'One WhatsApp group per class, run by the class teacher. Fee matters by direct message only.',
          ${by})`,
  );
  const session = ids()('session');
  stmts.push(
    sql`INSERT INTO session (id, name, start_date, end_date, is_current, created_by)
        VALUES (${session}, '2026-27', ${cal.sessionStart}, ${cal.sessionEnd}, 1, ${by})`,
    ...bulk('term', [
      {
        id: ids()('term:1'),
        session_id: session,
        name: 'First term',
        seq: 1,
        start_date: cal.sessionStart,
        end_date: '2026-08-31',
        created_by: by,
      },
      {
        id: ids()('term:2'),
        session_id: session,
        name: 'Second term',
        seq: 2,
        start_date: '2026-09-01',
        end_date: cal.sessionEnd,
        created_by: by,
      },
    ]),
    ...bulk(
      'holiday',
      // The session's own calendar only (each row is a write).
      holidays()
        .filter((h) => h.date >= cal.sessionStart && h.date <= cal.sessionEnd)
        .map((h) => ({ date: h.date, name_en: h.en, name_ur: h.ur, created_by: by })),
    ),
  );
  const grades = PROGRAMMES.filter((p) => p.kind === 'grade');
  stmts.push(
    ...bulk(
      'programme',
      PROGRAMMES.map((p) => {
        const i = grades.indexOf(p);
        return {
          id: progId(p.key),
          name: p.name,
          kind: p.kind,
          seq: p.seq,
          next_programme_id:
            i >= 0 && grades[i + 1] ? progId((grades[i + 1] as { key: string }).key) : null,
          duration_weeks: p.key === 'fsc' ? 96 : p.key === 'matric' ? 40 : null,
          created_by: by,
        };
      }),
    ),
    ...bulk(
      'subject',
      SUBJECTS.map((s) => ({
        id: ids()(`subject:${s.key}`),
        name: s.name,
        short_name: s.short,
        created_by: by,
      })),
    ),
    ...bulk(
      'staff',
      STAFF.map((s) => ({
        id: staffId(s.key),
        user_id: s.login ? userId(s.login) : null,
        name: s.name,
        phone: s.phone,
        role: s.role,
        joined: s.joined,
        base_salary: s.salary,
        allowances: JSON.stringify(
          s.allowance
            ? [{ label: 'House rent', amount: s.allowance }]
            : [{ label: 'Conveyance', amount: rupees(3000) }],
        ),
        status: 'active',
        created_by: by,
      })),
    ),
    ...bulk(
      'grp',
      GROUPS.map((g) => ({
        id: grpId(g.key),
        programme_id: progId(g.programme),
        session_id: g.primary ? session : null,
        name: g.name,
        is_primary: g.primary ? 1 : 0,
        class_teacher_id: staffId(CLASS_TEACHER[g.key] as string),
        capacity: g.primary ? 25 : 30,
        days: g.days ?? null,
        start_time: g.start ?? null,
        end_time: g.end ?? null,
        room: g.primary ? `Room ${GROUPS.indexOf(g) + 1}` : 'Science block',
        status: 'running',
        created_by: by,
      })),
    ),
    ...bulk(
      'grp_subject',
      GROUPS.flatMap((g) =>
        subjectTeachers(g).map(([s, t]) => ({
          id: ids()(`grp_subject:${g.key}:${s}`),
          grp_id: grpId(g.key),
          subject_id: ids()(`subject:${s}`),
          teacher_id: staffId(t),
          created_by: by,
        })),
      ),
    ),
    ...bulk('account', [
      {
        id: ACCOUNTS.drawer(),
        name: 'Cash drawer (accounts office)',
        kind: 'cash',
        holder_staff_id: staffId('accountant'),
        created_by: by,
      },
      {
        id: ACCOUNTS.bank(),
        name: 'Meezan Bank (school current account)',
        kind: 'bank',
        holder_staff_id: null,
        created_by: by,
      },
      {
        id: ACCOUNTS.wallet(),
        name: 'JazzCash (school wallet)',
        kind: 'wallet',
        holder_staff_id: null,
        created_by: by,
      },
    ]),
    ...bulk('fee_head', [
      {
        id: HEADS.tuition(),
        name: 'Monthly tuition',
        name_ur: 'ماہانہ فیس',
        kind: 'tuition',
        cadence: 'monthly',
        created_by: by,
      },
      {
        id: HEADS.academy(),
        name: 'Academy tuition',
        name_ur: 'اکیڈمی فیس',
        kind: 'course',
        cadence: 'monthly',
        created_by: by,
      },
      {
        id: HEADS.admission(),
        name: 'Admission fee',
        name_ur: 'داخلہ فیس',
        kind: 'admission',
        cadence: 'once',
        created_by: by,
      },
      {
        id: HEADS.exam(),
        name: 'Examination fee',
        name_ur: 'امتحانی فیس',
        kind: 'exam',
        cadence: 'per_term',
        created_by: by,
      },
      {
        id: HEADS.activity(),
        name: 'Annual activity fund',
        name_ur: 'سالانہ سرگرمی فنڈ',
        kind: 'misc',
        cadence: 'per_term',
        created_by: by,
      },
    ]),
  );
  const rate = (head: string, programme: string, amount: number, from: string) => ({
    id: ids()(`rate:${head}:${programme}:${from}`),
    fee_head_id: head,
    programme_id: progId(programme),
    amount,
    effective_from: from,
    created_by: by,
  });
  const from = cal.sessionStart;
  // From the day after the history starts: continuing students (enrolled on that day) are never
  // billed admission.
  const joinFrom = addDay(cal.start, 1);
  stmts.push(
    ...bulk('fee_rate', [
      ...grades.map((p) => rate(HEADS.tuition(), p.key, p.tuition, from)),
      rate(HEADS.academy(), 'fsc', tuitionOfProgramme('fsc'), from),
      rate(HEADS.academy(), 'matric', tuitionOfProgramme('matric'), from),
      ...grades.map((p) => rate(HEADS.admission(), p.key, rupees(5000), joinFrom)),
      rate(HEADS.admission(), 'fsc', rupees(3000), joinFrom),
      // Both per-term heads are billed with the second term (1 September), the one term start that
      // falls inside the history for most seed days.
      ...['c5', 'c6', 'c7', 'c8', 'c9', 'c10'].map((p) =>
        rate(HEADS.exam(), p, rupees(800), '2026-09-01'),
      ),
      ...['nursery', 'prep', 'c1', 'c2', 'c3'].map((p) =>
        rate(HEADS.activity(), p, rupees(1500), '2026-09-01'),
      ),
    ]),
    ...bulk(
      'expense_category',
      EXPENSE_CATEGORIES.map(([id, name, name_ur, code, system, sort]) => ({
        id,
        name,
        name_ur,
        code,
        system,
        sort,
      })),
    ),
    ...bulk(
      'message_template',
      Object.entries(DEFAULT_TEMPLATES).flatMap(([key, langs]) =>
        Object.entries(langs).map(([lang, body]) => ({ key, lang, body })),
      ),
    ),
    ...bulk(
      'admission_series',
      demoAdmissionSeries(ctx.w).map((a) => ({ series: a.series, last_no: a.last })),
    ),
  );
  await runBatch(db, stmts);
}

async function people(ctx: StepCtx): Promise<void> {
  const { db, w, cal } = ctx;
  if (await exists(db, sql`SELECT 1 FROM family LIMIT 1`)) return;
  const by = userId('admin');
  const stmts: SQL[] = [
    ...bulk(
      'family',
      w.families.map((f) => ({
        id: f.id,
        name: f.name,
        address: f.address,
        area: f.area,
        created_by: by,
      })),
    ),
    ...bulk(
      'guardian',
      w.families.flatMap((f) =>
        f.guardians.map((g) => ({
          id: g.id,
          family_id: f.id,
          name: g.name,
          relation: g.relation,
          cnic: g.cnic,
          phone: g.phone,
          priority: g.priority,
          consent_whatsapp: g.consent ? 1 : 0,
          consent_sms: 0,
          lang: g.lang,
          created_by: by,
        })),
      ),
    ),
    ...bulk(
      'student',
      w.students.map((s) => {
        const fam = w.families.find((f) => f.id === s.familyId) as Family;
        return {
          id: s.id,
          family_id: s.familyId,
          admission_no: s.admissionNo,
          name: s.name,
          father_name: fam.guardians[0]?.name ?? null,
          dob: s.dob,
          gender: s.gender,
          admission_date: s.admissionDate,
          status: s.leftOn ? 'left' : 'active',
          left_date: s.leftOn,
          left_reason: s.leftOn ? 'Family moved to Islamabad' : null,
          created_by: by,
        };
      }),
    ),
    ...bulk('enrolment', [
      ...w.students.map((s) => ({
        id: s.enrolmentId,
        student_id: s.id,
        grp_id: grpId(s.group),
        is_primary: 1,
        roll_no: String(s.rollNo),
        start_date: s.start,
        end_date: s.leftOn,
        status: s.leftOn ? 'withdrawn' : 'active',
        end_reason: s.leftOn ? 'Family moved to Islamabad' : null,
        created_by: by,
      })),
      ...w.students
        .filter((s) => s.evening)
        .map((s) => ({
          id: s.evening?.enrolmentId,
          student_id: s.id,
          grp_id: grpId('matric-evening'),
          is_primary: 0,
          roll_no: null,
          start_date: cal.start,
          end_date: null,
          status: 'active',
          end_reason: null,
          created_by: by,
        })),
    ]),
  ];
  await runBatch(db, stmts);
}

// ---- concessions, sponsors, openings ----------------------------------------------------------

type Pick = {
  s: Student;
  type: 'pct' | 'fixed';
  value: number;
  reason: 'sibling' | 'needy' | 'scholarship' | 'topper';
  note: string;
};

/** 12 concessions: 4 sibling, 4 needy, 2 scholarship, 2 topper (deterministic picks). */
export function concessionPicks(w: World): Pick[] {
  const r = rng(DEMO_SEED + 7);
  const taken = new Set<string>();
  const out: Pick[] = [];
  const eligible = w.students.filter((s) => !s.leftOn && !s.joiner);
  const take = (cands: Student[], n: number, f: (s: Student, i: number) => Omit<Pick, 's'>) => {
    for (const s of r.shuffle([...cands])) {
      if (n <= 0) break;
      if (taken.has(s.id)) continue;
      taken.add(s.id);
      out.push({ s, ...f(s, n) });
      n--;
    }
  };
  const younger = eligible.filter((s) => {
    const fam = w.families.find((f) => f.id === s.familyId) as Family;
    return fam.students.length >= 3 && fam.students.indexOf(s) >= 2;
  });
  take(younger, 4, (_, n) => ({
    type: 'pct',
    value: n % 2 ? 15 : 10,
    reason: 'sibling',
    note: 'Third child in the school',
  }));
  const needyNotes = [
    'Father lost his job',
    'Widowed mother',
    'Daily-wage family',
    'Long illness in the family',
    'Flood-affected relatives',
  ];
  take(eligible, 4, (_, n) => ({
    type: 'pct',
    value: [25, 30, 40, 50, 50][n - 1] as number,
    reason: 'needy',
    note: needyNotes[n - 1] as string,
  }));
  take(
    eligible.filter((s) => ['c8a', 'c8b', 'c9a', 'c10a'].includes(s.group)),
    2,
    (_, n) => ({
      type: 'pct',
      value: n === 2 ? 100 : 50,
      reason: 'scholarship',
      note:
        n === 2 ? 'Full merit scholarship (Class 8 board, 1st in district)' : 'Merit scholarship',
    }),
  );
  take(
    eligible.filter((s) => ['c5a', 'c6b', 'c7a'].includes(s.group)),
    2,
    () => ({
      type: 'fixed',
      value: rupees(1000),
      reason: 'topper',
      note: 'Class topper, annual result 2026',
    }),
  );
  return out;
}

export function sponsorshipPicks(
  w: World,
): { sponsor: string; s: Student; pct: number; tuitionOnly: boolean }[] {
  const conc = new Set(concessionPicks(w).map((p) => p.s.id));
  const pool = w.students.filter(
    (s) => !s.leftOn && !s.joiner && !conc.has(s.id) && !s.evening && s.group !== 'fsc-morning',
  );
  const r = rng(DEMO_SEED + 11);
  const picks = r.shuffle([...pool]).slice(0, 7);
  return picks.map((s, i) => ({
    sponsor: i < 3 ? 'trust' : i < 5 ? 'alumna' : 'society',
    s,
    pct: i < 3 ? 100 : i < 5 ? 50 : 100,
    tuitionOnly: i >= 3,
  }));
}

export function openingPicks(w: World): { s: Student; amount: number; note: string }[] {
  const r = rng(DEMO_SEED + 13);
  const singles = w.families.filter((f) => f.students.length === 1 && !f.students[0]?.leftOn);
  return r
    .shuffle([...singles])
    .slice(0, 10)
    .map((f, i) => ({
      s: f.students[0] as Student,
      amount:
        i < 8
          ? rupees([2500, 3000, 4500, 6000, 7200, 9000, 3500, 5000][i] as number)
          : -rupees(1500),
      note: i < 8 ? 'Unpaid dues carried from the paper register' : 'Advance paid before Maktab',
    }));
}

const concessionsStep: Step = {
  name: 'concessions-sponsors-openings',
  run: async (ctx, sub) => {
    const { db, w, cal } = ctx;
    const by = userId('principal');
    const picks = concessionPicks(w);
    if (sub === 0) {
      if (!(await exists(db, sql`SELECT 1 FROM concession LIMIT 1`)))
        for (const [i, p] of picks.entries())
          await addConcession(db, {
            id: dayId('2026-03-30', `concession:${i}`),
            studentId: p.s.id,
            feeHeadId: p.type === 'fixed' ? HEADS.tuition() : null,
            type: p.type,
            value: p.value,
            reason: p.reason,
            note: p.note,
            approvedBy: by,
            validFrom: cal.start,
          });
      return 1;
    }
    if (sub === 1) {
      if (await exists(db, sql`SELECT 1 FROM sponsor LIMIT 1`)) return 2;
      await runBatch(db, [
        ...bulk(
          'sponsor',
          SPONSORS.map((s) => ({
            id: sponsorId(s.key),
            name: s.name,
            phone: s.phone,
            created_by: by,
          })),
        ),
        ...bulk(
          'sponsorship',
          sponsorshipPicks(w).map((p, i) => ({
            id: dayId('2026-03-30', `sponsorship:${i}`),
            sponsor_id: sponsorId(p.sponsor),
            student_id: p.s.id,
            fee_head_id: p.tuitionOnly ? HEADS.tuition() : null,
            share_pct: p.pct,
            valid_from: cal.start,
            created_by: by,
          })),
        ),
      ]);
      return 2;
    }
    if (sub === 2) {
      const [a] = await db.all<{ opening_as_of: string | null }>(
        sql`SELECT opening_as_of FROM account WHERE id = ${ACCOUNTS.bank()}`,
      );
      if (!a?.opening_as_of)
        await setAccountOpening(db, {
          accountId: ACCOUNTS.bank(),
          amount: rupees(350000),
          asOf: cal.start,
          today: cal.start,
          by,
        });
      return 3;
    }
    const opening = openingPicks(w);
    const i = sub - 3;
    const o = opening[i];
    if (o && !(await exists(db, sql`SELECT 1 FROM opening_balance WHERE student_id = ${o.s.id}`)))
      await recordOpeningBalance(db, {
        studentId: o.s.id,
        amount: o.amount,
        asOf: cal.start,
        note: o.note,
        by,
      });
    return i + 1 < opening.length ? sub + 1 : null;
  },
};

// ---- billing --------------------------------------------------------------------------------

function generateStep(period: string): Step {
  return {
    name: `generate:${period}`,
    // A generation chunk is heavy for the free plan's 10 ms CPU: 12 per invocation ended in error
    // 1102 on generate:2026-05 (2026-10-14), and 3 of 200 rows still did on generate:2026-08
    // (2026-10-15, every cron tick, so the reseed never finished). One small chunk per invocation.
    cost: 12,
    run: async ({ db }) => {
      const cur = await generationCursor(db, period);
      if (!cur) return null;
      const r = await generateChunkOrLog(db, {
        period,
        grpId: cur.grp_id,
        afterStudentId: cur.after_student_id,
        by: userId('admin'),
        maxRows: 60,
      });
      if (!r.ok) throw new Error(`demo: generation failed for ${period}: ${r.code} ${r.message}`);
      return 0;
    },
  };
}

// ---- the month's office days --------------------------------------------------------------------

type Op = { cash: boolean; run: (ctx: StepCtx) => Promise<void> };

/** month = about one month's fees, whatever older dues there are (arrears stay). */
type PayKind = 'full' | 'partial' | 'advance' | 'month';
type Method = 'cash' | 'bank' | 'jazzcash' | 'cheque';
type Payment = {
  family: Family;
  kind: PayKind;
  day: string;
  method: Method;
  key: string;
  extra?: number;
  /** The amount of this earlier receipt (an entry typed twice). */
  copyOf?: string;
};

/** The few families the scripted corrections happen to (deterministic). */
export function scenarioFamilies(w: World) {
  const steady = w.families.filter(
    (f) => f.reliability > 0.9 && f.students.every((s) => !s.leftOn && !s.joiner),
  );
  const leaverFamily = w.families.find(
    (f) => f.students.length === 1 && f.students[0]?.leftOn,
  ) as Family;
  const pick = (pred: (f: Family) => boolean, skip = 0) => steady.filter(pred)[skip] as Family;
  return {
    typo: pick((f) => f.method === 'bank'),
    wallet: pick((f) => f.method === 'jazzcash'),
    duplicate: pick((f) => f.method === 'cash', 3),
    cheque: pick((f) => f.method === 'bank', 1),
    leaver: leaverFamily,
  };
}

const methodAccount = (m: Method) =>
  m === 'cash' ? null : m === 'jazzcash' ? ACCOUNTS.wallet() : ACCOUNTS.bank();
const reference = (m: Method, key: string) =>
  m === 'bank'
    ? `IBFT ${String(hashSeed(key) % 1_000_000).padStart(6, '0')}`
    : m === 'jazzcash'
      ? `TID ${String(hashSeed(key) % 1_000_000_000).padStart(9, '0')}`
      : m === 'cheque'
        ? `Cheque #${String(hashSeed(key) % 100_000).padStart(6, '0')}`
        : null;

/** Families paid at the counter today (cash), so the drawer is open with receipts in it. */
const TODAY_PAYERS = 5;

/**
 * Who pays what in a month (85% collection, some late, partial and advance payments). In the seed
 * day's own month only the payments planned up to today happen, so collection there is as far
 * along as the month (most families pay by the due date, the 10th; late payers trickle in until
 * the 28th), and a handful of families pay today.
 */
export function paymentsFor(w: World, period: string, cal: DemoCalendar): Payment[] {
  const sc = scenarioFamilies(w);
  const idx = cal.months.indexOf(period);
  const current = period === cal.current;
  const out: Payment[] = [];
  const later: Payment[] = [];
  for (const f of w.families) {
    if (!f.students.some((s) => activeIn(s, period))) continue;
    const r = rng(hashSeed(`pay:${f.id}:${period}`));
    const u = r.next();
    let kind: PayKind | 'late' | 'skip';
    if (u > f.reliability) kind = r.chance(0.45) ? 'late' : 'skip';
    else {
      const v = r.next();
      kind = v < 0.06 ? 'partial' : v < 0.12 ? 'advance' : 'full';
    }
    if (f === sc.leaver && idx === LEAVER_MONTH) kind = 'advance';
    if (f === sc.leaver && idx > LEAVER_MONTH) kind = 'skip';
    if ((f === sc.typo && idx === 1) || (f === sc.wallet && idx === 2)) kind = 'skip'; // scripted below
    if ((f === sc.duplicate && idx === 4) || (f === sc.cheque && idx === 4)) kind = 'skip';
    if (kind === 'skip') continue;
    const late = kind === 'late';
    const dom = late ? r.int(12, current ? 28 : 24) : r.int(1, 10);
    const day = officeDayFrom(`${period}-${String(dom).padStart(2, '0')}`);
    const method: Method = r.chance(0.06) ? 'cash' : f.method;
    // Families that often pay late settle about a month at a time, so their arrears linger.
    const settled: PayKind =
      f.reliability < 0.9 && kind !== 'advance' ? 'month' : late ? 'full' : (kind as PayKind);
    const p: Payment = { family: f, kind: settled, day, method, key: `pay:${f.id}:${period}` };
    if (current && settled !== 'advance' && settled !== 'partial') later.push(p);
    else if (!current || day <= cal.today) out.push(p);
  }
  if (current) {
    // Today's counter: the few payers planned latest in the month come in today (cash), so the
    // drawer has receipts even on the month's last day; the rest pay on their planned day.
    later.sort((a, b) =>
      a.day !== b.day ? (a.day < b.day ? 1 : -1) : hashSeed(a.key) - hashSeed(b.key),
    );
    const today = officeOpen(cal.today) ? later.splice(0, TODAY_PAYERS) : [];
    for (const p of today) out.push({ ...p, day: cal.today, method: 'cash' });
    for (const p of later) if (p.day <= cal.today) out.push(p);
  }
  return out;
}

async function familyDue(db: AppDb, familyId: string): Promise<number> {
  const dues = await openDues(db, 'family', familyId);
  return dues.reduce((a, d) => a + d.due, 0);
}

const tuitionOf = (f: Family, period: string) =>
  f.students
    .filter((s) => activeIn(s, period))
    .reduce((a, s) => {
      const g = GROUPS.find((x) => x.key === s.group);
      const p = PROGRAMMES.find((x) => x.key === g?.programme);
      return a + (p?.tuition ?? 0);
    }, 0);

function payOp(p: Payment): Op {
  return {
    cash: p.method === 'cash',
    run: async ({ db }) => {
      const id = dayId(p.day, p.key);
      if (await exists(db, sql`SELECT 1 FROM receipt WHERE id = ${id}`)) return;
      const due = await familyDue(db, p.family.id);
      let amount =
        p.kind === 'partial'
          ? Math.min(
              due,
              Math.max(rupees(1000), Math.floor((due * 0.6) / rupees(500)) * rupees(500)),
            )
          : p.kind === 'advance'
            ? due + tuitionOf(p.family, p.day.slice(0, 7))
            : p.kind === 'month'
              ? Math.min(due, tuitionOf(p.family, p.day.slice(0, 7)))
              : due;
      // The mistyped payment needs a real amount under the typo even when the family paid ahead.
      if (p.extra && amount <= 0) amount = tuitionOf(p.family, p.day.slice(0, 7));
      amount += p.extra ?? 0;
      if (p.copyOf) {
        const [first] = await db.all<{ amount: number }>(
          sql`SELECT amount FROM receipt WHERE id = ${dayId(p.day, p.copyOf)}`,
        );
        amount = first?.amount ?? 0;
      }
      if (amount <= 0) return;
      await collect(db, {
        receiptId: id,
        payerType: 'family',
        payerId: p.family.id,
        amount,
        method: p.method,
        accountId: methodAccount(p.method),
        reference: reference(p.method, p.key),
        collectorId: userId('accountant'),
        idempotencyKey: `demo:${p.key}`,
        businessDate: p.day,
        today: p.day,
      });
    },
  };
}

function reverseOp(
  day: string,
  targetKey: string,
  targetDay: string,
  reason: string,
  reenter?: { less: number },
): Op {
  return {
    cash: false,
    run: async ({ db }) => {
      const target = dayId(targetDay, targetKey);
      const [orig] = await db.all<{ amount: number; method: string; payer_id: string }>(
        sql`SELECT amount, method, payer_id FROM receipt WHERE id = ${target}`,
      );
      if (!orig) return;
      if (await exists(db, sql`SELECT 1 FROM receipt WHERE reverses_id = ${target}`)) return;
      await reverseReceipt(db, {
        receiptId: target,
        byUserId: userId('accountant'),
        reason,
        series: { series: RECEIPT_PREFIX, year: Number(day.slice(0, 4)) },
        reversalId: dayId(day, `reversal:${targetKey}`),
        businessDate: day,
        cashSessionId: orig.method === 'cash' ? sessionIdFor(userId('accountant'), day) : null,
        reenter: reenter
          ? { id: dayId(day, `reentry:${targetKey}`), amount: orig.amount - reenter.less }
          : undefined,
      });
      if (reenter) await applyCredit(db, { payerType: 'family', payerId: orig.payer_id });
    },
  };
}

function sponsorOp(day: string, key: string): Op {
  return {
    cash: false,
    run: async ({ db }) => {
      const id = dayId(day, `sponsor-pay:${key}`);
      if (await exists(db, sql`SELECT 1 FROM receipt WHERE id = ${id}`)) return;
      const due = (await openDues(db, 'sponsor', sponsorId(key))).reduce((a, d) => a + d.due, 0);
      if (due <= 0) return;
      await collect(db, {
        receiptId: id,
        payerType: 'sponsor',
        payerId: sponsorId(key),
        amount: due,
        method: 'bank',
        accountId: ACCOUNTS.bank(),
        reference: reference('bank', `sponsor:${key}:${day}`),
        collectorId: userId('accountant'),
        idempotencyKey: `demo:sponsor:${key}:${day}`,
        businessDate: day,
        today: day,
      });
    },
  };
}

const finesOp = (day: string): Op => ({
  cash: false,
  run: async ({ db }) => {
    for (let i = 0; i < 4; i++) {
      const f = await applyLateFines(db, { asOf: day, by: userId('admin') });
      if (f.done || !f.applied) break;
    }
  },
});

const WAIVE_REASONS = [
  'Paid at the bank before the due date; the bank credited late',
  'Hardship: approved by the principal',
  'First late payment in two years',
];
function waiveOp(day: string, f: Family, n: number): Op {
  return {
    cash: false,
    run: async ({ db }) => {
      // Keyed by the plan (family, day, n), not by the fine it picks: a re-run finds it done.
      const waiverId = dayId(day, `waiver:${f.id}:${n}`);
      if (await exists(db, sql`SELECT 1 FROM charge WHERE id = ${waiverId}`)) return;
      const [fine] = await db.all<{ id: string }>(sql`
        SELECT c.id FROM charge c
        WHERE c.kind = 'fine' AND c.payer_type = 'family' AND c.payer_id = ${f.id}
          AND c.amount + coalesce((SELECT sum(w.amount) FROM charge w WHERE w.parent_charge_id = c.id), 0) > 0
        ORDER BY c.due_date, c.period_key, c.student_id, c.fee_head_id LIMIT 1`);
      if (!fine) return;
      await waiveFine(db, {
        fineId: fine.id,
        reason: WAIVE_REASONS[n % WAIVE_REASONS.length] as string,
        by: userId('principal'),
        waiverId,
      });
    },
  };
}

type Expense = {
  key: string;
  day: string;
  cat: string;
  amount: number;
  account: 'cash' | 'bank' | 'wallet';
  vendor: string;
  note?: string;
};

/** Electricity by calendar month (Lahore: summer bills are the heaviest). */
const ELECTRICITY = [
  32100, 29800, 31500, 38500, 61200, 70950, 73800, 66400, 52300, 41800, 33900, 34600,
];

export function expensesFor(period: string, idx: number): Expense[] {
  const m = Number(period.slice(5, 7));
  const vacation = m === 6 || m === 7;
  const r = rng(hashSeed(`expenses:${period}`));
  const d = (n: number) => officeDayFrom(`${period}-${String(n).padStart(2, '0')}`);
  const out: Expense[] = [
    {
      key: 'rent',
      day: d(5),
      cat: 'expcat_rent',
      amount: rupees(180000),
      account: 'bank',
      vendor: 'Haji Bashir Ahmed (landlord)',
      note: `Building rent, ${period}`,
    },
    {
      key: 'electricity',
      day: d(14),
      cat: 'expcat_utilities',
      amount: rupees(ELECTRICITY[m - 1] as number),
      account: 'bank',
      vendor: 'LESCO',
      note: 'Electricity bill',
    },
    {
      key: 'gas',
      day: d(16),
      cat: 'expcat_utilities',
      amount: rupees(r.int(35, 60) * 100),
      account: 'cash',
      vendor: 'SNGPL',
      note: 'Gas bill',
    },
    {
      key: 'water',
      day: d(16),
      cat: 'expcat_utilities',
      amount: rupees(2800),
      account: 'cash',
      vendor: 'WASA Lahore',
    },
    {
      key: 'internet',
      day: d(8),
      cat: 'expcat_utilities',
      amount: rupees(5999),
      account: 'wallet',
      vendor: 'PTCL Flash Fiber',
    },
    {
      key: 'tea',
      day: d(22),
      cat: 'expcat_misc',
      amount: rupees(r.int(30, 55) * 100),
      account: 'cash',
      vendor: 'Ghani General Store',
      note: 'Staff room tea and sugar',
    },
  ];
  if (!vacation) {
    out.push(
      {
        key: 'stationery',
        day: d(4),
        cat: 'expcat_stationery',
        amount: rupees(r.int(60, 140) * 100),
        account: 'cash',
        vendor: 'Urdu Bazaar Stationers',
      },
      {
        key: 'fuel',
        day: d(18),
        cat: 'expcat_transport',
        amount: rupees(r.int(220, 280) * 100),
        account: 'cash',
        vendor: 'PSO Faisal Town',
        note: 'School van diesel',
      },
    );
  }
  if (m === 5)
    out.push({
      key: 'ac',
      day: d(20),
      cat: 'expcat_maintenance',
      amount: rupees(18500),
      account: 'cash',
      vendor: 'Cool Point AC Services',
      note: 'Servicing of six ACs before summer',
    });
  if (m === 8)
    out.push({
      key: 'paint',
      day: d(10),
      cat: 'expcat_maintenance',
      amount: rupees(35000),
      account: 'bank',
      vendor: 'Rafiq Painters',
      note: 'Classrooms painted during the vacation',
    });
  if (m === 9)
    out.push({
      key: 'papers',
      day: d(17),
      cat: 'expcat_exam',
      amount: rupees(24000),
      account: 'cash',
      vendor: 'Al-Fatah Printers',
      note: 'Second-term question papers',
    });
  if (idx === 0)
    out.push({
      key: 'repair',
      day: d(23),
      cat: 'expcat_maintenance',
      amount: rupees(6500),
      account: 'cash',
      vendor: 'Local plumber',
      note: 'Washroom taps',
    });
  return out;
}

function expenseOp(period: string, e: Expense): Op {
  return {
    cash: e.account === 'cash',
    run: async ({ db }) => {
      await recordExpense(db, {
        id: dayId(e.day, `expense:${period}:${e.key}`),
        categoryId: e.cat,
        amount: e.amount,
        accountId:
          e.account === 'cash'
            ? ACCOUNTS.drawer()
            : e.account === 'bank'
              ? ACCOUNTS.bank()
              : ACCOUNTS.wallet(),
        date: e.day,
        vendor: e.vendor,
        note: e.note ?? null,
        by: userId('accountant'),
        today: e.day,
      });
    },
  };
}

/** A cash expense typed twice and voided the same day (before the drawer closed). */
function voidOp(day: string, period: string, key: string): Op {
  return {
    cash: true,
    run: async ({ db }) => {
      const id = dayId(day, `expense:${period}:${key}:dup`);
      const [e] = await db.all<{ voided_by: string | null }>(
        sql`SELECT voided_by FROM expense WHERE id = ${id}`,
      );
      if (e?.voided_by) return;
      await voidExpense(db, { id, reason: 'Entered twice', by: userId('accountant') });
    },
  };
}

const CASH_PAID = new Set(['naila', 'rabia']);
function payrollOps(period: string, day: string): Op[] {
  return [
    {
      cash: false,
      run: async ({ db }) => {
        await generatePayslips(db, { periodKey: period, by: userId('admin') });
      },
    },
    ...STAFF.map((st) => ({
      cash: CASH_PAID.has(st.key),
      run: async ({ db }: StepCtx) => {
        // By id, not as a join: SQLite pushes `id = ?` into the payslip_net aggregate, while a join
        // aggregates every slip first (D1 bills each row read).
        const [slip] = await db.all<{ id: string; status: string; net: number; paid: number }>(
          sql`SELECT n.id, n.status, n.net, n.paid FROM payslip_net n
              WHERE n.id = (SELECT id FROM payslip WHERE staff_id = ${staffId(st.key)}
                              AND period_key = ${period})`,
        );
        if (!slip) return;
        if (slip.status === 'draft')
          await approvePayslip(db, {
            id: slip.id,
            by: st.key === 'principal' ? userId('admin') : userId('principal'),
            now: `${day}T06:00:00.000Z`,
          });
        const left = slip.net - slip.paid;
        if (slip.status === 'paid' || left <= 0) return;
        await paySalary(db, {
          id: dayId(day, `salary:${st.key}:${period}`),
          payslipId: slip.id,
          amount: left,
          accountId: CASH_PAID.has(st.key) ? ACCOUNTS.drawer() : ACCOUNTS.bank(),
          date: day,
          note: `Salary ${period}`,
          by: userId('accountant'),
          today: day,
        });
      },
    })),
  ];
}

const advanceOp = (
  day: string,
  staff: string,
  amount: number,
  account: 'bank' | 'cash',
  note: string,
): Op => ({
  cash: account === 'cash',
  run: async ({ db }) => {
    await recordAdvance(db, {
      id: dayId(day, `advance:${staff}`),
      staffId: staffId(staff),
      amount,
      accountId: account === 'cash' ? ACCOUNTS.drawer() : ACCOUNTS.bank(),
      date: day,
      note,
      by: userId('accountant'),
      today: day,
    });
  },
});

const refundOp = (day: string, f: Family, leftMonth: string): Op => ({
  cash: true,
  run: async ({ db }) => {
    const id = dayId(day, `refund:${f.id}`);
    if (await exists(db, sql`SELECT 1 FROM receipt WHERE id = ${id}`)) return;
    const [c] = await db.all<{ credit: number }>(
      sql`SELECT credit FROM payer_credit WHERE payer_type = 'family' AND payer_id = ${f.id}`,
    );
    if (!c || c.credit <= 0) return;
    await refund(db, {
      id,
      payerType: 'family',
      payerId: f.id,
      amount: c.credit,
      method: 'cash',
      reason: `Child withdrew at the end of ${monthName(leftMonth)}; the advance is returned`,
      by: userId('accountant'),
      businessDate: day,
      idempotencyKey: `demo:refund:${f.id}`,
      today: day,
    });
  },
});

const endConcessionOp = (): Op => ({
  cash: false,
  run: async ({ db, w, cal }) => {
    const needy = concessionPicks(w).findIndex((p) => p.reason === 'needy');
    const id = dayId('2026-03-30', `concession:${needy}`);
    const [c] = await db.all<{ ended_at: string | null }>(
      sql`SELECT ended_at FROM concession WHERE id = ${id}`,
    );
    if (!c || c.ended_at) return;
    await endConcession(db, {
      id,
      endedAt: `${cal.months[3]}-01`,
      reason: 'Father found work again',
      by: userId('principal'),
    });
  },
});

/** Opens the accountant's drawer with yesterday's count as the float (once per day). */
const openOp = (day: string): Op => ({
  cash: true,
  run: async ({ db }) => {
    const acct = userId('accountant');
    if (await sessionFor(db, acct, day)) return;
    const [prev] = await db.all<{ counted: number }>(sql`SELECT counted FROM cash_session
      WHERE collector_id = ${acct} AND business_date < ${day} AND closed_at IS NOT NULL
      ORDER BY business_date DESC LIMIT 1`);
    await openSession(db, {
      collectorId: acct,
      businessDate: day,
      opening: prev?.counted ?? rupees(5000),
      id: dayId(day, 'session'),
    });
  },
});

const FLOAT = rupees(5000);
/** Saturday (and month-end) deposit of the drawer's cash above the float into the bank. */
const depositOp = (day: string): Op => ({
  cash: true,
  run: async ({ db }) => {
    const id = dayId(day, 'deposit');
    if (await exists(db, sql`SELECT 1 FROM transfer WHERE id = ${id}`)) return;
    const s = await sessionFor(db, userId('accountant'), day);
    if (!s || s.closed_at) return;
    const [e] = await db.all<{ v: number }>(sql`SELECT ${expectedSql(s.id)} AS v`);
    const amount = Math.floor(((e?.v ?? 0) - FLOAT) / rupees(1000)) * rupees(1000);
    if (amount <= 0) return;
    await recordTransfer(db, {
      id,
      fromAccount: ACCOUNTS.drawer(),
      toAccount: ACCOUNTS.bank(),
      amount,
      date: day,
      note: 'Cash deposited at Meezan Bank, Faisal Town branch',
      by: userId('accountant'),
    });
  },
});

const closeOp = (day: string): Op => ({
  cash: true,
  run: async ({ db }) => {
    const s = await sessionFor(db, userId('accountant'), day);
    if (!s || s.closed_at) return;
    const [e] = await db.all<{ v: number }>(sql`SELECT ${expectedSql(s.id)} AS v`);
    const r = rng(hashSeed(`close:${day}`));
    const variance = r.chance(0.78) ? 0 : r.pick([-5000, -10000, 2000, -2000, 10000, -50000]);
    await closeSession(db, {
      sessionId: s.id,
      counted: Math.max(0, (e?.v ?? 0) + variance),
      by: userId('accountant'),
      now: `${day}T13:30:00.000Z`,
    });
  },
});

/**
 * Every office day of a month that has something to do, with its ops in order. The scripted
 * corrections sit in the completed months (by index in `cal.months`); nothing is dated after the
 * seed day, today's drawer stays open, and today's month has no payroll yet.
 */
export function monthDays(
  w: World,
  period: string,
  cal: DemoCalendar,
): { day: string; ops: Op[] }[] {
  const sc = scenarioFamilies(w);
  const idx = cal.months.indexOf(period);
  const current = period === cal.current;
  const byDay = new Map<string, Op[]>();
  const add = (day: string, op: Op) => byDay.set(day, [...(byDay.get(day) ?? []), op]);
  const fineDay = officeDayFrom(`${period}-11`);
  add(fineDay, finesOp(fineDay));
  for (const p of paymentsFor(w, period, cal).sort((a, b) =>
    a.day < b.day ? -1 : a.day > b.day ? 1 : a.key < b.key ? -1 : 1,
  ))
    add(p.day, payOp(p));
  const sday = (n: number) => officeDayFrom(`${period}-${String(n).padStart(2, '0')}`);
  // Scripted corrections.
  if (idx === 1) {
    const d = sday(6);
    add(
      d,
      payOp({
        family: sc.typo,
        kind: 'full',
        day: d,
        method: 'bank',
        key: `typo:${period}`,
        extra: rupees(1000),
      }),
    );
    add(
      d,
      reverseOp(d, `typo:${period}`, d, 'Amount typed wrong (Rs 1,000 too much); re-entered', {
        less: rupees(1000),
      }),
    );
    add(
      sday(12),
      advanceOp(sday(12), 'bilal', rupees(20000), 'bank', 'Advance for a family wedding'),
    );
  }
  if (idx === 2) {
    const d = sday(9);
    add(
      d,
      payOp({
        family: sc.wallet,
        kind: 'full',
        day: d,
        method: 'jazzcash',
        key: `wallet:${period}`,
      }),
    );
    add(d, reverseOp(d, `wallet:${period}`, d, 'JazzCash transfer reversed by the provider'));
    const d2 = sday(16);
    add(
      d2,
      payOp({
        family: sc.wallet,
        kind: 'full',
        day: d2,
        method: 'cash',
        key: `wallet-again:${period}`,
      }),
    );
    add(sday(25), endConcessionOp());
  }
  if (idx === 4) {
    const d = sday(18);
    add(
      d,
      payOp({ family: sc.duplicate, kind: 'full', day: d, method: 'cash', key: `dup:${period}` }),
    );
    add(
      d,
      payOp({
        family: sc.duplicate,
        kind: 'full',
        day: d,
        method: 'cash',
        key: `dup2:${period}`,
        copyOf: `dup:${period}`,
      }),
    );
    add(d, reverseOp(d, `dup2:${period}`, d, 'Entered twice by mistake'));
    add(sday(20), refundOp(sday(20), sc.leaver, cal.months[LEAVER_MONTH] as string));
    add(
      sday(20),
      advanceOp(sday(20), 'naila', rupees(10000), 'cash', 'Advance against salary (medical)'),
    );
    const c = sday(8);
    add(
      c,
      payOp({ family: sc.cheque, kind: 'full', day: c, method: 'cheque', key: `cheque:${period}` }),
    );
    add(sday(12), reverseOp(sday(12), `cheque:${period}`, c, 'Cheque returned unpaid by the bank'));
  }
  // The trust pays every month; the other two sponsors once a quarter, so they owe the months since.
  if (!current)
    for (const s of SPONSORS)
      if (s.key === 'trust' || idx % 3 === 0) add(sday(15), sponsorOp(sday(15), s.key));
  if (idx >= 1) {
    const late = w.families.filter((f) => f.reliability < 0.8);
    const r = rng(hashSeed(`waive:${period}`));
    for (let n = 0; n < 2; n++) add(sday(20), waiveOp(sday(20), r.pick(late), n));
  }
  for (const e of expensesFor(period, idx)) add(e.day, expenseOp(period, e));
  if (idx === 0) {
    const d = sday(23);
    const dup: Expense = {
      key: 'repair:dup',
      day: d,
      cat: 'expcat_maintenance',
      amount: rupees(6500),
      account: 'cash',
      vendor: 'Local plumber',
      note: 'Washroom taps',
    };
    add(d, expenseOp(period, dup));
    add(d, voidOp(d, period, 'repair'));
  }
  // Payslips through last month: this month's are not prepared yet.
  const payday = officeDays(period).at(-1) as string;
  if (!current) for (const op of payrollOps(period, payday)) add(payday, op);

  const out: { day: string; ops: Op[] }[] = [];
  for (const day of [...byDay.keys()].sort()) {
    if (day > cal.today) continue;
    const ops = byDay.get(day) as Op[];
    const cash = ops.some((o) => o.cash);
    // Today's drawer is still open: it is counted and closed at the end of the office day.
    const tail: Op[] =
      cash && day !== cal.today
        ? [...(weekday(day) === 6 || day === payday ? [depositOp(day)] : []), closeOp(day)]
        : [];
    out.push({ day, ops: [...(cash ? [openOp(day)] : []), ...ops, ...tail] });
  }
  return out;
}

// ---- attendance ---------------------------------------------------------------------------------

/** The mark a student gets on a day (P mostly; A by the student's habit; some L and E). */
export function markFor(s: Student, day: string): 'P' | 'A' | 'L' | 'E' {
  const r = rng(hashSeed(`mark:${s.id}:${day}`));
  const u = r.next();
  if (u < s.absence) return 'A';
  if (u < s.absence + 0.02) return 'L';
  if (u < s.absence + 0.03) return 'E';
  return 'P';
}

/**
 * The mark used in the seed: on the seed day the habitually absent students are away, so today's
 * registers always have absences to message about (the week's chance alone left some days with none).
 */
export const markOn = (cal: DemoCalendar, s: Student, day: string) =>
  day === cal.today && s.absence >= 0.16 ? 'A' : markFor(s, day);

export function registerRoster(w: World, group: string, day: string): Student[] {
  if (group === 'matric-evening')
    return weekday(day) === 6 ? [] : w.students.filter((s) => s.evening && activeOn(s, day));
  return w.students.filter((s) => s.group === group && activeOn(s, day));
}

/**
 * Registers still to be taken on the seed day itself, so the home screens show real work left
 * (about 12 of 19 taken). Class 5 A is the demo teacher's: she has her own register to take; the
 * evening batch meets at 16:00.
 */
export const NOT_YET_TAKEN = new Set([
  'c5a',
  'c2a',
  'c4b',
  'c7b',
  'c9a',
  'prepa',
  'matric-evening',
]);

/** The groups whose register exists for a day (all of them, except today's not-yet-taken ones). */
export const registerGroups = (cal: DemoCalendar, day: string) =>
  GROUPS.filter((g) => day !== cal.today || !NOT_YET_TAKEN.has(g.key));

function attendanceStep(day: string): Step {
  return {
    name: `attendance:${day}`,
    run: async ({ db, w, cal }) => {
      const groups = registerGroups(cal, day);
      if (
        await exists(
          db,
          sql`SELECT 1 FROM att_register WHERE client_id = ${`demo:${groups[0]?.key}:${day}`}`,
        )
      )
        return null;
      const stmts: SQL[] = [];
      groups.forEach((g) => {
        const gi = GROUPS.indexOf(g);
        const roster = registerRoster(w, g.key, day);
        if (!roster.length) return;
        const reg = dayId(day, `register:${g.key}`);
        const teacher = CLASS_TEACHER[g.key] === 'ayesha' ? userId('teacher') : userId('admin');
        // 08:xx Karachi for day classes, 16:xx for the evening batch.
        const takenAt = `${day}T${g.key === 'matric-evening' ? '11' : '03'}:${String(5 + gi).padStart(2, '0')}:00.000Z`;
        const marks = roster.map((s) => ({ s: s.id, st: markOn(cal, s, day) }));
        stmts.push(
          sql`INSERT INTO att_register (id, client_id, grp_id, date, grp_subject_id, taken_by, taken_at, received_at, batch_token)
              VALUES (${reg}, ${`demo:${g.key}:${day}`}, ${grpId(g.key)}, ${day}, '', ${teacher}, ${takenAt}, ${takenAt}, 'demo')`,
          sql`INSERT INTO att_mark (register_id, student_id, status)
              SELECT ${reg}, json_extract(value, '$.s'), json_extract(value, '$.st') FROM json_each(${JSON.stringify(marks)})`,
          sql`INSERT INTO current_register (grp_id, date, grp_subject_id, register_id, taken_at)
              VALUES (${grpId(g.key)}, ${day}, '', ${reg}, ${takenAt})`,
          sql`INSERT INTO audit (id, at, user_id, entity, entity_id, action, diff)
              VALUES (${dayId(day, `audit:register:${g.key}`)}, ${takenAt}, ${teacher}, 'att_register', ${reg}, 'sync',
                ${JSON.stringify({ before: null, after: { status: 'applied', client_id: `demo:${g.key}:${day}`, grp_id: grpId(g.key), date: day, grp_subject_id: '', taken_at: takenAt, marks: marks.length, absent: marks.filter((m) => m.st === 'A').length } })})`,
        );
      });
      await runBatch(db, stmts);
      return null;
    },
  };
}

// ---- messages and parent links ----------------------------------------------------------------

type MsgRow = {
  id: string;
  family_id: string;
  guardian_id: string | null;
  channel: string;
  template_key: string;
  lang: string;
  payload: string;
  status: string;
  created_at: string;
  created_by: string;
  sent_at: string | null;
  sent_by: string | null;
  opened_at: string | null;
  skipped_reason: string | null;
  skipped_at: string | null;
};

const MOBILE = /^923\d{9}$/;
function messageRow(o: {
  f: Family;
  template: string;
  day: string;
  key: string;
  payload: Record<string, unknown>;
  by: string;
  fate: 'sent' | 'skipped' | 'queued';
  skipReason?: string;
}): MsgRow {
  const g = [...o.f.guardians].sort((a, b) => a.priority - b.priority);
  const wa = g.find((x) => x.consent && MOBILE.test(x.phone));
  const to = wa ?? g[0];
  const created = `${o.day}T04:${String(hashSeed(o.key) % 60).padStart(2, '0')}:00.000Z`;
  const later = `${o.day}T0${5 + (hashSeed(o.key) % 4)}:${String(hashSeed(`${o.key}:s`) % 60).padStart(2, '0')}:00.000Z`;
  return {
    id: dayId(o.day, `message:${o.key}`),
    family_id: o.f.id,
    guardian_id: to?.id ?? null,
    channel: wa ? 'wa_manual' : 'call',
    template_key: o.template,
    lang: to?.lang ?? 'ur',
    payload: JSON.stringify(o.payload),
    status: o.fate,
    created_at: created,
    created_by: o.by,
    sent_at: o.fate === 'sent' ? later : null,
    sent_by: o.fate === 'sent' ? o.by : null,
    opened_at: o.fate === 'sent' ? later : null,
    skipped_reason: o.fate === 'skipped' ? (o.skipReason ?? 'Parent informed in person') : null,
    skipped_at: o.fate === 'skipped' ? later : null,
  };
}

/** About a week before the seed day (an office day): when the notice went out. */
const noticeDay = (cal: DemoCalendar) => {
  let d = addDay(cal.today, -7);
  while (!officeOpen(d)) d = addDay(d, -1);
  return d;
};
/** The first Saturday after the seed day. */
const meetingDay = (cal: DemoCalendar) => {
  let d = addDay(cal.today, 1);
  while (weekday(d) !== 6) d = addDay(d, 1);
  return d;
};

/** The office day on or before `d`. */
const officeDayBefore = (d: string) => {
  let x = d;
  while (!officeOpen(x)) x = addDay(x, -1);
  return x;
};

/**
 * Reminder days: "fee due" on the 3rd of the month being reminded about, "overdue" two days ago
 * (after the fine's grace day, the 10th). Before the 14th of the month both are last month's.
 */
export function reminderDays(cal: DemoCalendar): {
  period: string;
  dueDay: string;
  overdueDay: string;
} {
  const dom = Number(cal.today.slice(8, 10));
  const period = dom >= 14 ? cal.current : (cal.months.at(-2) as string);
  const overdueDay =
    dom >= 14 ? officeDayBefore(addDay(cal.today, -2)) : officeDayFrom(`${period}-21`);
  return { period, dueDay: officeDayFrom(`${period}-03`), overdueDay };
}

const names = (f: Family, day: string) =>
  f.students.filter((s) => activeOn(s, day)).map((s) => s.name);

const messagesStep: Step = {
  name: 'messages',
  run: async ({ db, w, cal }, sub) => {
    const by = userId('admin');
    const fate = (key: string, pSent: number, pSkip: number): 'sent' | 'skipped' | 'queued' => {
      const u = rng(hashSeed(`fate:${key}`)).next();
      return u < pSent ? 'sent' : u < pSent + pSkip ? 'skipped' : 'queued';
    };
    const famById = new Map(w.families.map((f) => [f.id, f]));
    if (sub === 0) {
      if (await exists(db, sql`SELECT 1 FROM message LIMIT 1`)) return null;
      // Absence: the registers' days (the last one today's when it is a school day), one row per
      // family per day; the last day's rows are still queued.
      const days = cal.attendanceDays;
      const rows: MsgRow[] = [];
      const lastSent = new Map<string, string>();
      for (const day of days) {
        const byFam = new Map<string, Student[]>();
        const taken = new Set(registerGroups(cal, day).map((g) => g.key));
        for (const s of w.students)
          if (activeOn(s, day) && taken.has(s.group) && markOn(cal, s, day) === 'A')
            byFam.set(s.familyId, [...(byFam.get(s.familyId) ?? []), s]);
        for (const [fid, kids] of byFam) {
          const f = famById.get(fid) as Family;
          const key = `absence:${fid}:${day}`;
          const last = day === days.at(-1);
          const ft = last ? 'queued' : fate(key, 0.72, 0.28);
          rows.push(
            messageRow({
              f,
              template: 'absence',
              day,
              key,
              by: CLASS_TEACHER[kids[0]?.group ?? ''] === 'ayesha' ? userId('teacher') : by,
              fate: ft,
              skipReason:
                hashSeed(key) % 3 ? 'Parent called the school in the morning' : 'no_longer_absent',
              payload: {
                student_ids: kids.map((k) => k.id),
                student_names: kids.map((k) => k.name),
                date: day,
                grp_id: grpId(kids[0]?.group as string),
                grp_name: `${PROGRAMMES.find((p) => p.key === GROUPS.find((g) => g.key === kids[0]?.group)?.programme)?.name} ${GROUPS.find((g) => g.key === kids[0]?.group)?.name}`,
                register_id: dayId(day, `register:${kids[0]?.group}`),
              },
            }),
          );
          lastSent.set(fid, day);
        }
      }
      await runBatch(db, [
        ...bulk('message', rows),
        ...bulk(
          'reminder_state',
          [...lastSent].map(([family_id, last_sent_on]) => ({
            family_id,
            template_key: 'absence',
            last_sent_on,
          })),
        ),
      ]);
      return 1;
    }
    if (sub === 1) {
      // Notice to every family a week ago: a parent-teacher meeting on the Saturday after today.
      const day = noticeDay(cal);
      const meet = meetingDay(cal);
      const [dd, mm] = [Number(meet.slice(8, 10)), meet.slice(0, 7)];
      const rows = w.families
        .filter((f) => names(f, day).length)
        .map((f) =>
          messageRow({
            f,
            template: 'notice',
            day,
            key: `notice:${f.id}`,
            by,
            fate: fate(`notice:${f.id}`, 0.74, 0.08),
            payload: {
              notice_id: 'demo-notice-exams',
              body_en: `Parent-teacher meeting on Saturday ${dd} ${monthName(mm)}, 9:00 to 12:00. Class teachers will share the term's progress reports. Please bring the fee card.`,
              body_ur: `والدین اور اساتذہ کی میٹنگ ہفتہ ${dd} ${monthName(mm, 'ur')} کو صبح 9 سے 12 بجے تک ہوگی۔ کلاس ٹیچر ٹرم کی رپورٹ دکھائیں گے۔ براہِ کرم فیس کارڈ ساتھ لائیں۔`,
              student_names: names(f, day),
              date: day,
            },
          }),
        );
      await runBatch(db, bulk('message', rows));
      return 2;
    }
    if (sub === 2) {
      // Fee reminders: "due" early in the month whose dues they are (sent), "overdue" a few days
      // ago (half still queued). Early in a month both are about last month.
      const { dueDay, overdueDay, period } = reminderDays(cal);
      const due = await db.all<{ family_id: string; due: number }>(sql`
        SELECT cs.payer_id AS family_id, sum(cs.due) AS due FROM charge_status cs
        WHERE cs.payer_type = 'family' AND cs.period_key = ${period} AND cs.due > 0
        GROUP BY cs.payer_id ORDER BY cs.payer_id LIMIT 60`);
      const overdue = await db.all<{ family_id: string; overdue: number; months: number }>(sql`
        SELECT cs.payer_id AS family_id, sum(cs.due) AS overdue, count(DISTINCT cs.period_key) AS months
        FROM charge_status cs WHERE cs.payer_type = 'family' AND cs.due > 0 AND cs.due_date < ${overdueDay}
        GROUP BY cs.payer_id ORDER BY cs.payer_id`);
      const rows: MsgRow[] = [];
      for (const d of due) {
        const f = famById.get(d.family_id);
        if (!f) continue;
        rows.push(
          messageRow({
            f,
            template: 'fee_due',
            day: dueDay,
            key: `fee_due:${f.id}`,
            by: userId('accountant'),
            fate: fate(`fee_due:${f.id}`, 0.9, 0.05),
            payload: { student_names: names(f, dueDay), due: d.due, date: dueDay },
          }),
        );
      }
      for (const d of overdue) {
        const f = famById.get(d.family_id);
        if (!f) continue;
        rows.push(
          messageRow({
            f,
            template: 'fee_overdue',
            day: overdueDay,
            key: `fee_overdue:${f.id}`,
            by: userId('accountant'),
            fate: fate(`fee_overdue:${f.id}`, 0.5, 0.05),
            skipReason: 'Father promised to pay on Friday',
            payload: {
              student_names: names(f, overdueDay),
              overdue: d.overdue,
              months_overdue: d.months,
              date: overdueDay,
            },
          }),
        );
      }
      await runBatch(db, [
        ...bulk('message', rows),
        ...bulk('reminder_state', [
          ...due
            .filter((d) => famById.has(d.family_id))
            .map((d) => ({
              family_id: d.family_id,
              template_key: 'fee_due',
              last_sent_on: dueDay,
            })),
          ...overdue
            .filter((d) => famById.has(d.family_id))
            .map((d) => ({
              family_id: d.family_id,
              template_key: 'fee_overdue',
              last_sent_on: overdueDay,
            })),
        ]),
      ]);
      return 3;
    }
    // Payment received: family payments of the last ten days.
    const receipts = await db.all<{
      id: string;
      receipt_no: string;
      amount: number;
      business_date: string;
      payer_id: string;
    }>(sql`
      SELECT id, receipt_no, amount, business_date, payer_id FROM receipt
      WHERE kind = 'payment' AND payer_type = 'family' AND business_date >= ${addDay(cal.today, -10)}
        AND id NOT IN (SELECT reverses_id FROM receipt WHERE reverses_id IS NOT NULL)
      ORDER BY id`);
    const rows = receipts.flatMap((r) => {
      const f = famById.get(r.payer_id);
      return f
        ? [
            messageRow({
              f,
              template: 'payment_received',
              day: r.business_date,
              key: `paid:${r.id}`,
              by: userId('accountant'),
              fate: fate(`paid:${r.id}`, 0.6, 0),
              payload: {
                receipt_id: r.id,
                receipt_no: r.receipt_no,
                amount: r.amount,
                business_date: r.business_date,
                student_names: names(f, r.business_date),
              },
            }),
          ]
        : [];
    });
    await runBatch(db, bulk('message', rows));
    return null;
  },
};

const b64url = (b: ArrayBuffer | Uint8Array) => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** Same derivation as apps/api/src/lib/messaging.ts linkToken + sha256Hex. */
export async function demoLinkToken(secret: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(`link:${salt}`)));
}

const parentLinksStep: Step = {
  name: 'parent-links',
  run: async ({ db, w, cal, parentSecret }) => {
    if (!parentSecret || parentSecret.trim().length < 32) return null;
    if (await exists(db, sql`SELECT 1 FROM parent_link LIMIT 1`)) return null;
    const guardians = w.families
      .filter((f) => f.students.some((s) => !s.leftOn))
      .map((f) => f.guardians.find((g) => g.consent && MOBILE.test(g.phone)))
      .filter((g): g is NonNullable<typeof g> => !!g)
      .slice(0, 40);
    const rows = [];
    for (const [i, g] of guardians.entries()) {
      const r = rng(hashSeed(`salt:${g.id}`));
      const salt = b64url(Uint8Array.from({ length: 16 }, () => r.int(0, 255)));
      const token = await demoLinkToken(parentSecret.trim(), salt);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      // Made over the last month; two in three opened in the last fortnight.
      const day = addDay(cal.today, -30 + (i % 25));
      rows.push({
        id: dayId(day, `link:${g.id}`),
        guardian_id: g.id,
        token_hash: hash,
        token_salt: salt,
        expires_at: `${cal.sessionEnd}T19:00:00.000Z`,
        last_seen_at: i % 3 ? `${addDay(cal.today, -14 + (i % 14))}T15:20:00.000Z` : null,
        created_at: `${day}T05:00:00.000Z`,
        created_by: userId('admin'),
      });
    }
    await runBatch(db, bulk('parent_link', rows));
    return null;
  },
};

// ---- the plan ---------------------------------------------------------------------------------

/** A month's ops by day, computed the first time a step of that month runs (not at start-up). */
const monthPlans = new Map<string, Map<string, Op[]>>();
function monthPlan(cal: DemoCalendar, period: string): Map<string, Op[]> {
  const key = `${cal.today}|${period}`;
  let m = monthPlans.get(key);
  if (!m) {
    m = new Map(monthDays(world(cal), period, cal).map((d) => [d.day, d.ops]));
    monthPlans.set(key, m);
  }
  return m;
}

/**
 * Whether an op of `day` must not run again. Progress is saved per finished step (and at the end
 * of an invocation), so a call cut short repeats a day's ops from the last saved one; several ops
 * decide from live balances ("nothing due: skip", "the first fine left"), and run again later they
 * would decide differently. Days run in date order, so once anything is dated after `day` the day
 * is over and none of its ops runs again; within the day, a cash op never runs after the drawer
 * is closed (closing is the day's last op). Cheaper than saving the cursor after every op, which
 * would cost a state write per op (~1,300 a seed).
 */
async function dayDone(db: AppDb, day: string, op: Op): Promise<boolean> {
  // Every drawer in the demo is the accountant's: by collector, the check is an index range
  // (cash_session_once), not a scan of every session (~50 rows read per op on D1, ~700 ops).
  const [later] = await db.all<{ x: number }>(sql`
    SELECT 1 AS x FROM cash_session
      WHERE collector_id = ${userId('accountant')} AND business_date > ${day}
    UNION ALL SELECT 1 FROM receipt WHERE business_date > ${day}
    UNION ALL SELECT 1 FROM expense WHERE date > ${day}
    LIMIT 1`);
  if (later) return true;
  if (!op.cash) return false;
  const s = await sessionFor(db, userId('accountant'), day);
  return !!s?.closed_at;
}

/** One step per office day (fixed list, cheap to build); days with nothing to do finish at once. */
function dayStep(cal: DemoCalendar, period: string, day: string): Step {
  return {
    name: `day:${day}`,
    run: async (ctx, sub) => {
      const ops = monthPlan(cal, period).get(day) ?? [];
      const op = ops[sub];
      if (op && !(await dayDone(ctx.db, day, op))) await op.run(ctx);
      return sub + 1 < ops.length ? sub + 1 : null;
    },
  };
}

const plans = new Map<string, Step[]>();
/**
 * The whole dataset for a seed day, in order (wipe steps are prepended by the runner). Building the
 * list is cheap on purpose: a cold Worker isolate on the free plan has ~10 ms of CPU, so the payment
 * schedules are worked out per month only when that month's steps run.
 */
export function seedSteps(cal: DemoCalendar): Step[] {
  const hit = plans.get(cal.today);
  if (hit) return hit;
  const steps: Step[] = [opsStep('base', [baseData]), opsStep('people', [people]), concessionsStep];
  for (const period of cal.months) {
    steps.push(generateStep(period));
    for (const day of officeDays(period))
      if (day <= cal.today) steps.push(dayStep(cal, period, day));
  }
  for (const day of cal.attendanceDays) steps.push(attendanceStep(day));
  steps.push(messagesStep, parentLinksStep);
  plans.set(cal.today, steps);
  return steps;
}
