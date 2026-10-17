import type { TeacherRowDto, TeacherSubjectRef } from '@maktab/shared';
import type { TFunction } from 'i18next';
import { isolate } from '@/lib/utils';

/*
 * The Teachers table's cell texts, shared by the screen and the printout. Every name is a data
 * value inside UI text, so each is isolated (FSI/PDI) and keeps its own direction in Urdu.
 */

const NONE = '—';

export const subjectLabel = (t: TFunction, s: TeacherSubjectRef) =>
  t('screens.teachers.subjectIn', { group: isolate(s.grp_name), subject: isolate(s.subject_name) });

export const classTeacherText = (t: TFunction, r: TeacherRowDto) =>
  r.class_teacher_of.length
    ? r.class_teacher_of.map((g) => isolate(g.name)).join(t('screens.teachers.sep'))
    : NONE;

/** "Class 6 A Maths, Class 7 A Maths". */
export const subjectsText = (t: TFunction, r: TeacherRowDto) =>
  r.subjects.length
    ? r.subjects.map((s) => subjectLabel(t, s)).join(t('screens.teachers.sep'))
    : NONE;

/** "3 groups · 5 subjects". */
export const loadText = (t: TFunction, r: Pick<TeacherRowDto, 'load'>) =>
  t('screens.teachers.loadValue', {
    groups: t('screens.teachers.groups', { count: r.load.groups }),
    subjects: t('screens.teachers.subjectCount', { count: r.load.subjects }),
  });
