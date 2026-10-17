import type { TeacherRowDto, TeacherSubjectRef } from '@maktab/shared';
import type { TFunction } from 'i18next';
import { isolate } from '@/lib/utils';

/*
 * The Teachers table's cell texts, shared by the screen, the sheet and the printout. Every name is
 * a data value inside UI text, so each is isolated (FSI/PDI) and keeps its own direction in Urdu.
 */

export const NONE = '—';

export const subjectLabel = (t: TFunction, s: TeacherSubjectRef) =>
  t('screens.teachers.subjectIn', { group: isolate(s.grp_name), subject: isolate(s.subject_name) });

export const classTeacherText = (t: TFunction, r: TeacherRowDto) =>
  r.class_teacher_of.length
    ? r.class_teacher_of.map((g) => isolate(g.name)).join(t('screens.teachers.sep'))
    : NONE;

/** A teacher's subjects grouped by subject name, in the server's order. */
export function bySubject(
  subjects: readonly TeacherSubjectRef[],
): { subject: string; refs: TeacherSubjectRef[] }[] {
  const out = new Map<string, TeacherSubjectRef[]>();
  for (const s of subjects) {
    const list = out.get(s.subject_name);
    if (list) list.push(s);
    else out.set(s.subject_name, [s]);
  }
  return [...out].map(([subject, refs]) => ({ subject, refs }));
}

/**
 * "Class 4 A, 4 B, 5 A": the first group in full, each later one without the programme's leading
 * words it shares with the first ("Class"), always keeping the programme's last word ("4").
 */
export function shortGroupNames(refs: readonly TeacherSubjectRef[]): string[] {
  const first = refs[0]?.programme_name.split(' ') ?? [];
  return refs.map((r, i) => {
    if (i === 0) return r.grp_name;
    const words = r.programme_name.split(' ');
    let k = 0;
    while (k < words.length - 1 && k < first.length && words[k] === first[k]) k++;
    return [...words.slice(k), r.group_name].join(' ');
  });
}

/**
 * One line per subject: "Social Studies (8): Class 4 A, 4 B, 5 A, 5 B, 6 A, 6 B +2". `limit`
 * caps the groups shown (the screen); the sheet and the printout pass none (the full list).
 */
export function subjectLines(t: TFunction, r: TeacherRowDto, limit?: number): string[] {
  return bySubject(r.subjects).map(({ subject, refs }) => {
    const names = shortGroupNames(refs).map(isolate);
    const shown = limit && names.length > limit ? names.slice(0, limit) : names;
    const rest = names.length - shown.length;
    const groups = shown.join(t('screens.teachers.groupSep'));
    return t('screens.teachers.subjectLine', {
      subject: isolate(subject),
      count: refs.length,
      groups: rest > 0 ? `${groups} ${t('screens.teachers.more', { count: rest })}` : groups,
    });
  });
}

/** "3 classes · 1 subject" (distinct subject names). */
export const loadText = (t: TFunction, r: Pick<TeacherRowDto, 'load'>) =>
  t('screens.teachers.loadValue', {
    groups: t('screens.teachers.groups', { count: r.load.groups }),
    subjects: t('screens.teachers.subjectCount', { count: r.load.subjects }),
  });
