"use client";
import { useEffect, useState } from "react";
import { Pause, Play, Send } from "lucide-react";
import { rpc } from "@/lib/client/api";
import { CHANNEL_LABEL, FEEDBACK_LABEL, TASK_STATUS_LABEL, clock, dateOnly, dateTime, remaining, taskNo, toLocalInput, tzAbbr } from "@/lib/client/format";
import { TASK_CATEGORIES, type Task, type TaskDetail, type TaskStatus } from "@/lib/types";
import { AddFile, FileItem } from "../FileList";
import { TaskThread } from "../TaskThread";
import { Badge, Button, ErrorNote, Field, Input, Modal, Select, Spinner, Textarea, useLoad, useNow, useToast, type Tone } from "../ui";
import type { VaNav } from "./Console";
import { Coach, TOURS } from "../Coach";

export const STATUS_TONE: Record<TaskStatus, Tone> = { suggested: "neutral", received: "accent", in_progress: "dark", waiting: "warn", delivered: "ok", cancelled: "neutral", dismissed: "neutral" };

export function NewTicketDialog({ open, onClose, projectId, onCreated }: { open: boolean; onClose: () => void; projectId: string; onCreated: (task: Task) => void }) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("Research");
  const [via, setVia] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setTitle("");
      setDescription("");
      setCategory("Research");
      setVia("");
    }
  }, [open]);
  async function save() {
    if (!title.trim() || !description.trim()) return toast("Add a title and what the agent asked for.", { tone: "error" });
    if (!via) return toast("Choose how the agent asked for this.", { tone: "error" });
    setBusy(true);
    try {
      onCreated(await rpc<Task>("createTask", { project_id: projectId, title, description, category, requested_via: via }));
      onClose();
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New ticket for the agent"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={save}>
            Create ticket
          </Button>
        </>
      }
    >
      <p className="text-[13px] text-ink-3">Only log work the agent actually asked for. The agent sees this ticket in their Tasks.</p>
      <div className="mt-4 space-y-4">
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} placeholder="Shortlist 3 bed homes near Lincoln Elementary" />
        </Field>
        <Field label="What the agent asked for">
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {TASK_CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Field label="Requested via">
            <Select value={via} onChange={(e) => setVia(e.target.value)}>
              <option value="" disabled>
                Choose
              </option>
              <option value="text">Text</option>
              <option value="email">Email</option>
              <option value="call">Call</option>
            </Select>
          </Field>
        </div>
      </div>
    </Modal>
  );
}

