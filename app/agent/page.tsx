"use client";
import { Suspense, useState, useEffect } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FolderKanban, Plus } from "lucide-react";
import { rpc } from "@/lib/client/api";
import { ago, dateTime, isPast } from "@/lib/client/format";
import type { Project, ProjectListItem } from "@/lib/types";
import { AddEventDialog } from "@/components/AddEventDialog";
import { Authed, useSession } from "@/components/Session";
import { UserMenu } from "@/components/UserMenu";
import { AgentProject } from "@/components/agent/Project";
import { TaskFormDialog } from "@/components/agent/TaskCard";
import { Coach, TOURS } from "@/components/Coach";
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Logo, Modal, Select, Spinner, useLoad, useToast } from "@/components/ui";

function NewProject({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (p: Project) => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [deal, setDeal] = useState("buyer");
  const [area, setArea] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!name.trim()) return toast("Enter the client name.", { tone: "error" });
    setBusy(true);
    try {
      const p = await rpc<Project>("createProject", { client_name: name, deal_type: deal, area });
      setName("");
      setArea("");
      onSaved(p);
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
      title="New project"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={save}>
            Create project
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
          <Field label="Area">
            <Input value={area} onChange={(e) => setArea(e.target.value)} placeholder="Irvine" />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function AgentApp() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { me } = useSession();
  const projectId = params.get("project");
  const { data, error, loading, reload } = useLoad(() => rpc<ProjectListItem[]>("listProjects"), [], { refreshMs: 30000 });
  // Coming back to the list (Back, or All Projects) shows today's counts, not the ones from before.
  useEffect(() => {
    if (!projectId) reload(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  const [create, setCreate] = useState(false);
  const [add, setAdd] = useState(false);
  const [task, setTask] = useState(false);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-white px-4">
        <Link href="/agent" aria-label="All projects">
          <Logo />
        </Link>
        <div className="flex items-center gap-3">
          <Link href="/how" className="text-[13px] font-medium text-ink-2 hover:text-ink">
            How it works
          </Link>
          <UserMenu />
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-5 pb-16">
        {projectId ? (
          <AgentProject
            projectId={projectId}
            openRequest={params.get("request")}
            onBack={() => {
              router.push("/agent");
              reload(true);
            }}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h1 className="text-xl font-semibold">All Projects</h1>
                <p className="mt-0.5 text-[13px] text-ink-3">
                  Hi {me?.profile.name.split(" ")[0]}.{" "}
                  {me?.assistant
                    ? `${me.assistant.split(" ")[0]} is your assistant, a real person who checks your client conversations and does your follow-up work.`
                    : "An assistant will be assigned to you shortly."}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setCreate(true)}>New project</Button>
                {data && data.length > 0 ? (
                  <Button data-tour="new-task" onClick={() => setTask(true)}>
                    Submit a request
                  </Button>
                ) : null}
                <Button data-tour="add-conversation" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdd(true)}>
                  Add conversation
                </Button>
              </div>
            </div>
            {error && !data ? <ErrorNote className="mt-4" message={error} onRetry={() => reload()} /> : null}
            {loading && !data ? <Spinner /> : null}
            {data && data.some((p) => p.to_confirm || p.needs_answer || p.to_review || p.suggested) ? (
              // One place that answers "what is waiting on me", across every client.
              <Card className="mt-5 p-3.5" data-tour="home-waiting">
                <div className="text-xs font-semibold uppercase tracking-wide text-ink-3">Waiting on you</div>
                <ul className="mt-1.5 divide-y divide-line">
                  {data
                    .filter((p) => p.to_confirm || p.needs_answer || p.to_review || p.suggested)
                    .map((p) => (
                      <li key={p.id}>
                        <button className="flex w-full items-center gap-3 py-2.5 text-left" onClick={() => router.push(`/agent?project=${p.id}`)}>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{p.client_name}</span>
                            <span className="block text-[13px] text-ink-2">
                              {[
                                p.to_confirm ? `${p.to_confirm === 1 ? "1 item" : `${p.to_confirm} items`} to confirm` : "",
                                p.needs_answer ? `${p.needs_answer === 1 ? "a question" : `${p.needs_answer} questions`} from ${me?.assistant?.split(" ")[0] ?? "your assistant"}` : "",
                                p.to_review ? `${p.to_review} ${p.to_review === 1 ? "delivery" : "deliveries"} to review` : "",
                                p.suggested ? `${p.suggested} suggested follow-up${p.suggested === 1 ? "" : "s"} to send or skip` : "",
                              ]
                                .filter(Boolean)
                                .join(", ")}
                            </span>
                          </span>
                          <span className="text-[13px] font-medium text-accent">Open</span>
                        </button>
                      </li>
                    ))}
                </ul>
              </Card>
            ) : null}
            {data && data.some((p) => p.with_assistant?.length) ? (
              // Everything the assistant is working on, across clients, with when to expect it.
              <Card className="mt-4 p-3.5" data-tour="home-with">
                <div className="text-xs font-semibold uppercase tracking-wide text-ink-3">With {me?.assistant?.split(" ")[0] ?? "your assistant"}</div>
                <ul className="mt-1.5 divide-y divide-line">
                  {data
                    .flatMap((p) => (p.with_assistant ?? []).map((t) => ({ ...t, project_id: p.id, client: p.client_name })))
                    .sort((a, b) => (a.eta ?? "9999").localeCompare(b.eta ?? "9999"))
                    .map((t) => (
                      <li key={t.id}>
                        <button className="flex w-full items-center gap-3 py-2.5 text-left" onClick={() => router.push(`/agent?project=${t.project_id}&request=${t.id}`)}>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{t.title}</span>
                            <span className="block truncate text-[13px] text-ink-2">
                              {t.client}, {t.eta ? (isPast(t.eta) ? `was expected ${dateTime(t.eta, me?.profile.timezone)}` : `expected ${dateTime(t.eta, me?.profile.timezone)}`) : t.sent_at ? `sent ${dateTime(t.sent_at, me?.profile.timezone)}, not started yet` : "not started yet"}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                </ul>
              </Card>
            ) : null}
            {data && data.length === 0 ? (
              <Card className="mt-5">
                <Empty
                  icon={<FolderKanban className="h-5 w-5" />}
                  title="Start with your first client"
                  body="Upload a recording, transcript, or text thread. Your assistant verifies the facts and suggests follow-up work by 9:00 AM the next business day."
                  action={
                    <Button variant="primary" onClick={() => setAdd(true)}>
                      Add conversation
                    </Button>
                  }
                />
              </Card>
            ) : null}
            <div className="mt-5 space-y-2" data-tour={data && data.length ? "project-list" : undefined}>
              {(data ?? []).map((p) => (
                <button key={p.id} onClick={() => router.push(`/agent?project=${p.id}`)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-white p-4 text-left hover:border-line-strong">
                  <span className="min-w-[55%] flex-1">
                    <span className="block truncate font-semibold">{p.client_name}</span>
                    <span className="block truncate text-xs text-ink-3">{p.last_activity ? `Last conversation ${ago(p.last_activity).toLowerCase()}` : "No conversations yet"}</span>
                  </span>
                  {p.to_confirm ? <Badge tone="warn">{p.to_confirm} to confirm</Badge> : null}
                  {p.needs_answer ? <Badge tone="warn">{p.needs_answer === 1 ? "A question for you" : `${p.needs_answer} questions for you`}</Badge> : null}
                  {p.to_review ? <Badge tone="ok">{p.to_review} ready to review</Badge> : null}
                  {p.suggested ? <Badge tone="accent">{p.suggested} {p.suggested === 1 ? "suggestion" : "suggestions"}</Badge> : null}
                  {p.failed_events ? <Badge tone="bad">Could not read {p.failed_events === 1 ? "an upload" : `${p.failed_events} uploads`}</Badge> : null}
                  {p.pending_events ? <Badge tone={isPast(p.verify_due) ? "warn" : "neutral"}>{isPast(p.verify_due) ? "Being verified, running late" : `Being verified${p.verify_due ? `, ready by ${dateTime(p.verify_due, me?.profile.timezone)}` : ""}`}</Badge> : null}
                  {p.in_progress ? <Badge>{p.in_progress} with {me?.assistant?.split(" ")[0] ?? "your assistant"}</Badge> : null}
                </button>
              ))}
            </div>
            <Coach name="agent-home" steps={TOURS.agentHome} ready={!!data} primary />
          </>
        )}
      </main>
      <TaskFormDialog
        open={task}
        onClose={() => setTask(false)}
        projectId=""
        projects={data ?? []}
        onSaved={(t) => {
          reload(true);
          toast("Sent to your assistant. You will see a delivery time once they start.");
          router.push(`/agent?project=${t.project_id}&request=${t.id}`);
        }}
      />
      <NewProject
        open={create}
        onClose={() => setCreate(false)}
        onSaved={(p) => {
          reload(true);
          router.push(`/agent?project=${p.id}`);
        }}
      />
      <AddEventDialog
        heading="Add conversation"
        open={add}
        onClose={() => setAdd(false)}
        projects={data ?? []}
        onProjectCreated={() => reload(true)}
        onFilesAdded={(pid, n) => {
          reload(true);
          toast(n === 1 ? "File added to the project. Your assistant can see it." : `${n} files added to the project. Your assistant can see them.`);
          router.push(`/agent?project=${pid}`);
        }}
        onCreated={(e) => {
          reload(true);
          toast(e.status === "failed" ? `We could not process it: ${e.error}` : "Received. It shows on the Timeline as being verified, with facts by 9:00 AM the next business day.", e.status === "failed" ? { tone: "error" } : undefined);
          router.push(`/agent?project=${e.project_id}`);
        }}
      />
    </div>
  );
}

export default function AgentPage() {
  return (
    <Authed roles={["agent"]}>
      <Suspense fallback={<Spinner />}>
        <AgentApp />
      </Suspense>
    </Authed>
  );
}
