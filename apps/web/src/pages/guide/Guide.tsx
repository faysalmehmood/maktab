import {
  GUIDE_SECTIONS,
  GUIDE_UI,
  type GuideSectionId,
  type GuideTask,
  say,
  taskById,
  taskFor,
  tasksFor,
} from '@maktab/shared/guide';
import {
  CalendarRange,
  CheckCircle2,
  Flag,
  IdCard,
  type LucideIcon,
  Play,
  ShieldCheck,
  Smartphone,
  Store,
  Sunrise,
  Users,
} from 'lucide-react';
import { useEffect } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { ListRow, Page, PageHeader, Panel, RowList } from '@/components/page';
import { toast } from '@/components/ui/sonner';
import { Rich, usePlain } from '@/guide/Rich';
import { ShowMe, TaskBody, useGuideLang } from '@/guide/TaskBody';
import { useMe } from '@/lib/api';
import { useRoles } from '@/lib/roles';
import { useCompletedTours } from '@/lib/tour-done';

const SECTION_ICON: Record<GuideSectionId, LucideIcon> = {
  start: Flag,
  daily: Sunrise,
  office: Store,
  month: CalendarRange,
  parents: Users,
  staff: IdCard,
  safe: ShieldCheck,
  phone: Smartphone,
};

/** "Day 1, setup: open …" → "Day 1, setup" (the first-week steps lead with their name). */
const lead = (text: string) => text.split(/[:：]/)[0] ?? text;

/** The first week as one row of numbered stops, each a link to its step on the task page. */
function StartHere({ task }: { task: GuideTask }) {
  const lang = useGuideLang();
  const plainText = usePlain();
  return (
    <section
      id="guide-start"
      aria-labelledby="guide-start-title"
      className="flex flex-col gap-4 rounded-2xl border bg-card p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
          <p className="text-meta font-semibold text-brand">{say(GUIDE_UI.startHere, lang)}</p>
          <h2 id="guide-start-title" className="text-title">
            <Link to={`/guide/${task.id}`} className="hover:underline">
              <Rich text={task.title[lang]} />
            </Link>
          </h2>
          <p className="text-sm text-muted-foreground">
            <Rich text={task.summary[lang]} />
          </p>
        </div>
      </div>
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {task.steps.map((s, i) => (
          <li key={s.text.en} className="min-w-0">
            <Link
              to={`/guide/${task.id}${s.id ? `#step-${s.id}` : ''}`}
              className="flex min-h-12 items-center gap-2.5 rounded-lg border bg-background px-2.5 py-2 text-sm font-medium hover:border-brand hover:bg-brand-soft"
            >
              <span
                className="num grid size-7 shrink-0 place-items-center rounded-full bg-brand text-meta font-bold text-brand-fg"
                aria-hidden
              >
                {i + 1}
              </span>
              <span className="min-w-0 truncate">{lead(plainText(s.text[lang]))}</span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** /guide: the role's tasks, by section. */
export function GuideHome() {
  const lang = useGuideLang();
  const roles = useRoles();
  const done = useCompletedTours(useMe().data?.user.id);
  const mine = tasksFor(roles);
  const first = mine.find((t) => t.id === 'first-week');
  useEffect(() => {
    document.title = say(GUIDE_UI.title, lang);
  }, [lang]);
  return (
    <Page id="guide-home" width="detail">
      <PageHeader title={say(GUIDE_UI.title, lang)} subtitle={say(GUIDE_UI.intro, lang)} />
      {first && <StartHere task={first} />}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {GUIDE_SECTIONS.map((s) => {
          const tasks = mine.filter((t) => t.section === s.id && t !== first);
          if (!tasks.length) return null;
          const Icon = SECTION_ICON[s.id];
          return (
            <Panel
              key={s.id}
              id={`guide-section-${s.id}`}
              title={
                <span className="flex items-center gap-2">
                  <Icon className="size-[18px] text-brand" aria-hidden />
                  {say(s.title, lang)}
                </span>
              }
            >
              <p className="px-4 pt-3 text-meta text-muted-foreground">{say(s.blurb, lang)}</p>
              <RowList>
                {tasks.map((t) => (
                  <ListRow
                    key={t.id}
                    to={`/guide/${t.id}`}
                    title={<Rich text={t.title[lang]} />}
                    meta={<Rich text={t.summary[lang]} />}
                    trailing={
                      done.includes(t.id) ? (
                        <CheckCircle2
                          className="size-4 text-ok"
                          aria-label={say(GUIDE_UI.done, lang)}
                        />
                      ) : t.tour?.length ? (
                        <Play
                          className="size-4 text-muted-foreground rtl:-scale-x-100"
                          aria-label={say(GUIDE_UI.showMe, lang)}
                        />
                      ) : undefined
                    }
                  />
                ))}
              </RowList>
            </Panel>
          );
        })}
      </div>
    </Page>
  );
}

function NotYours() {
  const lang = useGuideLang();
  useEffect(() => {
    toast.error(say(GUIDE_UI.notFound, lang), { id: 'guide-not-yours' });
  }, [lang]);
  return <Navigate to="/guide" replace />;
}

/** /guide/:taskId: one task in full. A task outside the role's list goes back to /guide. */
export function GuideTaskPage() {
  const { taskId = '' } = useParams();
  const lang = useGuideLang();
  const me = useMe().data;
  const plainText = usePlain();
  const task = taskById(taskId);
  const title = task ? plainText(task.title[lang]) : '';
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);
  if (!me) return null;
  if (!task || !taskFor(task, me.roles)) return <NotYours />;
  return (
    <Page id="guide-task" width="form" data-task={task.id}>
      <PageHeader
        back={{ to: '/guide', label: say(GUIDE_UI.allTasks, lang) }}
        title={<Rich text={task.title[lang]} />}
        subtitle={<Rich text={task.summary[lang]} />}
      />
      <ShowMe task={task} />
      <TaskBody task={task} />
    </Page>
  );
}