export function Ticket({ nav, taskId, onChanged }: { nav: VaNav; taskId: string; onChanged: () => void }) {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad(() => rpc<TaskDetail>("getTask", { task_id: taskId }), [taskId], { refreshMs: 15000 });
  const [eta, setEta] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"deliver" | "cancel" | null>(null);
  const [assignVia, setAssignVia] = useState("text");
  const task = data?.task;
  const now = useNow(!!task?.timer_started_at);
  const tz = nav.agent.timezone;

  useEffect(() => {
    setEta(task?.eta ? toLocalInput(task.eta) : "");
  }, [task?.id, task?.eta]);

  if (error && !data) return <ErrorNote message={error} onRetry={() => reload()} />;
  if (loading && !data) return <Spinner />;
  if (!data || !task) return null;

  async function run(key: string, fn: string, args: Record<string, unknown>, done?: string) {
    setBusy(key);
    try {
      await rpc(fn, { task_id: taskId, ...args });
      if (done) toast(done);
      await reload(true);
      onChanged();
      nav.refreshCounts();
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  const open = ["received", "in_progress", "waiting"].includes(task.status);
  const logged = Number(task.logged_ms) + (task.timer_started_at ? Math.max(0, now - new Date(task.timer_started_at).getTime()) : 0);
  const attachments = data.files.filter((f) => f.kind !== "deliverable");
  const deliverables = data.files.filter((f) => f.kind === "deliverable");
  const etaLeft = remaining(task.eta);
  const label = "text-xs font-semibold uppercase tracking-wide text-ink-3";

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-ink-3">{taskNo(task.number)}</span>
          <Badge tone={STATUS_TONE[task.status]}>{TASK_STATUS_LABEL[task.status]}</Badge>
          {task.requested_via && task.requested_via !== "in_app" ? <Badge>Requested by {CHANNEL_LABEL[task.requested_via]?.toLowerCase()}</Badge> : null}
          {open || task.status === "suggested" ? (
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setConfirm("cancel")}>
              Cancel ticket
            </Button>
          ) : null}
        </div>
        <h2 className="mt-2 text-lg font-semibold">{task.title}</h2>
        <p className="mt-1 whitespace-pre-wrap text-sm text-ink-2">{task.description}</p>
        {task.origin_event_title ? <p className="mt-1 text-xs text-ink-3">Came out of: {task.origin_event_title}</p> : null}
      </div>

      {task.status === "suggested" ? (
        <div className="rounded-lg bg-page p-3 text-[13px] text-ink-2">
          <p>The agent has not assigned this yet. Do not start work.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span>If the agent approved it outside the app:</span>
            <Select aria-label="How the agent approved" className="!h-8 !w-auto" value={assignVia} onChange={(e) => setAssignVia(e.target.value)}>
              <option value="text">by text</option>
              <option value="email">by email</option>
              <option value="call">on a call</option>
            </Select>
            <Button size="sm" busy={busy === "assign"} onClick={() => run("assign", "assignTask", { requested_via: assignVia }, "Ticket assigned.")}>
              Assign for the agent
            </Button>
          </div>
        </div>
      ) : null}

      {open ? (
        <div className="grid gap-4 rounded-xl border border-line p-4 xl:grid-cols-[170px_minmax(0,1fr)_auto]">
          <Field label="Category">
            <Select value={task.category} onChange={(e) => run("cat", "updateTask", { category: e.target.value })}>
              {[...new Set([...TASK_CATEGORIES, task.category])].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Field label={`ETA (${tzAbbr(Intl.DateTimeFormat().resolvedOptions().timeZone)}, your time)`} hint={task.eta ? `Agent sees ${dateTime(task.eta, tz, true)}${etaLeft ? `, ${etaLeft.text.toLowerCase()}` : ""}` : "Set this first. The agent sees it right away."}>
            <div className="flex gap-2" data-tour="ticket-eta">
              <Input className="min-w-0" type="datetime-local" value={eta} min={toLocalInput(null)} onChange={(e) => setEta(e.target.value)} />
              <Button className="!h-9 shrink-0" variant={task.eta ? "outline" : "primary"} disabled={!eta || (!!task.eta && toLocalInput(task.eta) === eta)} busy={busy === "eta"} onClick={() => run("eta", "setTaskEta", { eta: new Date(eta).toISOString() }, "ETA saved.")}>
                {task.eta ? "Update" : "Set"}
              </Button>
            </div>
          </Field>
          <div>
            <span className="mb-1 block text-[13px] font-medium text-ink-2">Time logged</span>
            <div className="flex w-fit items-center gap-2" data-tour="ticket-timer">
              <span className="font-mono text-lg">{clock(logged)}</span>
              {task.timer_started_at ? (
                <Button size="sm" icon={<Pause className="h-3.5 w-3.5" />} busy={busy === "timer"} onClick={() => run("timer", "taskTimer", { action: "pause" })}>
                  Pause
                </Button>
              ) : (
                <Button size="sm" icon={<Play className="h-3.5 w-3.5" />} busy={busy === "timer"} disabled={task.status === "received"} title={task.status === "received" ? "Set an ETA first" : task.status === "waiting" ? "Starting the timer resumes this ticket" : undefined} onClick={() => run("timer", "taskTimer", { action: "start" })}>
                  Start
                </Button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-ink-2">
          <div>Category: {task.category}</div>
          {Number(task.logged_ms) > 0 ? <div>Time logged: {clock(Number(task.logged_ms))}</div> : null}
          {task.delivered_at ? <div>Delivered {dateTime(task.delivered_at, tz)}</div> : null}
        </dl>
      )}

      {data.contextEvents.length ? (
        <div>
          <h3 className={label}>Context</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {data.contextEvents.map((e) => (
              <button key={e.id} className="h-7 rounded-full border border-line px-2.5 text-xs text-accent hover:bg-accent-soft" onClick={() => nav.go("event", { id: e.id })}>
                {e.title}, {dateOnly(e.occurred_at, tz)}
              </button>
            ))}
            <button className="h-7 rounded-full border border-line px-2.5 text-xs text-accent hover:bg-accent-soft" onClick={() => nav.go("project", { id: task.project_id, tab: "profile" })}>
              Deal profile
            </button>
          </div>
        </div>
      ) : null}

      <div>
        <h3 className={label}>Files from the agent</h3>
        <div className="mt-2 space-y-2">
          {attachments.length === 0 ? <p className="text-[13px] text-ink-3">None attached.</p> : attachments.map((f) => <FileItem key={f.id} file={f} />)}
        </div>
      </div>

      <div data-tour="ticket-deliverables">
        <h3 className={label}>Deliverables</h3>
        <div className="mt-2 space-y-2">
          {deliverables.length === 0 ? <p className="text-[13px] text-ink-3">{open ? "Upload the file or paste a link to the document. The agent sees it only after you mark the ticket delivered." : "None."}</p> : null}
          {deliverables.map((f) => (
            <FileItem key={f.id} file={f} canDelete={f.status === "draft"} onDeleted={() => reload(true)} />
          ))}
          {open ? <AddFile projectId={task.project_id} taskId={task.id} kind="deliverable" allowLink label="Upload deliverable" onAdded={() => reload(true)} /> : null}
        </div>
      </div>

      {task.status === "delivered" ? (
        <div className="rounded-xl border border-line p-4">
          <h3 className={label}>Agent feedback</h3>
          {task.agent_feedback ? <p className="mt-2 text-sm font-medium">{FEEDBACK_LABEL[task.agent_feedback]}</p> : <p className="mt-2 text-[13px] text-ink-3">Not recorded yet. If the agent told you outside the app, record it here.</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {(["used_as_is", "edited", "not_used", "revision_requested"] as const).map((f) => (
              <Button key={f} size="sm" variant={task.agent_feedback === f ? "primary" : "outline"} busy={busy === f} onClick={() => run(f, "setTaskFeedback", { feedback: f }, f === "revision_requested" ? "Reopened for revision." : "Feedback recorded.")}>
                {FEEDBACK_LABEL[f]}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      <div data-tour="ticket-thread">
        <h3 className={label}>Conversation with {nav.agent.name.split(" ")[0]}</h3>
        <div className="mt-2">
          <TaskThread
            taskId={task.id}
            messages={data.messages}
            viewer="va"
            otherName={nav.agent.name.split(" ")[0]}
            canAsk={task.status === "in_progress"}
            disabled={task.status === "suggested" ? "Messaging opens once the agent assigns this task." : task.status === "cancelled" ? "This ticket was cancelled." : null}
            onSent={() => {
              reload(true);
              onChanged();
            }}
          />
        </div>
      </div>

      {open ? (
        <div className="sticky bottom-0 -mx-4 flex items-center justify-between gap-3 border-t border-line bg-white px-4 py-3">
          <span className="text-[13px] text-ink-3">{task.status === "received" ? "Set an ETA to start." : deliverables.length === 0 ? "Add a deliverable to finish." : "Ready when you are."}</span>
          <Button data-tour="ticket-deliver" variant="primary" icon={<Send className="h-4 w-4" />} disabled={task.status === "received" || deliverables.length === 0} onClick={() => setConfirm("deliver")}>
            Mark delivered
          </Button>
        </div>
      ) : null}

      {open ? <Coach name="va-ticket" steps={TOURS.vaTicket} /> : null}

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === "deliver" ? "Deliver to the agent?" : "Cancel this ticket?"}
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Go back</Button>
            {confirm === "deliver" ? (
              <Button variant="primary" busy={busy === "deliver"} onClick={() => run("deliver", "deliverTask", {}, "Delivered.")}>
                Deliver
              </Button>
            ) : (
              <Button variant="danger" busy={busy === "cancel"} onClick={() => run("cancel", "cancelTask", {}, "Ticket cancelled.")}>
                Cancel ticket
              </Button>
            )}
          </>
        }
      >
        <p className="text-sm text-ink-2">
          {confirm === "deliver"
            ? `${nav.agent.name} will see ${deliverables.length} ${deliverables.length === 1 ? "file" : "files"} and the timer stops at ${clock(logged)}. Check that nothing in the files is addressed to the client as if already sent.`
            : "The agent sees it as cancelled. Use this only if the agent no longer needs it."}
        </p>
      </Modal>
    </div>
  );
}
