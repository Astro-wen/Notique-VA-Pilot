"use client";
import { useState } from "react";
import { ClipboardList } from "lucide-react";
import { rpc } from "@/lib/client/api";
import type { Task } from "@/lib/types";
import { Card, Empty, ErrorNote, Spinner, Tabs, useLoad } from "../ui";
import type { VaNav } from "./Console";
import { TicketRow } from "./Projects";

type Filter = "open" | "suggested" | "delivered" | "all";

export function TasksView({ nav }: { nav: VaNav }) {
  const { data, error, loading, reload } = useLoad(() => rpc<Task[]>("vaTasks", { agent_id: nav.agent.id }), [nav.agent.id], { refreshMs: 30000 });
  const [filter, setFilter] = useState<Filter>("open");
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
    <div className="mx-auto max-w-3xl">
      <h1 className="text-xl font-semibold">Tickets</h1>
      <p className="mt-0.5 text-[13px] text-ink-3">Every ticket for {nav.agent.name}, across all projects. Tickets without an ETA come first.</p>
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
            <Empty icon={<ClipboardList className="h-5 w-5" />} title={filter === "open" ? "No open tickets" : "Nothing here"} body={filter === "open" ? "When the user assigns a task it appears here." : undefined} />
          </Card>
        ) : (
          rows.map((t) => <TicketRow key={t.id} task={t} tz={nav.agent.timezone} showProject onClick={() => nav.go("project", { id: t.project_id, tab: "tickets", task: t.id })} />)
        )}
      </div>
    </div>
  );
}
