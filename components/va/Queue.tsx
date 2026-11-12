"use client";
import { useEffect, useState } from "react";
import { AlertTriangle, Clock, FileAudio, FileText, Loader2, MessageSquareText, Mic, NotebookPen, Plus, Trash2 } from "lucide-react";
import { rpc } from "@/lib/client/api";
import { CHANNEL_LABEL, SOURCE_LABEL, TASK_STATUS_LABEL, ago, dateTime, remaining, taskNo, tzAbbr } from "@/lib/client/format";
import type { EventRow, QueueEvent, QueueResult } from "@/lib/types";
import { AddEventDialog, type AddKind } from "../AddEventDialog";
import { Badge, Button, Card, Empty, ErrorNote, IconButton, SectionTitle, Spinner, useLoad, useToast } from "../ui";
import type { VaNav } from "./Console";
import { Coach, TOURS } from "../Coach";

export function DueCell({ iso, tz }: { iso: string | null; tz: string }) {
  const left = remaining(iso);
  if (!iso || !left) return <span className="text-ink-3">No deadline</span>;
  return (
    <div>
      <div className={left.tone === "late" ? "font-semibold text-bad" : left.tone === "soon" ? "font-semibold text-warn" : "text-ink"}>{left.text}</div>
      <div className="text-xs text-ink-3">{dateTime(iso, tz, true)}</div>
    </div>
  );
}

function useQueue(nav: VaNav) {
  const state = useLoad(() => rpc<QueueResult>("vaQueue", { agent_id: nav.agent.id }), [nav.agent.id], { refreshMs: 30000 });
  const working = (state.data?.processing ?? []).filter((e) => e.status === "processing" || e.status === "extracting");
  const ids = working.map((e) => e.id).join(",");
  const { reload } = state;
  const { refreshCounts } = nav;
  useEffect(() => {
    if (!ids) return;
    const id = window.setInterval(async () => {
      try {
        const rows = await rpc<EventRow[]>("pollEvents", { event_ids: ids.split(",") });
        if (rows.some((r) => r.status !== "processing" && r.status !== "extracting")) {
          reload(true);
          refreshCounts();
        }
      } catch {
        /* Keep polling. */
      }
    }, 6000);
    return () => window.clearInterval(id);
  }, [ids, reload, refreshCounts]);
  return state;
}

