/**
 * Milestone 1 definition of done, over HTTP against `wrangler dev --local`:
 * wizard (school → session → PK ladder → group → invite teacher → done), then an admission of two
 * siblings in one family (the second found by guardian phone), and the students list showing both
 * with the family link. Extras: concurrent numbering, the one-primary 409, CSV import idempotency,
 * photo upload to local R2, and the own-owner-role guard. Prints PASS/FAIL per step; exit code 1 on any failure.
 *
 *   npm run db:migrate:local && npm run dev -w @maktab/api      # terminal 1
 *   npm run smoke:m1 -w @maktab/api                              # terminal 2
 *
 * SMOKE_BASE (default http://localhost:$API_PORT, 8787), SMOKE_ORIGIN (default
 * http://localhost:$PORT, 5173) and SMOKE_EMAIL (default owner@example.com) override.
 * Re-runnable: names, emails and phones get a random suffix per run.
 */
import type {
  AdmissionResult,
  FamilyDetailDto,
  FamilySearchHit,
  GroupDto,
  ImportReport,
  MeResponse,
  Paged,
  ProgrammeDto,
  SchoolResponse,
  SessionDto,
  StaffRowDto,
  StudentListItem,
} from '@maktab/shared';
import { mintDevSession } from './dev-session';

const BASE = process.env.SMOKE_BASE ?? `http://localhost:${process.env.API_PORT ?? '8787'}`;
const EMAIL = process.env.SMOKE_EMAIL ?? 'owner@example.com';
// The Worker's CSRF guard compares Origin with APP_ORIGIN for form posts; browsers always send it.
const ORIGIN = process.env.SMOKE_ORIGIN ?? `http://localhost:${process.env.PORT ?? '5173'}`;
const run = Math.random().toString(36).slice(2, 7);
const phoneDigits = String(Math.floor(1_000_000 + Math.random() * 8_999_999));

let cookie = '';
let failed = 0;
let skipping = false;

type Res<T> = { status: number; body: T };
async function api<T>(method: string, path: string, body?: unknown): Promise<Res<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // non-JSON (CSV, image): keep the text
  }
  return { status: res.status, body: parsed as T };
}

function expectOk(cond: unknown, detail: unknown): void {
  if (!cond)
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400));
}

