"use client";
import { useEffect, useState } from "react";
import { rpc } from "@/lib/client/api";
import { FEEDBACK_LABEL, dateTime, remaining, taskNo } from "@/lib/client/format";
import { TASK_CATEGORIES, type Task, type TaskDetail } from "@/lib/types";
import { AddFile, FileItem } from "../FileList";
import { TaskThread } from "../TaskThread";
import { Badge, Button, ErrorNote, Field, Input, Modal, Select, Spinner, Textarea, useLoad, useToast, type Tone } from "../ui";

export const AGENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  suggested: { label: "Suggested", tone: "neutral" },
  received: { label: "Sent to assistant", tone: "accent" },
  in_progress: { label: "In progress", tone: "dark" },
  waiting: { label: "Needs your answer", tone: "warn" },
  delivered: { label: "Delivered", tone: "ok" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export function TaskFormDialog({ open, onClose, projectId, task, onSaved, projects }: { open: boolean; onClose: () => void; projectId: string; task?: Task | null; onSaved: (task: Task) => void; projects?: { id: string; client_name: string }[] }) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("Research");
  const [busy, setBusy] = useState(false);
  const [pid, setPid] = useState(projectId);
  useEffect(() => {
    if (!open) return;
    setPid(projectId || (projects?.length === 1 ? projects[0].id : ""));
    setTitle(task?.title ?? "");
    setDescription(task?.description ?? "");
    setCategory(task?.category ?? "Research");
  }, [open, task]);
  async function save() {
    if (!task && !pid) return toast("Choose which client this is for.", { tone: "error" });
    if (!title.trim() || !description.trim()) return toast("Say what you need and add a few details.", { tone: "error" });
    setBusy(true);
    try {
      const saved = task ? await rpc<Task>("updateTask", { task_id: task.id, title, description, category }) : await rpc<Task>("createTask", { project_id: pid, title, description, category });
      onSaved(saved);
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
      title={task ? "Edit request" : "Submit a request"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={save}>
            {task ? "Save" : "Submit request"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {projects && !task ? (
          <Field label="Client">
            <Select value={pid} onChange={(e) => setPid(e.target.value)}>
              <option value="" disabled>
                Choose a project
              </option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.client_name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label="What do you need?">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} placeholder="Draft a follow-up email after Saturday's showing" />
        </Field>
        <Field label="Details" hint="Your assistant researches and drafts. You review and send. They never contact your clients.">
          <Textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it should cover, tone, anything to avoid" />
        </Field>
        <Field label="Type">
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            {[...new Set([...TASK_CATEGORIES, category])].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

export function TaskCard({ taskId, vaName, tz, preview, onClose, onChanged }: { taskId: string | null; vaName: string; tz: string; preview?: boolean; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad(() => (taskId ? rpc<TaskDetail>("getTask", { task_id: taskId }) : Promise.resolve(null)), [taskId], { refreshMs: taskId ? 15000 : undefined });
  const [edit, setEdit] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [revision, setRevision] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const task = data?.task;

  async function run(key: string, fn: string, args: Record<string, unknown>, done?: string) {
    setBusy(key);
    try {
      await rpc(fn, { task_id: taskId, ...args });
      if (done) toast(done);
      await reload(true);
      onChanged();
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    } finally {
      setBusy(null);
      setConfirmCancel(false);
      setRevision(null);
    }
  }

  const status = task ? AGENT_STATUS[task.status] ?? AGENT_STATUS.suggested : null;
  const files = (data?.files ?? []).filter((f) => !(preview && f.kind === "deliverable" && f.status === "draft"));
  const deliverables = files.filter((f) => f.kind === "deliverable");
  const attachments = files.filter((f) => f.kind !== "deliverable");
  const canEdit = !preview && task && ["suggested", "received"].includes(task.status);
  const canCancel = !preview && task && ["received", "in_progress", "waiting"].includes(task.status);
  const left = remaining(task?.eta);
  const label = "text-xs font-semibold uppercase tracking-wide text-ink-3";

  return (
    <Modal open={!!taskId} onClose={onClose} title={task ? `Request ${taskNo(task.number)}` : "Request"} wide>
      {error && !data ? <ErrorNote message={error} onRetry={() => reload()} /> : null}
      {loading && !data ? <Spinner /> : null}
      {task && status ? (
        <div className="space-y-5">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={status.tone}>{status.label}</Badge>
              {task.status === "delivered" ? (
                <span className="text-[13px] text-ink-3">Delivered {dateTime(task.delivered_at, tz)}</span>
              ) : task.eta && task.status !== "cancelled" ? (
                <span className="text-[13px] text-ink-2">
                  Expected {dateTime(task.eta, tz, true)}
                  {left ? `, ${left.text.toLowerCase()}` : ""}
                </span>
              ) : task.status === "received" ? (
                <span className="text-[13px] text-ink-3">{vaName} will set a delivery time shortly.</span>
              ) : null}
            </div>
            <h3 className="mt-2 text-lg font-semibold">{task.title}</h3>
            <p className="mt-1 whitespace-pre-wrap text-sm text-ink-2">{task.description}</p>
            {canEdit || canCancel ? (
              <div className="mt-3 flex gap-2">
                {canEdit ? (
                  <Button size="sm" onClick={() => setEdit(true)}>
                    Edit request
                  </Button>
                ) : null}
                {canCancel ? (
                  <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(true)}>
                    Cancel request
                  </Button>
                ) : null}
              </div>
            ) : null}
            {!preview && task.status === "in_progress" ? <p className="mt-2 text-xs text-ink-3">Work has started. To change it, send a message below.</p> : null}
          </div>

          {task.status === "suggested" && !preview ? (
            <div className="flex flex-wrap gap-2 rounded-lg bg-page p-3">
              <Button variant="primary" busy={busy === "assign"} onClick={() => run("assign", "assignTask", {}, `Sent to ${vaName}.`)}>
                Send to {vaName}
              </Button>
              <Button
                busy={busy === "dismiss"}
                onClick={async () => {
                  await run("dismiss", "dismissTask", {});
                  onClose();
                }}
              >
                Dismiss
              </Button>
            </div>
          ) : null}

          {deliverables.length ? (
            <div>
              <h4 className={label}>Delivered by {vaName}</h4>
              <div className="mt-2 space-y-2">
                {deliverables.map((f) => (
                  <FileItem key={f.id} file={f} />
                ))}
              </div>
              {task.status === "delivered" && !preview ? (
                <div className="mt-3 rounded-lg bg-page p-3">
                  <p className="text-[13px] font-medium">{task.agent_feedback ? `You said: ${FEEDBACK_LABEL[task.agent_feedback]}` : "How did it go? Review it before anything goes to your client."}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(["used_as_is", "edited", "not_used"] as const).map((f) => (
                      <Button key={f} size="sm" variant={task.agent_feedback === f ? "primary" : "outline"} busy={busy === f} onClick={() => run(f, "setTaskFeedback", { feedback: f }, "Thanks, noted.")}>
                        {f === "edited" ? "Edited it" : FEEDBACK_LABEL[f]}
                      </Button>
                    ))}
                    <Button size="sm" onClick={() => setRevision("")}>
                      Ask for changes
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          <div>
            <h4 className={label}>Your attachments</h4>
            <div className="mt-2 space-y-2">
              {attachments.length === 0 ? <p className="text-[13px] text-ink-3">Nothing attached.</p> : attachments.map((f) => <FileItem key={f.id} file={f} canDelete={!preview && f.uploaded_role === "agent"} onDeleted={() => reload(true)} />)}
              {!preview && !["cancelled", "delivered", "dismissed"].includes(task.status) ? <AddFile projectId={task.project_id} taskId={task.id} kind="attachment" allowLink label="Attach file" onAdded={() => reload(true)} /> : null}
            </div>
          </div>

          <div>
            <h4 className={label}>Messages with {vaName}</h4>
            <div className="mt-2">
              <TaskThread
                taskId={task.id}
                messages={data!.messages}
                viewer={preview ? "va" : "agent"}
                otherName={preview ? "User" : vaName}
                disabled={preview ? "Preview only. Messages are sent from the ticket." : task.status === "suggested" ? "Send this request to start a conversation." : task.status === "cancelled" ? "This request was cancelled." : null}
                onSent={() => {
                  reload(true);
                  onChanged();
                }}
              />
            </div>
          </div>
        </div>
      ) : null}

      <TaskFormDialog
        open={edit}
        onClose={() => setEdit(false)}
        projectId={task?.project_id ?? ""}
        task={task}
        onSaved={() => {
          reload(true);
          onChanged();
        }}
      />
      <Modal
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="Cancel this request?"
        footer={
          <>
            <Button onClick={() => setConfirmCancel(false)}>Keep it</Button>
            <Button variant="danger" busy={busy === "cancel"} onClick={() => run("cancel", "cancelTask", {}, "Request cancelled.")}>
              Cancel request
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">{vaName} stops working on it. Time already spent still counts.</p>
      </Modal>
      <Modal
        open={revision !== null}
        onClose={() => setRevision(null)}
        title="Ask for changes"
        footer={
          <>
            <Button onClick={() => setRevision(null)}>Cancel</Button>
            <Button variant="primary" busy={busy === "rev"} disabled={!revision?.trim()} onClick={() => run("rev", "setTaskFeedback", { feedback: "revision_requested", note: revision }, `Sent back to ${vaName}.`)}>
              Send back
            </Button>
          </>
        }
      >
        <Field label="What should change?">
          <Textarea rows={4} value={revision ?? ""} onChange={(e) => setRevision(e.target.value)} placeholder="Shorter, and lead with the price drop" />
        </Field>
      </Modal>
    </Modal>
  );
}
