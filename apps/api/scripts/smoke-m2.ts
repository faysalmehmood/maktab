/**
 * Milestone 2 definition of done, over HTTP against `wrangler dev --local`: a teacher syncs a
 * register with two absentees (applied), the phone replays it (duplicate), the office corrects it
 * with a reason (replaced), an older offline copy arrives late (stale), a holiday register is
 * refused (rejected), "today" shows the group taken, the message queue holds one absence alert per
 * family, and the monthly CSV has the right cells. Prints PASS/FAIL per step; exit 1 on failure.
 *
 *   npm run db:migrate:local && npm run dev -w @maktab/api      # terminal 1
 *   npm run smoke:m2 -w @maktab/api                              # terminal 2
 *
 * Self-contained (makes its own group, teacher and students with a random suffix), so it runs on
 * an empty database, after smoke:m1 or after db:seed, and again. The school's weekly day off is
 * cleared for the run (today might be a Sunday) and restored at the end, as is the test holiday.
 */
import type {
  AdmissionResult,
  AttendanceSubmission,
  AttendanceSyncResult,
  DashboardTodayResponse,
  GroupDto,
  MessageDto,
  ProgrammeDto,
  SchoolResponse,
  SessionDto,
  StaffRowDto,
  TodayResponse,
} from '@maktab/shared';
import { newId } from '@maktab/shared';
import { mintDevSession } from './dev-session';
import { always, EMAIL, expectOk, finish, makeApi, runId as run, step } from './smoke-lib';

let ownerCookie = '';
let teacherCookie = '';
const api = makeApi(() => ownerCookie);
const teacher = makeApi(() => teacherCookie);

/** Today in Asia/Karachi, as the server computes it. */
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Karachi',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
const daysAgo = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const phone = () => `0300-${String(Math.floor(1_000_000 + Math.random() * 8_999_999))}`;

