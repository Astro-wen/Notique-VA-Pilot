"use client";
import { useEffect, useState } from "react";
import { ArrowLeft, ClipboardCopy, Eye, FolderKanban, Link2, Pencil, Plus } from "lucide-react";
import { rpc } from "@/lib/client/api";
import { FEEDBACK_LABEL, SOURCE_LABEL, TASK_STATUS_LABEL, ago, dateOnly, dateTime, minutes, taskNo, projectLine } from "@/lib/client/format";
import type { Fact, Project, ProjectDetail, ProjectListItem, ShareLink, Task, TaskStatus } from "@/lib/types";
import { AddEventDialog } from "../AddEventDialog";
import { DealFacts, FactRow, profileNote } from "../DealFacts";
import { AddFile, FileItem } from "../FileList";
import { Badge, Button, Card, Empty, ErrorNote, Field, IconButton, Input, Modal, Select, Spinner, Tabs, cx, useLoad, useToast } from "../ui";
import type { VaNav } from "./Console";
import { NewTicketDialog, STATUS_TONE, Ticket } from "./Ticket";

function ProjectDialog({ open, onClose, agentId, project, onSaved }: { open: boolean; onClose: () => void; agentId: string; project?: Project; onSaved: (p: Project) => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [deal, setDeal] = useState("buyer");
  const [area, setArea] = useState("");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(project?.client_name ?? "");
    setDeal(project?.deal_type ?? "buyer");
    setArea(project?.area ?? "");
    setBudget(project?.budget ?? "");
  }, [open, project]);
  async function save() {
    if (!name.trim()) return toast("Enter the client name.", { tone: "error" });
    setBusy(true);
    try {
      const args = { client_name: name, deal_type: deal, area, budget };
      const saved = project ? await rpc<Project>("updateProject", { project_id: project.id, ...args }) : await rpc<Project>("createProject", { agent_id: agentId, ...args });
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
      title={project ? "Edit project" : "New project"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={save}>
            {project ? "Save" : "Create project"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Client name" hint="One project per client or household.">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Michael and Jenny Chen" maxLength={80} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Deal type">
            <Select value={deal} onChange={(e) => setDeal(e.target.value)}>
              <option value="buyer">Buyer</option>
              <option value="seller">Seller</option>
              <option value="other">Other</option>
            </Select>
          </Field>
          <Field label="Budget or price">
            <Input value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="$850K to $950K" />
          </Field>
        </div>
        <Field label="Area">
          <Input value={area} onChange={(e) => setArea(e.target.value)} placeholder="Irvine, Tustin" />
        </Field>
      </div>
    </Modal>
  );
}

export function ProjectList({ nav }: { nav: VaNav }) {
  const { data, error, loading, reload } = useLoad(() => rpc<ProjectListItem[]>("listProjects", { agent_id: nav.agent.id }), [nav.agent.id]);
  const [create, setCreate] = useState(false);
  if (error && !data) return <ErrorNote message={error} onRetry={() => reload()} />;
  if (loading && !data) return <Spinner />;
  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Projects</h1>
          <p className="mt-0.5 text-[13px] text-ink-3">{nav.agent.name}&apos;s clients. One project per client.</p>
        </div>
        <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreate(true)}>
          New project
        </Button>
      </div>
      {data && data.length === 0 ? (
        <Card className="mt-5">
          <Empty icon={<FolderKanban className="h-5 w-5" />} title="No projects yet" body="Create a project for each client, then add their conversations to it." action={<Button onClick={() => setCreate(true)}>New project</Button>} />
        </Card>
      ) : (
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(data ?? []).map((p) => (
            <button key={p.id} onClick={() => nav.go("project", { id: p.id })} className="rounded-xl border border-line bg-white p-4 text-left hover:border-line-strong">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-semibold">{p.client_name}</div>
                  <div className="truncate text-xs text-ink-3">{projectLine(p)}</div>
                </div>
                {p.pending_events ? <Badge tone="warn">{p.pending_events} to verify</Badge> : null}
              </div>
              <div className="mt-4 flex gap-4 text-[13px] text-ink-2">
                <span>{p.event_count} verified</span>
                <span>{p.open_tasks} open {p.open_tasks === 1 ? "task" : "tasks"}</span>
              </div>
              <div className="mt-1 text-xs text-ink-3">{p.last_activity ? `Last conversation ${ago(p.last_activity).toLowerCase()}` : "No conversations yet"}</div>
            </button>
          ))}
        </div>
      )}
      <ProjectDialog open={create} onClose={() => setCreate(false)} agentId={nav.agent.id} onSaved={(p) => nav.go("project", { id: p.id })} />
    </div>
  );
}

