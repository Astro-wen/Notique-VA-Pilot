"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { BarChart3, ClipboardList, DatabaseZap, FolderKanban, Inbox, Settings2 } from "lucide-react";
import { rpc } from "@/lib/client/api";
import { tzAbbr } from "@/lib/client/format";
import type { AgentSummary } from "@/lib/types";
import { useSession } from "../Session";
import { UserMenu } from "../UserMenu";
import { Card, Empty, Logo, Select, cx } from "../ui";
import { Queue, Sources } from "./Queue";
import { Verify } from "./Verify";
import { ProjectList, ProjectView } from "./Projects";
import { TasksView } from "./Tasks";
import { Qc } from "./Qc";
import { AgentPreview } from "./AgentPreview";

export type VaView = "queue" | "event" | "projects" | "project" | "tasks" | "sources" | "qc" | "preview";

export interface VaNav {
  agent: AgentSummary;
  go: (view: VaView, params?: Record<string, string | undefined>) => void;
  refreshCounts: () => void;
}

const NAV: { key: VaView; label: string; icon: React.ReactNode; also?: VaView[] }[] = [
  { key: "queue", label: "Queue", icon: <Inbox className="h-4 w-4" />, also: ["event"] },
  { key: "projects", label: "Projects", icon: <FolderKanban className="h-4 w-4" />, also: ["project", "preview"] },
  { key: "tasks", label: "Tasks", icon: <ClipboardList className="h-4 w-4" /> },
  { key: "sources", label: "Data sources", icon: <DatabaseZap className="h-4 w-4" /> },
  { key: "qc", label: "QC review", icon: <BarChart3 className="h-4 w-4" /> },
];

const STORE_KEY = "notique.va.agent";