function Processing({ rows, nav, reload }: { rows: QueueEvent[]; nav: VaNav; reload: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  if (rows.length === 0) return null;
  async function act(fn: string, id: string, done: string) {
    setBusy(id);
    try {
      const row = await rpc<{ status?: string; error?: string | null } | null>(fn, { event_id: id });
      if (fn === "retryEvent" && row?.status === "failed") toast(row.error ?? "The retry failed.", { tone: "error" });
      else toast(done);
      reload();
      nav.refreshCounts();
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    } finally {
      setBusy(null);
    }
  }
  return (
    <Card className="mt-5">
      <SectionTitle className="border-b border-line px-4 py-3">Not ready for review</SectionTitle>
      <ul className="divide-y divide-line">
        {rows.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{e.title}</div>
              <div className="truncate text-xs text-ink-3">
                {e.project_name}, {SOURCE_LABEL[e.source]}, added {ago(e.created_at).toLowerCase()}
              </div>
              {e.status === "failed" && e.error ? <div className="mt-1 text-[13px] text-bad">{e.error}</div> : null}
              {e.status === "escalated" && e.escalation_note ? <div className="mt-1 text-[13px] text-ink-2">Reason: {e.escalation_note}</div> : null}
            </div>
            {e.status === "processing" || e.status === "extracting" ? (
              <Badge tone="accent">
                <Loader2 className="h-3 w-3 animate-spin" />
                {e.status === "processing" ? "Transcribing" : "Drafting facts"}
              </Badge>
            ) : e.status === "failed" ? (
              <>
                <Badge tone="bad">Failed</Badge>
                <Button size="sm" busy={busy === e.id} onClick={() => act("retryEvent", e.id, "Retry started.")}>
                  Retry
                </Button>
              </>
            ) : (
              <>
                <Badge tone="warn">Escalated</Badge>
                <Button size="sm" busy={busy === e.id} onClick={() => act("reopenEvent", e.id, "Moved back to the queue.")}>
                  Return to queue
                </Button>
              </>
            )}
            {e.status === "failed" || e.status === "escalated" ? (
              <IconButton
                label="Delete this event"
                onClick={() => {
                  if (window.confirm(`Delete "${e.title}"? The upload and its draft facts are removed for good.`)) act("deleteEvent", e.id, "Event deleted.");
                }}
              >
                <Trash2 className="h-4 w-4" />
              </IconButton>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function Queue({ nav }: { nav: VaNav }) {
  const { data, error, loading, reload } = useQueue(nav);
  const [add, setAdd] = useState<AddKind | null>(null);
  if (error && !data) return <ErrorNote message={error} onRetry={() => reload()} />;
  if (loading && !data) return <Spinner />;
  if (!data) return null;
  const tz = data.agent.timezone;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Queue</h1>
          <p className="mt-0.5 text-[13px] text-ink-3">
            Serving {data.agent.name}. Times are shown in {tzAbbr(tz)}.
          </p>
        </div>
        <Button data-tour="add-conversation" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdd("audio")}>
          Add conversation
        </Button>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        {[
          { label: "Due within 2 hours", value: data.stats.dueSoon, tone: data.stats.dueSoon ? "text-bad" : "" },
          { label: "Due in the next 24 hours", value: data.stats.dueToday, tone: "" },
          { label: "Verified this week", value: data.stats.verifiedThisWeek, tone: "" },
        ].map((s) => (
          <Card key={s.label} className="px-4 py-3">
            <div className={`text-2xl font-semibold ${s.tone}`}>{s.value}</div>
            <div className="text-xs text-ink-3">{s.label}</div>
          </Card>
        ))}
      </div>

      <Card className="mt-5 overflow-hidden" data-tour="queue-table">
        <SectionTitle className="border-b border-line px-4 py-3" right={<span className="text-xs text-ink-3">Earliest deadline first</span>}>
          Events to verify
        </SectionTitle>
        {data.events.length === 0 ? (
          <Empty
            icon={<Clock className="h-5 w-5" />}
            title="Nothing to verify right now"
            body={data.processing.some((e) => e.status === "processing" || e.status === "extracting") ? "New uploads are still being prepared. They will appear here on their own." : "When the user records or uploads a conversation it appears here. You can also add one yourself."}
            action={<Button onClick={() => setAdd("audio")}>Add conversation</Button>}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="text-xs text-ink-3">
                <tr className="border-b border-line">
                  <th className="px-4 py-2 font-medium">Event</th>
                  <th className="px-3 py-2 font-medium">Project</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">Received</th>
                  <th className="px-3 py-2 font-medium">Due</th>
                  <th className="px-3 py-2 font-medium">AI drafts</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.events.map((e, i) => (
                  <tr key={e.id} className="hover:bg-[#fafafa]">
                    <td className="px-4 py-3">
                      <button className="text-left font-medium hover:text-accent" onClick={() => nav.go("event", { id: e.id })}>
                        {e.title}
                      </button>
                      {e.status === "in_review" && e.resolved_count > 0 ? <div className="text-xs text-ink-3">Started, {e.resolved_count} of {e.fact_count} decided</div> : null}
                    </td>
                    <td className="px-3 py-3">
                      <button className="text-accent hover:underline" onClick={() => nav.go("project", { id: e.project_id })}>
                        {e.project_name}
                      </button>
                    </td>
                    <td className="px-3 py-3 text-ink-2">{SOURCE_LABEL[e.source]}</td>
                    <td className="px-3 py-3 text-ink-2">{ago(e.created_at)}</td>
                    <td className="px-3 py-3">
                      <DueCell iso={e.due_at} tz={tz} />
                    </td>
                    <td className="px-3 py-3 text-ink-2">{e.fact_count === 0 ? "None found" : e.fact_count}</td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant={i === 0 ? "primary" : "outline"} onClick={() => nav.go("event", { id: e.id })}>
                        {e.status === "in_review" && e.resolved_count > 0 ? "Continue" : "Verify"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Processing rows={data.processing} nav={nav} reload={() => reload(true)} />
      <Coach name="va-home" steps={TOURS.vaHome} primary />

      {data.ticketsDue.length ? (
        <Card className="mt-5">
          <SectionTitle
            className="border-b border-line px-4 py-3"
            right={
              <Button variant="link" size="sm" onClick={() => nav.go("tasks")}>
                All tickets
              </Button>
            }
          >
            Open tickets
          </SectionTitle>
          <p className="border-b border-line px-4 py-2 text-[13px] text-ink-3">Work {nav.agent.name.split(" ")[0]} asked for and is waiting on. Each one needs an ETA, then a deliverable.</p>
          <ul className="divide-y divide-line">
            {data.ticketsDue.map((t) => (
              <li key={t.id}>
                <button className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[#fafafa]" onClick={() => nav.go("project", { id: t.project_id, tab: "tickets", task: t.id })}>
                  <span className="w-14 shrink-0 font-mono text-xs text-ink-3">{taskNo(t.number)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{t.title}</span>
                    <span className="block truncate text-xs text-ink-3">
                      {t.project_name}, {t.requested_via && t.requested_via !== "in_app" ? `requested by ${nav.agent.name.split(" ")[0]} by ${CHANNEL_LABEL[t.requested_via]?.toLowerCase() ?? t.requested_via}, logged by a VA` : `assigned by ${nav.agent.name.split(" ")[0]} in the app`}
                    </span>
                  </span>
                  <Badge tone={t.status === "waiting" ? "warn" : t.status === "received" ? "accent" : "neutral"}>{TASK_STATUS_LABEL[t.status]}</Badge>
                  <span className="hidden w-40 text-right text-xs sm:block">{t.eta ? <span className={remaining(t.eta)?.tone === "late" ? "font-semibold text-bad" : "text-ink-2"}>ETA {dateTime(t.eta, tz)}</span> : <span className="font-medium text-warn">ETA not set</span>}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <AddEventDialog
        open={add !== null}
        defaultKind={add ?? undefined}
        onClose={() => setAdd(null)}
        projects={data.projects}
        agentId={nav.agent.id}
        onCreated={() => {
          reload(true);
          nav.refreshCounts();
        }}
      />
    </div>
  );
}

const SOURCE_CARDS: { kind: AddKind | null; keys: string[]; title: string; mode: string; body: string; icon: React.ReactNode }[] = [
  { kind: "audio", keys: ["recording"], title: "Meeting or call recording", mode: "Upload", body: "Audio or video. Transcribed with speaker labels, usually in a few minutes.", icon: <FileAudio className="h-5 w-5" /> },
  { kind: "audio", keys: ["voice_memo"], title: "Voice memo or debrief", mode: "Upload", body: "The user talking alone after a meeting. Tick the voice memo box when you upload.", icon: <Mic className="h-5 w-5" /> },
  { kind: "transcript", keys: ["transcript_upload"], title: "Transcript", mode: "Upload", body: "A .vtt, .txt, or .docx export from Zoom, Meet, or another recorder.", icon: <FileText className="h-5 w-5" /> },
  { kind: "texts", keys: ["text_upload"], title: "Text messages", mode: "Upload", body: "Screenshots of a thread or the pasted messages.", icon: <MessageSquareText className="h-5 w-5" /> },
  { kind: "note", keys: ["note", "crm"], title: "Written note or CRM note", mode: "Paste", body: "Copy a note out of Follow Up Boss or type a recap.", icon: <NotebookPen className="h-5 w-5" /> },
];

export function Sources({ nav }: { nav: VaNav }) {
  const { data, error, loading, reload } = useQueue(nav);
  const [add, setAdd] = useState<AddKind | null>(null);
  if (error && !data) return <ErrorNote message={error} onRetry={() => reload()} />;
  if (loading && !data) return <Spinner />;
  if (!data) return null;
  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-xl font-semibold">Data sources</h1>
      <p className="mt-0.5 text-[13px] text-ink-3">Everything {data.agent.name} sends in becomes an event in the queue. Add anything that reached you another way.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SOURCE_CARDS.map((s) => {
          const count = s.keys.reduce((sum, k) => sum + (data.sources[k as keyof typeof data.sources]?.count_week ?? 0), 0);
          const last = s.keys.map((k) => data.sources[k as keyof typeof data.sources]?.last_at).filter(Boolean).sort().pop();
          return (
            <Card key={s.title} className="flex flex-col p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-page text-ink-2">{s.icon}</div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{s.title}</div>
                  <div className="text-xs text-ink-3">{count ? `${count} this week, last ${ago(last).toLowerCase()}` : "None this week"}</div>
                </div>
              </div>
              <p className="mt-3 flex-1 text-[13px] text-ink-2">{s.body}</p>
              <Button className="mt-4 self-start" size="sm" onClick={() => setAdd(s.kind)}>
                {s.mode}
              </Button>
            </Card>
          );
        })}
        <Card className="flex flex-col border-dashed p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-page text-ink-3">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <div className="font-semibold">Follow Up Boss sync</div>
              <div className="text-xs text-ink-3">Not connected in this pilot</div>
            </div>
          </div>
          <p className="mt-3 text-[13px] text-ink-2">Until the sync is live, paste CRM notes with Written note, and use Copy profile note on a project to bring results back into the CRM.</p>
        </Card>
      </div>
      <Processing rows={data.processing} nav={nav} reload={() => reload(true)} />
      <AddEventDialog
        open={add !== null}
        defaultKind={add ?? undefined}
        onClose={() => setAdd(null)}
        projects={data.projects}
        agentId={nav.agent.id}
        onCreated={() => {
          reload(true);
          nav.refreshCounts();
        }}
      />
    </div>
  );
}
