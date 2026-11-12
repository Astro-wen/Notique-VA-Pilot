"use client";
import { useState } from "react";
import { rpc } from "@/lib/client/api";
import { FEEDBACK_LABEL } from "@/lib/client/format";
import type { QcResult } from "@/lib/types";
import { Card, ErrorNote, Spinner, Tabs, useLoad } from "../ui";
import type { VaNav } from "./Console";

function Bar({ label, value, total }: { label: string; value: number; total: number }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between text-[13px]">
        <span className="text-ink-2">{label}</span>
        <span className="font-medium">
          {value} ({pct}%)
        </span>
      </div>
      <div className="mt-1 h-2 rounded-full bg-page">
        <div className="h-2 rounded-full bg-ink" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Qc({ nav }: { nav: VaNav }) {
  const [range, setRange] = useState<"week" | "all">("week");
  const { data, error, loading, reload } = useLoad(() => rpc<QcResult>("vaQc", { agent_id: nav.agent.id, range }), [nav.agent.id, range]);
  const v = data?.verdicts;
  const aiTotal = v ? v.approved + v.edited + v.declined + v.insufficient : 0;
  const fbTotal = data ? Object.values(data.feedback).reduce((a, b) => a + b, 0) : 0;
  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-xl font-semibold">QC review</h1>
      <p className="mt-0.5 text-[13px] text-ink-3">How the work for {nav.agent.name} is going. Counts cover submitted events and delivered tickets.</p>
      <Tabs
        className="mt-4"
        value={range}
        onChange={setRange}
        tabs={[
          { key: "week", label: "This week" },
          { key: "all", label: "All time" },
        ]}
      />
      {error && !data ? <ErrorNote className="mt-4" message={error} onRetry={() => reload()} /> : null}
      {loading && !data ? <Spinner /> : null}
      {data && v ? (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              ["Events verified", data.eventsVerified],
              ["Average review time", data.avgReviewMinutes === null ? "No data" : `${data.avgReviewMinutes} min`],
              ["Tickets delivered", data.tasksDelivered],
              ["Delivered on time", data.onTimeRate === null ? "No data" : `${data.onTimeRate}%`],
              ["Average ticket time", data.avgTaskMinutes === null ? "No data" : `${data.avgTaskMinutes} min`],
              ["Total VA time", `${data.totalMinutes} min`],
            ].map(([label, value]) => (
              <Card key={label as string} className="px-4 py-3">
                <div className="text-xl font-semibold">{value}</div>
                <div className="text-xs text-ink-3">{label}</div>
              </Card>
            ))}
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card className="space-y-3 p-4">
              <h2 className="text-[15px] font-semibold">What happened to AI drafts</h2>
              {aiTotal === 0 ? <p className="text-[13px] text-ink-3">No submitted events in this period.</p> : null}
              {aiTotal > 0 ? (
                <>
                  <Bar label="Approved as written" value={v.approved} total={aiTotal} />
                  <Bar label="Edited" value={v.edited} total={aiTotal} />
                  <Bar label="Declined" value={v.declined} total={aiTotal} />
                  <Bar label="Insufficient evidence" value={v.insufficient} total={aiTotal} />
                </>
              ) : null}
            </Card>
            <Card className="space-y-3 p-4">
              <h2 className="text-[15px] font-semibold">User feedback on deliverables</h2>
              {fbTotal === 0 ? <p className="text-[13px] text-ink-3">No delivered tickets in this period.</p> : null}
              {fbTotal > 0 ? (
                <>
                  {(["used_as_is", "edited", "not_used"] as const).map((k) => (
                    <Bar key={k} label={FEEDBACK_LABEL[k]} value={data.feedback[k]} total={fbTotal} />
                  ))}
                  <Bar label="No feedback yet" value={data.feedback.none} total={fbTotal} />
                </>
              ) : null}
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
