"use client";
import { useEffect, useState } from "react";
import { BadgeCheck, ChevronRight, Clock, FileText, Plus, Sparkles } from "lucide-react";
import { rpc } from "@/lib/client/api";
import { SOURCE_LABEL, dateOnly, dateTime, projectLine } from "@/lib/client/format";
import type { EventRow, Fact, ProjectDetail, Task } from "@/lib/types";
import { AddEventDialog } from "../AddEventDialog";
import { DealFacts, FactRow } from "../DealFacts";
import { AddFile, FileItem } from "../FileList";
import { Badge, Button, Card, Empty, ErrorNote, Spinner, Tabs, useLoad, useToast } from "../ui";
import { AGENT_STATUS, TaskCard, TaskFormDialog } from "./TaskCard";
import { Coach, TOURS } from "../Coach";

type Tab = "status" | "timeline" | "tasks" | "files";

function TaskRow({ task, tz, onOpen, children }: { task: Task; tz: string; onOpen: () => void; children?: React.ReactNode }) {
  const status = AGENT_STATUS[task.status] ?? AGENT_STATUS.suggested;
  return (
    <div className="rounded-xl border border-line bg-white p-3.5">
      <button className="flex w-full items-start gap-2 text-left" onClick={onOpen}>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-medium leading-snug">{task.title}</span>
          <span className="mt-0.5 block text-xs text-ink-3">
            {task.status === "suggested"
              ? task.origin_event_title
                ? `From ${task.origin_event_title}`
                : task.category
              : task.status === "delivered"
                ? `Delivered ${dateTime(task.delivered_at, tz)}`
                : task.eta
                  ? `Expected ${dateTime(task.eta, tz)}`
                  : "Delivery time coming shortly"}
          </span>
        </span>
        {task.status !== "suggested" ? <Badge tone={status.tone}>{status.label}</Badge> : null}
        <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" />
      </button>
      {children}
    </div>
  );
}