function ShareDialog({ open, onClose, projectId, link, onChanged }: { open: boolean; onClose: () => void; projectId: string; link: ShareLink | null; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const url = link && typeof window !== "undefined" ? `${window.location.origin}/p?t=${link.token}` : "";
  async function run(fn: string, done: string) {
    setBusy(true);
    try {
      await rpc(fn, { project_id: projectId });
      toast(done);
      onChanged();
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Read-only link">
      <p className="text-sm text-ink-2">Anyone with this link can read the verified deal profile without signing in. Tasks, files, and messages are not included. Share it with the user only.</p>
      {link ? (
        <div className="mt-4 space-y-3">
          <div className="flex gap-2">
            <Input readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Share link" />
            <Button
              variant="primary"
              className="!h-9"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(url);
                  toast("Link copied.");
                } catch {
                  toast("Copy failed. Select the link and copy it by hand.", { tone: "error" });
                }
              }}
            >
              Copy
            </Button>
          </div>
          <div className="flex items-center justify-between text-[13px] text-ink-3">
            <span>Expires {dateTime(link.expires_at)}</span>
            <Button size="sm" variant="danger" busy={busy} onClick={() => run("revokeShareLink", "Link turned off.")}>
              Turn off link
            </Button>
          </div>
        </div>
      ) : (
        <Button className="mt-4" variant="primary" busy={busy} onClick={() => run("createShareLink", "Link created. It works for 14 days.")}>
          Create link
        </Button>
      )}
    </Modal>
  );
}

const GROUPS: { key: TaskStatus; label: string }[] = [
  { key: "received", label: "Received" },
  { key: "in_progress", label: "In progress" },
  { key: "waiting", label: "Waiting on user" },
  { key: "suggested", label: "Suggested, not assigned yet" },
  { key: "delivered", label: "Delivered" },
  { key: "cancelled", label: "Cancelled" },
];

export function TicketRow({ task, active, onClick, tz, showProject }: { task: Task; active?: boolean; onClick: () => void; tz: string; showProject?: boolean }) {
  return (
    <button onClick={onClick} className={cx("flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left", active ? "border-accent bg-accent-soft" : "border-line bg-white hover:border-line-strong")}>
      <span className="mt-0.5 w-12 shrink-0 font-mono text-xs text-ink-3">{taskNo(task.number)}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{task.title}</span>
        <span className="block truncate text-xs text-ink-3">
          {showProject ? `${task.project_name}, ` : ""}
          {task.status === "delivered" ? `Delivered ${dateTime(task.delivered_at, tz)}` : task.eta ? `ETA ${dateTime(task.eta, tz)}` : task.status === "suggested" ? "Waiting for the user" : task.status === "cancelled" ? "Cancelled" : "ETA not set"}
        </span>
      </span>
      {showProject ? <Badge tone={STATUS_TONE[task.status]}>{TASK_STATUS_LABEL[task.status]}</Badge> : null}
    </button>
  );
}

