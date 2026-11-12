"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FolderKanban, Plus } from "lucide-react";
import { rpc } from "@/lib/client/api";
import { ago } from "@/lib/client/format";
import type { Project, ProjectListItem } from "@/lib/types";
import { AddEventDialog } from "@/components/AddEventDialog";
import { Authed, useSession } from "@/components/Session";
import { UserMenu } from "@/components/UserMenu";
import { AgentProject } from "@/components/agent/Project";
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
  const { data, error, loading, reload } = useLoad(() => rpc<ProjectListItem[]>("listProjects"), []);
  const [create, setCreate] = useState(false);
  const [add, setAdd] = useState(false);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-white px-4">
        <Link href="/agent" aria-label="All projects">
          <Logo />
        </Link>
        <UserMenu />
      </header>
      <main className="mx-auto max-w-2xl px-4 py-5 pb-16">
        {projectId ? (
          <AgentProject
            projectId={projectId}
            onBack={() => {
              router.push("/agent");
              reload(true);
            }}
          />
        ) : (
          <>
            <div className="flex items-end justify-between gap-3">
              <div>
                <h1 className="text-xl font-semibold">All Projects</h1>
                <p className="mt-0.5 text-[13px] text-ink-3">Hi {me?.profile.name.split(" ")[0]}. One project per client.</p>
              </div>
              <div className="flex gap-2">
                <Button onClick={() => setCreate(true)}>New project</Button>
                <Button data-tour="add-conversation" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdd(true)}>
                  Add conversation
                </Button>
              </div>
            </div>
            {error && !data ? <ErrorNote className="mt-4" message={error} onRetry={() => reload()} /> : null}
            {loading && !data ? <Spinner /> : null}
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
                <button key={p.id} onClick={() => router.push(`/agent?project=${p.id}`)} className="flex w-full items-center gap-3 rounded-xl border border-line bg-white p-4 text-left hover:border-line-strong">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{p.client_name}</span>
                    <span className="block truncate text-xs text-ink-3">{p.last_activity ? `Last conversation ${ago(p.last_activity).toLowerCase()}` : "No conversations yet"}</span>
                  </span>
                  {p.pending_events ? <Badge tone="accent">Being verified</Badge> : null}
                  {p.open_tasks ? (
                    <Badge>
                      {p.open_tasks} {p.open_tasks === 1 ? "task" : "tasks"}
                    </Badge>
                  ) : null}
                </button>
              ))}
            </div>
            <Coach name="agent-home" steps={TOURS.agentHome} ready={!!data} primary />
          </>
        )}
      </main>
      <NewProject
        open={create}
        onClose={() => setCreate(false)}
        onSaved={(p) => {
          reload(true);
          router.push(`/agent?project=${p.id}`);
        }}
      />
      <AddEventDialog
        open={add}
        onClose={() => setAdd(false)}
        projects={data ?? []}
        onProjectCreated={() => reload(true)}
        onCreated={(e) => {
          reload(true);
          toast(e.status === "failed" ? `We could not process it: ${e.error}` : "Received. Your assistant will verify it.", e.status === "failed" ? { tone: "error" } : undefined);
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
