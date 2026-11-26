"use client";
import { useState } from "react";
import { ClipboardList, Plus } from "lucide-react";
import { rpc } from "@/lib/client/api";
import type { ProjectListItem, Task } from "@/lib/types";
import { Button, Card, Empty, ErrorNote, Spinner, Tabs, useLoad } from "../ui";
import { NewTicketDialog } from "./Ticket";
import type { VaNav } from "./Console";
import { TicketRow } from "./Projects";

type Filter = "open" | "suggested" | "delivered" | "all";

export function TasksView({ nav }: { nav: VaNav }) {
  const { data, error, loading, reload } = useLoad(() => rpc<Task[]>("vaTasks", { agent_id: nav.agent.id }), [nav.agent.id], { refreshMs: 30000 });
  const [filter, setFilter] = useState<Filter>("open");
  const [logging, setLogging] = useState(false);
  const projects = useLoad(() => rpc<ProjectListItem[]>("listProjects", { agent_id: nav.agent.id }), [nav.agent.id]);
  if (error && !data) return <ErrorNote message={error} onRetry={() => reload()} />;
  if (loading && !data) return <Spinner />;
  const all = data ?? [];
  const sets: Record<Filter, Task[]> = {
    open: all.filter((t) => ["received", "in_progress", "waiting"].includes(t.status)).sort((a, b) => (a.eta ?? "").localeCompare(b.eta ?? "")),
    suggested: all.filter((t) => t.status === "suggested"),
    delivered: all.filter((t) => t.status === "delivered"),
    all,
  };
  const rows = sets[filter];
  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Tickets</h1>
          <p className="mt-0.5 text-[13px] text-ink-3">Every ticket for {nav.agent.name}, across all projects. Tickets without an ETA come first.</p>
        </div>
        <Button icon={<Plus className="h-4 w-4" />} onClick={() => setLogging(true)}>
          Log a request from {nav.agent.name.split(" ")[0]}
        </Button>
      </div>
      <NewTicketDialog
        open={logging}
        onClose={() => setLogging(false)}
        projectId=""
        projects={(projects.data ?? []).filter((p) => !p.archived_at)}
        userName={nav.agent.name}
        onCreated={(t) => {
          reload(true);
          nav.refreshCounts();
          nav.go("project", { id: t.project_id, tab: "tickets", from: "tasks", task: t.id });
        }}
      />
      <Tabs
        className="mt-4"
        value={filter}
        onChange={setFilter}
        tabs={[
          { key: "open", label: "Open", count: sets.open.length },
          { key: "suggested", label: "Suggested", count: sets.suggested.length },
          { key: "delivered", label: "Delivered" },
          { key: "all", label: "All" },
        ]}
      />
      <div className="mt-4 space-y-1.5">
        {rows.length === 0 ? (
          <Card>
            <Empty icon={<ClipboardList className="h-5 w-5" />} title={filter === "open" ? "No open tickets" : "Nothing here"} body={filter === "open" ? "When the user sends a request it appears here as a ticket." : undefined} />
          </Card>
        ) : (
          rows.map((t) => <TicketRow key={t.id} task={t} tz={nav.agent.timezone} showProject onClick={() => nav.go("project", { id: t.project_id, tab: "tickets", from: "tasks", task: t.id })} />)
        )}
      </div>
    </div>
  );
}