export function ProjectView({ nav, projectId, tab, taskId }: { nav: VaNav; projectId: string; tab: string; taskId: string | null }) {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad(() => rpc<ProjectDetail>("getProject", { project_id: projectId }), [projectId], { refreshMs: 30000 });
  const [dialog, setDialog] = useState<"edit" | "share" | "add" | "ticket" | null>(null);
  const working = (data?.events ?? []).some((e) => e.status === "processing" || e.status === "extracting");
  useEffect(() => {
    if (!working) return;
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      rpc<{ changed: boolean }>("pollProject", { project_id: projectId })
        .then((r) => {
          if (r.changed) {
            reload(true);
            nav.refreshCounts();
          }
        })
        .catch(() => {});
    }, 8000);
    return () => window.clearInterval(id);
  }, [working, projectId, reload, nav.refreshCounts]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error && !data) return <ErrorNote message={error} onRetry={() => reload()} />;
  if (loading && !data) return <Spinner />;
  if (!data) return null;
  const { project } = data;
  const tz = data.agent.timezone;
  const setTab = (key: string, extra?: Record<string, string | undefined>) => nav.go("project", { id: projectId, tab: key, ...extra });
  const current = ["tickets", "profile", "documents", "completed"].includes(tab) ? tab : "tickets";
  const openTasks = data.tasks.filter((t) => ["received", "in_progress", "waiting"].includes(t.status));
  const delivered = data.tasks.filter((t) => t.status === "delivered");
  const selected = taskId ? data.tasks.find((t) => t.id === taskId) ?? null : null;
  const documents = data.files.filter((f) => f.kind === "project" || f.kind === "attachment");

  async function copyNote() {
    try {
      await navigator.clipboard.writeText(profileNote(project.client_name, data!.facts, data!.lastVerified, tz));
      toast("Profile note copied. Paste it into the client's CRM record.");
    } catch {
      toast("Copy failed. Your browser blocked clipboard access.", { tone: "error" });
    }
  }

  async function resolve(fact: Fact) {
    try {
      await rpc("resolveFact", { fact_id: fact.id });
      reload(true);
      toast("Marked resolved.", {
        action: {
          label: "Undo",
          run: async () => {
            await rpc("resolveFact", { fact_id: fact.id, undo: true }).catch(() => {});
            reload(true);
          },
        },
      });
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-start gap-3">
        <IconButton label="All projects" onClick={() => nav.go("projects")}>
          <ArrowLeft className="h-4 w-4" />
        </IconButton>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-xl font-semibold">{project.client_name}</h1>
            <IconButton label="Edit project" onClick={() => setDialog("edit")}>
              <Pencil className="h-3.5 w-3.5" />
            </IconButton>
          </div>
          <p className="text-[13px] text-ink-3">{projectLine(project)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon={<Eye className="h-3.5 w-3.5" />} onClick={() => nav.go("preview", { id: projectId })}>
            User view
          </Button>
          <Button size="sm" icon={<Link2 className="h-3.5 w-3.5" />} onClick={() => setDialog("share")}>
            {data.shareLink ? "Link is on" : "Share link"}
          </Button>
          <Button size="sm" icon={<ClipboardCopy className="h-3.5 w-3.5" />} onClick={copyNote} disabled={data.facts.length === 0}>
            Copy profile note
          </Button>
          <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setDialog("add")}>
            Add conversation
          </Button>
        </div>
      </div>

      <Tabs
        className="mt-4"
        value={current}
        onChange={(key) => setTab(key)}
        tabs={[
          { key: "tickets", label: "Tickets", count: openTasks.length },
          { key: "profile", label: "Deal profile", count: data.needsInput.length },
          { key: "documents", label: "Documents", count: documents.length },
          { key: "completed", label: "Completed", count: delivered.length },
        ]}
      />

      {current === "tickets" ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          <div className={cx("space-y-4", selected && "hidden lg:block")}>
            <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setDialog("ticket")}>
              New ticket for the user
            </Button>
            {data.tasks.length === 0 ? (
              <Card>
                <Empty title="No tickets yet" body="Tickets appear when the user assigns a suggested task or writes a new one. If the user asks by text or email, create the ticket here." />
              </Card>
            ) : null}
            {GROUPS.map((g) => {
              const rows = data.tasks.filter((t) => t.status === g.key);
              if (rows.length === 0) return null;
              return (
                <div key={g.key}>
                  <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-3">
                    {g.label} ({rows.length})
                  </h3>
                  <div className="space-y-1.5">
                    {rows.map((t) => (
                      <TicketRow key={t.id} task={t} tz={tz} active={t.id === taskId} onClick={() => setTab("tickets", { task: t.id })} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className={cx(!selected && "hidden lg:block")}>
            {selected ? (
              <Card className="px-4 pt-4">
                <button className="mb-3 text-[13px] text-accent lg:hidden" onClick={() => setTab("tickets")}>
                  Back to all tickets
                </button>
                <Ticket nav={nav} taskId={selected.id} onChanged={() => reload(true)} />
                <div className="h-4" />
              </Card>
            ) : (
              <Card>
                <Empty title={taskId ? "This ticket no longer exists" : "Select a ticket"} body="Pick a ticket on the left to see the request, set an ETA, and deliver." />
              </Card>
            )}
          </div>
        </div>
      ) : null}

      {current === "profile" ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-4">
            {data.lastVerified ? <p className="text-[13px] text-ink-3">Last verified {dateTime(data.lastVerified.at, tz)} by {data.lastVerified.by}. This is what the user sees.</p> : null}
            {data.needsInput.length ? (
              <section className="rounded-xl border border-[#edd9a8] bg-warn-soft px-4 pt-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-warn">Needs user input ({data.needsInput.length})</h3>
                <p className="mt-1 text-[13px] text-ink-2">The transcript did not settle these, so the user cannot see them. Ask the user, then mark each one resolved, or add the confirmed fact from the next conversation.</p>
                <div className="divide-y divide-[#edd9a8]">
                  {data.needsInput.map((f) => (
                    <FactRow
                      key={f.id}
                      fact={f}
                      tz={tz}
                      action={
                        <Button size="sm" onClick={() => resolve(f)}>
                          Mark resolved
                        </Button>
                      }
                    />
                  ))}
                </div>
              </section>
            ) : null}
            {data.facts.length === 0 ? (
              <Card>
                <Empty title="No verified facts yet" body={data.pendingEvents ? "A conversation is waiting in the queue. Verify it and the facts land here." : "Add a conversation to this project to get started."} action={data.pendingEvents ? <Button onClick={() => nav.go("queue")}>Open queue</Button> : <Button onClick={() => setDialog("add")}>Add conversation</Button>} />
              </Card>
            ) : (
              <DealFacts facts={data.facts} tz={tz} onResolve={resolve} />
            )}
          </div>
          <Card className="self-start">
            <h3 className="border-b border-line px-4 py-3 text-[15px] font-semibold">Conversations</h3>
            {data.events.length === 0 ? <p className="px-4 py-4 text-[13px] text-ink-3">None yet.</p> : null}
            <ul className="divide-y divide-line">
              {data.events.map((e) => (
                <li key={e.id}>
                  <button className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-[#fafafa]" onClick={() => (["processing", "extracting", "failed"].includes(e.status) ? nav.go("queue") : nav.go("event", { id: e.id }))}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{e.title}</span>
                      <span className="block truncate text-xs text-ink-3">
                        {SOURCE_LABEL[e.source]}, {dateOnly(e.occurred_at, tz)}
                      </span>
                    </span>
                    <Badge tone={e.status === "submitted" ? "ok" : e.status === "failed" ? "bad" : e.status === "escalated" ? "warn" : "accent"}>
                      {e.status === "submitted" ? "Verified" : e.status === "failed" ? "Failed" : e.status === "escalated" ? "Escalated" : e.status === "ready" || e.status === "in_review" ? "To verify" : "Preparing"}
                    </Badge>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      ) : null}

      {current === "documents" ? (
        <Card className="mt-4 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px] text-ink-3">Files the user or you added for this client, such as disclosures or a buyer questionnaire.</p>
            <AddFile projectId={projectId} kind="project" allowLink onAdded={() => reload(true)} />
          </div>
          <div className="mt-3 space-y-2">
            {documents.length === 0 ? <Empty title="No documents yet" body="Upload a file or add a link." /> : documents.map((f) => <FileItem key={f.id} file={f} canDelete onDeleted={() => reload(true)} />)}
          </div>
        </Card>
      ) : null}

      {current === "completed" ? (
        <div className="mt-4 space-y-3">
          {delivered.length === 0 ? (
            <Card>
              <Empty title="Nothing delivered yet" body="Delivered tickets and their files are listed here with the user's feedback." />
            </Card>
          ) : null}
          {delivered.map((t) => (
            <Card key={t.id} className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-ink-3">{taskNo(t.number)}</span>
                <button className="font-medium hover:text-accent" onClick={() => setTab("tickets", { task: t.id })}>
                  {t.title}
                </button>
                <Badge tone={t.agent_feedback === "used_as_is" ? "ok" : t.agent_feedback === "not_used" ? "bad" : t.agent_feedback ? "accent" : "neutral"}>{t.agent_feedback ? FEEDBACK_LABEL[t.agent_feedback] : "No feedback yet"}</Badge>
              </div>
              <p className="mt-1 text-xs text-ink-3">
                Delivered {dateTime(t.delivered_at, tz)}, {minutes(Number(t.logged_ms))} logged
              </p>
              <div className="mt-2 space-y-2">
                {data.files
                  .filter((f) => f.task_id === t.id && f.kind === "deliverable")
                  .map((f) => (
                    <FileItem key={f.id} file={f} />
                  ))}
              </div>
            </Card>
          ))}
        </div>
      ) : null}

      <ProjectDialog open={dialog === "edit"} onClose={() => setDialog(null)} agentId={nav.agent.id} project={project} onSaved={() => reload(true)} />
      <ShareDialog open={dialog === "share"} onClose={() => setDialog(null)} projectId={projectId} link={data.shareLink} onChanged={() => reload(true)} />
      <NewTicketDialog
        open={dialog === "ticket"}
        onClose={() => setDialog(null)}
        projectId={projectId}
        onCreated={(t) => {
          reload(true);
          nav.refreshCounts();
          setTab("tickets", { task: t.id });
        }}
      />
      <AddEventDialog
        open={dialog === "add"}
        onClose={() => setDialog(null)}
        projects={[project]}
        agentId={nav.agent.id}
        defaultProjectId={projectId}
        onCreated={(e) => {
          reload(true);
          nav.refreshCounts();
          toast(e.status === "failed" ? `Could not process it: ${e.error}` : "Added. It will show in the queue when it is ready.", e.status === "failed" ? { tone: "error" } : undefined);
        }}
      />
    </div>
  );
}