async function main() {
  let groupId = '';
  let otherGroupId = '';
  let restoreSettings: { attendance_mode: string; weekly_off: number[] } | null = null;
  const students: AdmissionResult[] = [];
  const holiday = daysAgo(1);
  let addedHoliday = false;
  let synced: AttendanceSubmission | null = null;
  let firstRegister = '';

  const sync = async (subs: AttendanceSubmission[]) => {
    const r = await teacher<{ results: AttendanceSyncResult[] }>(
      'POST',
      '/api/attendance/sync',
      subs,
    );
    expectOk(r.status === 200, r);
    return r.body.results;
  };
  const register = (over: Partial<AttendanceSubmission> = {}): AttendanceSubmission => ({
    client_id: newId(),
    grp_id: groupId,
    date: today,
    taken_at: new Date().toISOString(),
    marks: students.map((s, i) => ({ student_id: s.student_id, status: i < 2 ? 'A' : 'P' })),
    ...over,
  });

  await step('API reachable (GET /api/health)', async () => {
    const r = await api<{ status: string }>('GET', '/api/health');
    expectOk(r.status === 200 && r.body.status === 'ok', r);
  });

  await step(`owner session for ${EMAIL}`, async () => {
    ownerCookie = (await mintDevSession(EMAIL)).cookie;
  });

  await step('school + current session exist (created if missing)', async () => {
    const s = await api<SchoolResponse>('GET', '/api/school');
    if (!s.body.school) {
      const r = await api('PUT', '/api/school', { name: 'Smoke Test School', mode: 'both' });
      expectOk(r.status === 200, r);
    }
    const sessions = await api<{ items: SessionDto[] }>('GET', '/api/sessions');
    if (!sessions.body.items.some((x) => x.is_current)) {
      const r = await api('POST', '/api/sessions', {
        name: '2026-27',
        start_date: '2026-04-01',
        end_date: '2027-03-31',
      });
      expectOk(r.status === 201, r);
    }
    await api('POST', '/api/programmes/seed-pk');
    const after = await api<SchoolResponse>('GET', '/api/school');
    const sc = after.body.school;
    expectOk(sc, after);
    restoreSettings = {
      attendance_mode: sc?.attendance_mode ?? 'daily',
      weekly_off: sc?.weekly_off ?? [0],
    };
    const r = await api('PUT', '/api/school/attendance', {
      attendance_mode: 'daily',
      weekly_off: [],
    });
    expectOk(r.status === 200, r);
    return `weekly off was ${JSON.stringify(restoreSettings.weekly_off)}; cleared for the run`;
  });

  await step('two groups; an invited teacher is class teacher of the first', async () => {
    const progs = await api<{ items: ProgrammeDto[] }>('GET', '/api/programmes');
    const c6 = progs.body.items.find((p) => p.name === 'Class 6');
    expectOk(c6, 'Class 6 missing');
    const inv = await api<StaffRowDto>('POST', '/api/staff/invite', {
      email: `m2-teacher-${run}@example.com`,
      role: 'teacher',
      name: `Ms Hina ${run}`,
      with_profile: true,
    });
    expectOk(inv.status === 201 && inv.body.staff_id, inv);
    const mk = async (name: string, teacherId: string | null) => {
      const g = await api<GroupDto>('POST', '/api/groups', {
        programme_id: c6?.id,
        name,
        class_teacher_id: teacherId,
      });
      expectOk(g.status === 201, g);
      return g.body.id;
    };
    groupId = await mk(`6-${run}`, inv.body.staff_id);
    otherGroupId = await mk(`6x-${run}`, null);
    teacherCookie = (await mintDevSession(`m2-teacher-${run}@example.com`, { activate: true }))
      .cookie;
  });

  await step(
    'admit 3 students (two families with WhatsApp consent, one without) + 1 elsewhere',
    async () => {
      const admit = async (name: string, consent: boolean, grp = groupId) => {
        const r = await api<AdmissionResult>('POST', '/api/admissions', {
          family: { name: `${name} family ${run}` },
          guardians: [{ name: `${name} Sr`, phone: phone(), consent_whatsapp: consent }],
          student: { name: `${name} ${run}`, admission_date: daysAgo(30) },
          enrolment: { grp_id: grp },
        });
        expectOk(r.status === 201, r);
        return r.body;
      };
      students.push(await admit('Ali', true));
      students.push(await admit('Sara', true));
      students.push(await admit('Bilal', false));
      // An empty group has no register to take; this one is only there to stay "not taken".
      await admit('Zain', true, otherGroupId);
    },
  );

  await step('teacher syncs today with 2 absent -> applied, 2 messages queued', async () => {
    synced = register({ taken_at: new Date(Date.now() - 60_000).toISOString() });
    const [r] = await sync([synced]);
    expectOk(r?.status === 'applied' && r.queued_messages === 2, r);
    firstRegister = r?.register_id ?? '';
  });

  await step('replay of the same register -> duplicate', async () => {
    if (!synced) throw new Error('no register');
    const [r] = await sync([synced]);
    expectOk(r?.status === 'duplicate' && r.register_id === firstRegister, r);
  });

  await step('office corrects with a reason (Ali came late) -> replaced', async () => {
    const noReason = await api('POST', '/api/attendance/correct', register());
    expectOk(noReason.status === 400, noReason);
    const byTeacher = await teacher('POST', '/api/attendance/correct', {
      ...register(),
      reason: 'x',
    });
    expectOk(byTeacher.status === 403, byTeacher);
    const r = await api<AttendanceSyncResult>('POST', '/api/attendance/correct', {
      ...register(),
      marks: students.map((s, i) => ({
        student_id: s.student_id,
        status: i === 0 ? 'L' : i === 1 ? 'A' : 'P',
      })),
      reason: 'Ali came late; office corrected',
    });
    expectOk(r.status === 200 && r.body.status === 'replaced', r);
  });

  await step('an older offline copy arriving late -> stale (current unchanged)', async () => {
    const [r] = await sync([
      register({ taken_at: new Date(Date.now() - 3_600_000).toISOString() }),
    ]);
    expectOk(r?.status === 'stale', r);
  });

  await step('register on a holiday -> rejected (holiday)', async () => {
    const h = await api('POST', '/api/holidays', { date: holiday, name_en: `Smoke ${run}` });
    expectOk(h.status === 201 || h.status === 200, h);
    addedHoliday = h.status === 201;
    const [r] = await sync([register({ date: holiday })]);
    expectOk(r?.status === 'rejected' && r.error === 'holiday', r);
  });

  await step("teacher cannot sync another teacher's group -> rejected (forbidden)", async () => {
    const [r] = await sync([register({ grp_id: otherGroupId })]);
    expectOk(r?.status === 'rejected' && r.error === 'forbidden', r);
  });

  await step('GET /api/attendance/today (teacher) shows the group taken', async () => {
    const r = await teacher<TodayResponse>('GET', '/api/attendance/today');
    const mine = r.body.items.find((i) => i.grp_id === groupId);
    expectOk(r.status === 200 && mine?.status === 'taken', r);
    expectOk(mine?.counts.L === 1 && mine.counts.A === 1 && mine.counts.P === 1, mine);
    expectOk(!r.body.items.some((i) => i.grp_id === otherGroupId), 'scope leak');
    return `taken by ${mine?.taken_by_name}`;
  });

  await step(
    'GET /api/messages?status=queued&template_key=absence shows 2 for this group',
    async () => {
      const r = await api<{ items: MessageDto[] }>(
        'GET',
        `/api/messages?status=queued&template_key=absence&date=${today}`,
      );
      const mine = r.body.items.filter((m) => m.payload?.grp_id === groupId);
      expectOk(r.status === 200 && mine.length === 2, mine);
      expectOk(
        mine.every((m) => m.channel === 'wa_manual' && m.guardian_phone),
        mine,
      );
    },
  );

  await step('dashboard today counts', async () => {
    const r = await api<DashboardTodayResponse>('GET', '/api/dashboard/today');
    expectOk(r.status === 200, r);
    expectOk(
      r.body.registers.not_taken.some((i) => i.grp_id === otherGroupId) &&
        !r.body.registers.not_taken.some((i) => i.grp_id === groupId),
      r.body.registers,
    );
    expectOk(
      r.body.absentees.some((a) => a.student_id === students[1]?.student_id),
      r.body,
    );
    expectOk(r.body.queued_absence_messages >= 2, r.body);
    return `${r.body.registers.taken}/${r.body.registers.total} taken, ${r.body.queued_absence_messages} queued`;
  });

  await step('monthly register CSV has the right cells', async () => {
    const r = await teacher<string>(
      'GET',
      `/api/attendance/report?grp_id=${groupId}&month=${today.slice(0, 7)}&format=csv`,
    );
    expectOk(r.status === 200, r.status);
    const lines = r.text.replace(/^﻿/, '').trim().split('\r\n');
    const col = 2 + Number(today.slice(8)) - 1;
    const cellFor = (name: string) =>
      lines.find((l) => l.includes(`${name} ${run}`))?.split(',')[col];
    const got = [cellFor('Ali'), cellFor('Sara'), cellFor('Bilal')];
    expectOk(got.join() === 'L,A,P', got);
    return `today's column: ${got.join(' ')}`;
  });

  await always('cleanup: restore weekly off, remove the test holiday', async () => {
    if (restoreSettings) await api('PUT', '/api/school/attendance', restoreSettings);
    if (addedHoliday) await api('DELETE', `/api/holidays/${holiday}`);
  });

  finish();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