export function AgentProject({ projectId, preview, onBack }: { projectId: string; preview?: boolean; onBack?: () => void }) {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad(() => rpc<ProjectDetail>("getProject", { project_id: projectId, as_agent: true }), [projectId], { refreshMs: 30000 });
  const [tab, setTab] = useState<Tab>("status");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [newTask, setNewTask] = useState(false);
  const [add, setAdd] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [openEvent, setOpenEvent] = useState<string | null>(null);

  useEffect(() => {
    setTab("status");
    setTaskId(null);
  }, [projectId]);

  const pendingCount = data?.processingEvents ?? 0;
  useEffect(() => {
    if (!pendingCount || preview) return;
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      rpc<{ changed: boolean }>("pollProject", { project_id: projectId })
        .then((r) => {
          if (r.changed) reload(true);
        })
        .catch(() => {});
    }, 10000);
    return () => window.clearInterval(id);
  }, [pendingCount, preview, projectId, reload]);

  if (error && !data) return <ErrorNote message={error} onRetry={() => reload()} />;
  if (loading && !data) return <Spinner />;
  if (!data) return null;

  const tz = data.agent.timezone;
  const vaName = data.va?.name.split(" ")[0] ?? "your assistant";
  const suggested = data.tasks.filter((t) => t.status === "suggested");
  const active = data.tasks.filter((t) => ["received", "in_progress", "waiting"].includes(t.status));
  const delivered = data.tasks.filter((t) => t.status === "delivered");
  const needsAnswer = active.filter((t) => t.status === "waiting").length;
  const unreviewed = delivered.filter((t) => !t.agent_feedback).length;

  async function act(key: string, fn: string, args: Record<string, unknown>, done?: string, undo?: () => Promise<unknown>) {
    setBusy(key);
    try {
      await rpc(fn, args);
      await reload(true);
      if (done) toast(done, undo ? { action: { label: "Undo", run: async () => { await undo().catch(() => {}); reload(true); } } } : undefined);
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  const resolve = (fact: Fact) => act(fact.id, "resolveFact", { fact_id: fact.id }, "Marked resolved.", () => rpc("resolveFact", { fact_id: fact.id, undo: true }));

  const firstOf = (list: Task[]) => () => {
    setTab("tasks");
    if (list.length === 1) setTaskId(list[0].id);
  };
  const waiting = active.filter((t) => t.status === "waiting");
  const toReview = delivered.filter((t) => !t.agent_feedback);
  const attention: { text: string; action: string; go: () => void; primary?: boolean }[] = [];
  if (waiting.length) attention.push({ text: `${vaName} has ${waiting.length === 1 ? "a question" : `${waiting.length} questions`} for you`, action: "Answer", go: firstOf(waiting), primary: true });
  if (toReview.length) attention.push({ text: `${toReview.length} finished ${toReview.length === 1 ? "request is" : "requests are"} ready to review`, action: "Review", go: firstOf(toReview), primary: !waiting.length });
  if (suggested.length) attention.push({ text: `${suggested.length} suggested ${suggested.length === 1 ? "follow-up" : "follow-ups"} from your conversations`, action: "See suggestions", go: () => setTab("tasks") });

  const byDay = new Map<string, EventRow[]>();
  for (const e of data.events) {
    const key = dateOnly(e.occurred_at, tz);
    byDay.set(key, [...(byDay.get(key) ?? []), e]);
  }

  return (
    <div>
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[13px] text-ink-3">
        {onBack ? (
          <button className="text-accent hover:underline" onClick={onBack}>
            All Projects
          </button>
        ) : (
          <span>All Projects</span>
        )}
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="truncate text-ink">{data.project.client_name}</span>
      </nav>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{data.project.client_name}</h1>
          <p className="text-[13px] text-ink-3">{projectLine(data.facts.some((f) => f.section === "budget") ? { ...data.project, budget: null } : data.project)}</p>
        </div>
        {!preview ? (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setNewTask(true)}>
              Submit a request
            </Button>
            <Button data-tour="add-conversation" variant="primary" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAdd(true)}>
              Add material
            </Button>
          </div>
        ) : null}
      </div>

      <Tabs
        className="mt-3"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "status", label: "Deal status", tour: "tab-status" },
          { key: "timeline", label: "Timeline", tour: "tab-timeline" },
          { key: "tasks", label: "Requests", count: suggested.length + needsAnswer + unreviewed, tour: "tab-tasks" },
          { key: "files", label: "Files", tour: "tab-files" },
        ]}
      />

      {!preview && tab === "status" && attention.length ? (
        <div className="mt-4 rounded-xl border border-line bg-white p-3.5">
          <div className="text-xs font-semibold uppercase tracking-wide text-ink-3">Waiting on you</div>
          <ul className="mt-2 space-y-2">
            {attention.map((a) => (
              <li key={a.text} className="flex items-center justify-between gap-3 text-sm">
                <span>{a.text}</span>
                <Button size="sm" variant={a.primary ? "primary" : "outline"} onClick={a.go}>
                  {a.action}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {tab === "status" ? (
        <div className="mt-4 space-y-4">
          {data.lastVerified ? (
            <div className="flex items-center gap-2 rounded-xl bg-ok-soft px-3.5 py-2.5 text-[13px] text-ok">
              <BadgeCheck className="h-4 w-4 shrink-0" />
              <span>
                Verified by {data.lastVerified.by.split(" ")[0]}, {dateTime(data.lastVerified.at, tz)}
              </span>
            </div>
          ) : null}
          {data.pendingEvents ? (
            <div className="flex items-center gap-2 rounded-xl bg-accent-soft px-3.5 py-2.5 text-[13px] text-[#2f55cc]">
              <Clock className="h-4 w-4 shrink-0" />
              <span>
                {data.pendingEvents} new {data.pendingEvents === 1 ? "conversation is" : "conversations are"} being verified{data.va ? ` by ${vaName}` : ""}. {data.pendingDue ? `Ready by ${dateTime(data.pendingDue, tz, true)}.` : "Expect an update by 9:00 AM the next business day."}
              </span>
            </div>
          ) : null}
          {data.facts.length === 0 ? (
            <Card>
              <Empty
                icon={<FileText className="h-5 w-5" />}
                title={data.pendingEvents ? "Verification in progress" : "Nothing added yet"}
                body={data.pendingEvents ? `${vaName === "your assistant" ? "Your assistant" : vaName} is checking the facts against the transcript. Decisions, changes, and open questions will show here.` : "Add a recording, transcript, or text thread and this page fills in with what was decided and what is still open."}
                action={!preview && !data.pendingEvents ? <Button onClick={() => setAdd(true)}>Add material</Button> : null}
              />
            </Card>
          ) : (
            <DealFacts facts={data.facts} tz={tz} onResolve={preview ? undefined : resolve} />
          )}
        </div>
      ) : null}

      {tab === "timeline" ? (
        <div className="mt-4 space-y-5">
          {data.events.length === 0 ? (
            <Card>
              <Empty title="Nothing on the timeline yet" body="Each verified conversation appears here with its summary and facts." />
            </Card>
          ) : null}
          {Array.from(byDay.entries()).map(([day, events]) => (
            <div key={day}>
              <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-ink-2">
                <span className="h-2 w-2 rounded-full bg-accent" />
                {day}
              </div>
              <div className="space-y-2 border-l border-line pl-4 ml-[3px]">
                {events.map((e) => {
                  const facts = data.facts.filter((f) => f.event_id === e.id);
                  const open = openEvent === e.id;
                  return (
                    <Card key={e.id} className="p-3.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-medium">{e.title}</div>
                          <div className="text-xs text-ink-3">
                            {SOURCE_LABEL[e.source]}, {dateTime(e.occurred_at, tz)}
                            {e.duration_sec ? `, ${Math.max(1, Math.round(e.duration_sec / 60))} min` : ""}
                          </div>
                        </div>
                        <Badge tone="ok">Verified</Badge>
                      </div>
                      {e.summary ? <p className="mt-2 text-sm text-ink-2">{e.summary}</p> : null}
                      {facts.length && !open ? (
                        <ul className="mt-2 space-y-1">
                          {facts.slice(0, 3).map((f) => (
                            <li key={f.id} className="flex gap-2 text-sm text-ink-2">
                              <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-ink-3" />
                              {f.statement}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {facts.length ? (
                        <button className="mt-2 text-[13px] font-medium text-accent hover:underline" aria-expanded={open} onClick={() => setOpenEvent(open ? null : e.id)}>
                          {open ? "Show less" : facts.length > 3 ? `Show all ${facts.length} facts with sources` : "Show sources"}
                        </button>
                      ) : (
                        <p className="mt-2 text-[13px] text-ink-3">Nothing new for the deal came out of this one.</p>
                      )}
                      {open ? (
                        <div className="mt-1 divide-y divide-line">
                          {facts.map((f) => (
                            <FactRow key={f.id} fact={f} tz={tz} />
                          ))}
                        </div>
                      ) : null}
                    </Card>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {tab === "tasks" ? (
        <div className="mt-4 space-y-5">
          {data.tasks.length === 0 ? (
            <Card>
              <Empty icon={<Sparkles className="h-5 w-5" />} title="No requests yet" body={`After each conversation, suggested follow-up work shows up here. You can also submit your own request to ${vaName}.`} />
            </Card>
          ) : null}
          {suggested.length ? (
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">Suggested for you ({suggested.length})</h2>
              <div className="space-y-2">
                {suggested.map((t) => (
                  <TaskRow key={t.id} task={t} tz={tz} onOpen={() => setTaskId(t.id)}>
                    <p className="mt-1.5 line-clamp-2 text-[13px] text-ink-2">{t.description}</p>
                    {!preview ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button size="sm" variant="primary" busy={busy === t.id} onClick={() => act(t.id, "assignTask", { task_id: t.id }, `Sent to ${vaName}.`)}>
                          Send to {vaName}
                        </Button>
                        <Button size="sm" onClick={() => setTaskId(t.id)}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => act(`d${t.id}`, "dismissTask", { task_id: t.id }, "Suggestion dismissed.", () => rpc("dismissTask", { task_id: t.id, undo: true }))}>
                          Dismiss
                        </Button>
                      </div>
                    ) : null}
                  </TaskRow>
                ))}
              </div>
            </section>
          ) : null}
          {active.length ? (
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">In progress ({active.length})</h2>
              <div className="space-y-2">
                {active.map((t) => (
                  <TaskRow key={t.id} task={t} tz={tz} onOpen={() => setTaskId(t.id)} />
                ))}
              </div>
            </section>
          ) : null}
          {delivered.length ? (
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">Delivered ({delivered.length})</h2>
              <div className="space-y-2">
                {delivered.map((t) => (
                  <TaskRow key={t.id} task={t} tz={tz} onOpen={() => setTaskId(t.id)}>
                    {!t.agent_feedback ? <p className="mt-1.5 text-[13px] font-medium text-accent">Ready for your review</p> : null}
                  </TaskRow>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      {tab === "files" ? (
        <div className="mt-4 space-y-5">
          {(
            [
              { title: `Delivered by ${vaName}`, rows: data.files.filter((f) => f.kind === "deliverable"), empty: "Finished work appears here once a request is delivered." },
              { title: "Project files", rows: data.files.filter((f) => f.kind === "project"), empty: "Add documents your assistant should know about, such as disclosures or a buyer questionnaire.", upload: true },
              { title: "Attached to requests", rows: data.files.filter((f) => f.kind === "attachment"), empty: "" },
            ] as const
          ).map((group) =>
            group.rows.length === 0 && !group.empty ? null : (
              <section key={group.title}>
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-3">{group.title}</h2>
                  {"upload" in group && !preview ? <AddFile projectId={projectId} kind="project" allowLink onAdded={() => reload(true)} /> : null}
                </div>
                <div className="space-y-2">
                  {group.rows.length === 0 ? <p className="rounded-xl border border-dashed border-line-strong bg-white px-4 py-5 text-center text-[13px] text-ink-3">{group.empty}</p> : null}
                  {group.rows.map((f) => (
                    <FileItem key={f.id} file={f} canDelete={!preview && f.kind !== "deliverable" && f.uploaded_role === "agent"} onDeleted={() => reload(true)} />
                  ))}
                </div>
              </section>
            ),
          )}
        </div>
      ) : null}

      {!preview ? <Coach name="agent-project" steps={TOURS.agentProject} /> : null}
      <TaskCard taskId={taskId} vaName={vaName} tz={tz} preview={preview} onClose={() => setTaskId(null)} onChanged={() => reload(true)} />
      <TaskFormDialog
        open={newTask}
        onClose={() => setNewTask(false)}
        projectId={projectId}
        onSaved={() => {
          reload(true);
          toast(`Sent to ${vaName}.`);
        }}
      />
      <AddEventDialog
        heading="Add material"
        open={add}
        onClose={() => setAdd(false)}
        projects={[data.project]}
        defaultProjectId={projectId}
        onFilesAdded={(_pid, n) => {
          reload(true);
          setTab("files");
          toast(n === 1 ? "File added. Your assistant can see it." : `${n} files added. Your assistant can see them.`);
        }}
        onCreated={(e) => {
          reload(true);
          toast(e.status === "failed" ? `We could not process it: ${e.error}` : "Received. Your assistant will verify it.", e.status === "failed" ? { tone: "error" } : undefined);
        }}
      />
    </div>
  );
}