async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  if (skipping) {
    console.log(`SKIP  ${name}`);
    return;
  }
  try {
    const note = await fn();
    console.log(`PASS  ${name}${typeof note === 'string' ? `  (${note})` : ''}`);
  } catch (err) {
    failed++;
    skipping = true;
    console.log(`FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  let sessionId = '';
  let groupId = '';
  let familyId = '';
  const ids: string[] = [];

  await step('API reachable (GET /api/health)', async () => {
    const r = await api<{ status: string }>('GET', '/api/health');
    expectOk(r.status === 200 && r.body.status === 'ok', r);
  });

  await step(`dev-session cookie for ${EMAIL}`, async () => {
    const s = await mintDevSession(EMAIL);
    cookie = s.cookie;
    return s.bootstrapped ? 'bootstrapped as owner on an empty database' : 'existing user';
  });

  await step('signed in as owner (GET /api/me)', async () => {
    const r = await api<MeResponse>('GET', '/api/me');
    expectOk(r.status === 200 && r.body.roles.includes('owner'), r);
  });

  await step('wizard 1-2: school profile + mode (PUT /api/school)', async () => {
    const r = await api<SchoolResponse>('PUT', '/api/school', {
      name: 'Smoke Test School',
      name_ur: 'سموک ٹیسٹ اسکول',
      mode: 'both',
      phone: '042-35761234',
      default_lang: 'ur',
      receipt_prefix: 'STS',
    });
    expectOk(r.status === 200 && r.body.school?.mode === 'both', r);
  });

  await step('wizard 3: current session (POST /api/sessions)', async () => {
    const list = await api<{ items: SessionDto[] }>('GET', '/api/sessions');
    const current = list.body.items.find((s) => s.is_current);
    if (current) {
      sessionId = current.id;
      return `reused ${current.name}`;
    }
    const r = await api<SessionDto>('POST', '/api/sessions', {
      name: '2026-27',
      start_date: '2026-04-01',
      end_date: '2027-03-31',
    });
    expectOk(r.status === 201 && r.body.is_current, r);
    sessionId = r.body.id;
  });

  await step('wizard 4: seed PK ladder + subjects (idempotent)', async () => {
    const r = await api<{ created: number; items: ProgrammeDto[] }>(
      'POST',
      '/api/programmes/seed-pk',
    );
    expectOk(r.status === 200, r);
    const names = r.body.items.map((p) => p.name);
    for (const n of ['Nursery', 'KG', 'Class 1', 'Class 10', 'FSc Pre-Medical', 'ICS', 'FA']) {
      expectOk(names.includes(n), `missing ${n}`);
    }
    const again = await api<{ created: number }>('POST', '/api/programmes/seed-pk');
    expectOk(again.body.created === 0, again);
    const subs = await api<{ items: unknown[] }>('POST', '/api/subjects/seed-pk');
    expectOk(subs.status === 200 && subs.body.items.length >= 10, subs);
    return `${r.body.items.length} programmes`;
  });

  await step('wizard 5: create a group (POST /api/groups)', async () => {
    const progs = await api<{ items: ProgrammeDto[] }>('GET', '/api/programmes');
    const c5 = progs.body.items.find((p) => p.name === 'Class 5');
    expectOk(c5, 'Class 5 missing');
    const r = await api<GroupDto>('POST', '/api/groups', {
      programme_id: c5?.id,
      session_id: sessionId,
      name: `5-${run}`,
      capacity: 40,
    });
    expectOk(r.status === 201 && r.body.is_primary && r.body.seats_left === 40, r);
    groupId = r.body.id;
  });

  await step('wizard 6: invite a teacher (POST /api/staff/invite)', async () => {
    const r = await api<StaffRowDto>('POST', '/api/staff/invite', {
      email: `teacher-${run}@example.com`,
      role: 'teacher',
      name: 'Ms Sana',
    });
    expectOk(
      r.status === 201 && r.body.user_status === 'invited' && r.body.roles[0] === 'teacher',
      r,
    );
  });

  await step('wizard 7: done (POST /api/school/complete-setup)', async () => {
    const stale = await api('PUT', '/api/school', {
      name: 'Smoke Test School',
      mode: 'both',
      default_lang: 'ur',
      setup_completed: true,
    });
    expectOk(stale.status === 400, stale);
    const r = await api<SchoolResponse>('POST', '/api/school/complete-setup');
    expectOk(r.status === 200 && r.body.school?.setup_completed_at, r);
  });

  await step('admission 1: new family + guardian + student + enrolment', async () => {
    const r = await api<AdmissionResult>('POST', '/api/admissions', {
      family: { name: `Khan ${run}`, area: 'Gulberg' },
      guardians: [
        {
          name: 'Imran Khan',
          relation: 'father',
          phone: `0300-${phoneDigits}`,
          consent_whatsapp: true,
        },
      ],
      student: {
        name: `Ali ${run}`,
        father_name: 'Imran Khan',
        gender: 'm',
        admission_date: '2026-04-05',
      },
      enrolment: { grp_id: groupId },
    });
    expectOk(r.status === 201 && /^\d{4}-\d{4}$/.test(r.body.admission_no), r);
    familyId = r.body.family_id;
    ids.push(r.body.student_id);
    return `admission ${r.body.admission_no}, roll ${r.body.roll_no}`;
  });

  await step('sibling lookup by phone in another spelling (GET /api/families?phone=)', async () => {
    const q = encodeURIComponent(`+92 300 ${phoneDigits}`);
    const r = await api<{ items: FamilySearchHit[] }>('GET', `/api/families?phone=${q}`);
    expectOk(r.status === 200 && r.body.items.length === 1 && r.body.items[0]?.id === familyId, r);
  });

  await step('admission 2: sibling into the same family', async () => {
    const r = await api<AdmissionResult>('POST', '/api/admissions', {
      family_id: familyId,
      student: {
        name: `Sara ${run}`,
        father_name: 'Imran Khan',
        gender: 'f',
        admission_date: '2026-04-06',
      },
      enrolment: { grp_id: groupId },
    });
    expectOk(r.status === 201 && r.body.family_id === familyId, r);
    ids.push(r.body.student_id);
    return `admission ${r.body.admission_no}, roll ${r.body.roll_no}`;
  });

  await step('students list shows both siblings with the family link', async () => {
    const r = await api<Paged<StudentListItem>>(
      'GET',
      `/api/students?q=${encodeURIComponent(run)}`,
    );
    const mine = r.body.items.filter((s) => ids.includes(s.id));
    expectOk(r.status === 200 && mine.length === 2, r);
    expectOk(
      mine.every((s) => s.family_id === familyId && s.group_id === groupId),
      mine,
    );
    const fam = await api<FamilyDetailDto>('GET', `/api/families/${familyId}`);
    expectOk(fam.body.students.length === 2, fam);
    return mine.map((s) => `${s.name} ${s.admission_no}`).join(', ');
  });

  await step('extra: two concurrent admissions get distinct numbers', async () => {
    const one = (n: number) =>
      api<AdmissionResult>('POST', '/api/admissions', {
        family: { name: `Race ${run} ${n}` },
        guardians: [
          {
            name: 'G',
            phone: `0301-${String(Number(phoneDigits) + n)
              .padStart(7, '0')
              .slice(-7)}`,
          },
        ],
        student: { name: `Race ${run} ${n}`, admission_date: '2026-04-07' },
        enrolment: { grp_id: groupId },
      });
    const [a, b] = await Promise.all([one(1), one(2)]);
    expectOk(a.status === 201 && b.status === 201, [a, b]);
    expectOk(a.body.admission_no !== b.body.admission_no && a.body.roll_no !== b.body.roll_no, [
      a.body,
      b.body,
    ]);
    return `${a.body.admission_no} / ${b.body.admission_no}`;
  });

  await step('extra: second primary enrolment is a clean 409', async () => {
    const r = await api<{ error: { code: string } }>('POST', '/api/enrolments', {
      student_id: ids[0],
      grp_id: groupId,
      start_date: '2026-05-01',
    });
    expectOk(r.status === 409 && r.body.error.code === 'already_enrolled', r);
  });

  await step('extra: CSV import dry run, commit, re-commit is a no-op', async () => {
    const header =
      'student_name (طالب علم کا نام),group,guardian_name,guardian_phone,consent_whatsapp';
    const csv = `\uFEFF${header}\r\nCsv A ${run},5-${run},Asma,0302-${phoneDigits},yes\r\nCsv B ${run},5-${run},Asma,+92 302 ${phoneDigits},yes\r\nBad ${run},nope,X,123,yes\r\n`;
    // Commit as the web page does: one chunk (≤ 200 rows) with its offset in the file.
    const post = async (dry: boolean) => {
      const res = await fetch(
        `${BASE}/api/imports/students?${dry ? 'dry_run=1' : 'offset=0&total=3'}`,
        {
          method: 'POST',
          headers: { cookie, origin: ORIGIN, 'content-type': 'text/csv' },
          body: csv,
        },
      );
      return { status: res.status, body: (await res.json()) as ImportReport };
    };
    const dry = await post(true);
    expectOk(
      dry.status === 200 && dry.body.rows.map((r) => r.action).join() === 'create,create,error',
      dry,
    );
    const commit = await post(false);
    expectOk(commit.status === 201 && commit.body.summary.students === 2, commit);
    const again = await post(false);
    expectOk(again.body.rows.map((r) => r.action).join() === 'skip,skip,error', again);
    const list = await api<Paged<StudentListItem>>(
      'GET',
      `/api/students?q=${encodeURIComponent(`Csv A ${run}`)}`,
    );
    expectOk(list.body.total === 1, list);
    return `${commit.body.summary.students} students, ${commit.body.summary.families} family`;
  });

  await step(
    'extra: student photo to R2 (≤ 200 KB) and served back; oversize refused',
    async () => {
      const send = async (size: number) => {
        const bytes = new Uint8Array(size);
        bytes.set([0xff, 0xd8, 0xff, 0xe0]);
        const form = new FormData();
        form.append('file', new File([bytes], 'p.jpg', { type: 'image/jpeg' }));
        const res = await fetch(`${BASE}/api/students/${ids[0]}/photo`, {
          method: 'POST',
          headers: { cookie, origin: ORIGIN },
          body: form,
        });
        return res.status;
      };
      const ok = await send(50 * 1024);
      if (ok === 501) return 'R2 not bound (501), skipped';
      expectOk(ok === 200, `upload -> ${ok}`);
      expectOk((await send(201 * 1024)) === 413, 'oversize not refused');
      const got = await fetch(`${BASE}/api/students/${ids[0]}/photo`, { headers: { cookie } });
      expectOk(
        got.status === 200 && (await got.arrayBuffer()).byteLength === 50 * 1024,
        got.status,
      );
    },
  );

  await step('extra: an owner cannot remove their own owner role (409)', async () => {
    const me = await api<MeResponse>('GET', '/api/me');
    const r = await api<{ error: { code: string } }>('PUT', `/api/users/${me.body.user.id}/roles`, {
      roles: ['admin'],
    });
    expectOk(r.status === 409 && r.body.error.code === 'cannot_remove_self_owner', r);
  });

  console.log(failed ? `\nFAIL (${failed} step failed)` : '\nPASS (all steps)');
  process.exit(failed ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