export function Console() {
  const { me, refresh } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const agents = useMemo(() => me?.agents ?? [], [me]);
  const view = (params.get("view") as VaView) || "queue";
  const [agentId, setAgentId] = useState<string | null>(null);
  const [counts, setCounts] = useState<{ queue: number; tasks: number } | null>(null);

  useEffect(() => {
    if (agents.length === 0) return;
    const fromUrl = params.get("agent");
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORE_KEY);
    } catch {
      stored = null;
    }
    const pick = [fromUrl, agentId, stored].find((id) => id && agents.some((a) => a.id === id)) ?? agents[0].id;
    if (pick !== agentId) setAgentId(pick);
  }, [agents, params, agentId]);

  const agent = agents.find((a) => a.id === agentId) ?? null;

  const refreshCounts = useCallback(() => {
    if (!agentId) return;
    rpc<{ queue: number; tasks: number }>("vaCounts", { agent_id: agentId })
      .then(setCounts)
      .catch(() => {});
  }, [agentId]);

  useEffect(() => {
    setCounts(null);
    refreshCounts();
    const id = window.setInterval(() => document.visibilityState === "visible" && refreshCounts(), 30000);
    return () => window.clearInterval(id);
  }, [refreshCounts]);

  const go = useCallback(
    (next: VaView, extra?: Record<string, string | undefined>) => {
      const qs = new URLSearchParams();
      qs.set("view", next);
      for (const [k, v] of Object.entries(extra ?? {})) if (v) qs.set(k, v);
      router.push(`/va?${qs.toString()}`);
    },
    [router],
  );

  function chooseAgent(id: string) {
    setAgentId(id);
    try {
      window.localStorage.setItem(STORE_KEY, id);
    } catch {
      /* Private mode. The choice lasts for this visit only. */
    }
    refresh();
    go(["event", "project", "preview"].includes(view) ? "queue" : view);
  }

  const nav: VaNav | null = agent ? { agent, go, refreshCounts } : null;
  const focus = view === "event";

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-white px-4">
        <Link href="/va" aria-label="Queue">
          <Logo />
        </Link>
        <span className="hidden rounded-md bg-page px-2 py-0.5 text-xs font-medium text-ink-2 sm:inline">VA Console</span>
        <div className="ml-auto flex items-center gap-3">
          {agents.length > 0 && agent ? (
            <label data-tour="agent-select" className="flex items-center gap-2 text-[13px] text-ink-3">
              <span className="hidden sm:inline">Serving</span>
              <Select aria-label="Serving agent" className="!h-8 !w-auto max-w-56 font-medium text-ink" value={agent.id} onChange={(e) => chooseAgent(e.target.value)}>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.pending_events ? ` (${a.pending_events} to verify)` : ""}
                  </option>
                ))}
              </Select>
              <span className="hidden text-xs md:inline">{tzAbbr(agent.timezone)}</span>
            </label>
          ) : null}
          <UserMenu />
        </div>
      </header>

      <div className="flex flex-1">
        {!focus ? (
          <nav aria-label="Sections" className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-52 shrink-0 flex-col gap-1 border-r border-line bg-white p-3 md:flex">
            {NAV.map((n) => {
              const active = n.key === view || n.also?.includes(view);
              const count = n.key === "queue" ? counts?.queue : n.key === "tasks" ? counts?.tasks : undefined;
              return (
                <button key={n.key} data-tour={`nav-${n.key}`} onClick={() => go(n.key)} aria-current={active ? "page" : undefined} className={cx("flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm", active ? "bg-accent-soft font-semibold text-[#2f55cc]" : "text-ink-2 hover:bg-page")}>
                  {n.icon}
                  <span className="flex-1 text-left">{n.label}</span>
                  {count ? <span className={cx("rounded-full px-1.5 text-xs", active ? "bg-accent text-white" : "bg-[#e7e9ec] text-ink-2")}>{count}</span> : null}
                </button>
              );
            })}
            {me?.profile.role === "admin" ? (
              <Link href="/admin" className="mt-auto flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm text-ink-2 hover:bg-page">
                <Settings2 className="h-4 w-4" /> Admin
              </Link>
            ) : null}
          </nav>
        ) : null}

        <main className={cx("min-w-0 flex-1", focus ? "" : "px-4 py-5 pb-24 md:px-6 md:pb-8")}>
          {!nav ? (
            <Card className="mx-auto mt-10 max-w-md">
              <Empty
                icon={<Inbox className="h-5 w-5" />}
                title="No agents assigned yet"
                body={me?.profile.role === "admin" ? "Add an agent account in Admin, then come back here." : "Ask your admin to assign you to an agent. Once they do, the agent's queue shows up here."}
                action={
                  me?.profile.role === "admin" ? (
                    <Link href="/admin" className="inline-flex h-9 items-center rounded-md bg-ink px-4 text-sm font-medium text-white">
                      Open Admin
                    </Link>
                  ) : null
                }
              />
            </Card>
          ) : view === "event" ? (
            <Verify nav={nav} eventId={params.get("id") ?? ""} />
          ) : view === "projects" ? (
            <ProjectList nav={nav} />
          ) : view === "project" ? (
            <ProjectView nav={nav} projectId={params.get("id") ?? ""} tab={params.get("tab") ?? "tickets"} taskId={params.get("task")} />
          ) : view === "preview" ? (
            <AgentPreview nav={nav} projectId={params.get("id") ?? ""} />
          ) : view === "tasks" ? (
            <TasksView nav={nav} />
          ) : view === "sources" ? (
            <Sources nav={nav} />
          ) : view === "qc" ? (
            <Qc nav={nav} />
          ) : (
            <Queue nav={nav} />
          )}
        </main>
      </div>

      {!focus ? (
        <nav aria-label="Sections" className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-white md:hidden">
          {NAV.map((n) => {
            const active = n.key === view || n.also?.includes(view);
            return (
              <button key={n.key} data-tour={`nav-${n.key}`} onClick={() => go(n.key)} className={cx("flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px]", active ? "font-semibold text-accent" : "text-ink-3")}>
                {n.icon}
                {n.label}
              </button>
            );
          })}
        </nav>
      ) : null}
    </div>
  );
}
