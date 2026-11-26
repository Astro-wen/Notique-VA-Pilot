"use client";
import { useState } from "react";
import { ExternalLink, Radar, RefreshCw } from "lucide-react";
import { rpc } from "@/lib/client/api";
import { ago, dateTime } from "@/lib/client/format";
import type { Watch } from "@/lib/types";
import { Badge, Button, Card, Empty, Field, Input, Textarea, useToast } from "../ui";

const EXAMPLES = ["The average 30 year fixed mortgage rate is at or below 6.25%", "A 4 bedroom home is listed under $950,000 in Irvine 92620", "The Federal Reserve has announced a rate cut"];

/** Conditions Notique checks once a day for this client. A hit opens a ticket with a drafted follow-up. */
export function Watches({ projectId, watches, tz, onChanged, onOpenTicket }: { projectId: string; watches: Watch[] | null; tz: string; onChanged: () => void; onOpenTicket: (taskId: string) => void }) {
  const toast = useToast();
  const [condition, setCondition] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  if (watches == null) {
    return (
      <Card className="mt-4">
        <Empty icon={<Radar className="h-5 w-5" />} title="Watches are not set up yet" body="Ask your admin to turn them on. Everything else works without them." />
      </Card>
    );
  }

  async function add() {
    if (condition.trim().length < 8) return toast("Describe what to watch for, with a number or a place.", { tone: "error" });
    if (adding) return;
    setAdding(true);
    try {
      await rpc("createWatch", { project_id: projectId, condition, note });
      setCondition("");
      setNote("");
      onChanged();
      toast("Watching. It is checked once a day. Press Check now to run it right away.");
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    } finally {
      setAdding(false);
    }
  }

  async function run(w: Watch, fn: "checkWatch" | "updateWatch", args: Record<string, unknown> = {}) {
    setBusy(w.id + fn);
    try {
      const next = await rpc<Watch>(fn, { watch_id: w.id, ...args });
      onChanged();
      if (fn === "checkWatch") {
        if (next.last_result?.error) toast(next.last_result.error, { tone: "error" });
        else toast(next.status === "met" ? "It is true now. A ticket was opened with a drafted follow-up." : "Checked. Not true yet.");
      }
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-2">
        {watches.length === 0 ? (
          <Card>
            <Empty icon={<Radar className="h-5 w-5" />} title="Nothing is being watched" body="When a client is waiting on something in the market, such as a lower rate or a new listing, add it here. Notique checks once a day and opens a ticket when it happens." />
          </Card>
        ) : null}
        {watches.map((w) => (
          <Card key={w.id} className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={w.status === "met" ? "ok" : w.status === "paused" ? "neutral" : "accent"}>{w.status === "met" ? "Condition met" : w.status === "paused" ? "Paused" : "Watching"}</Badge>
              <span className="text-xs text-ink-3">{w.last_checked_at ? `Checked ${ago(w.last_checked_at)}` : "Not checked yet"}</span>
              {w.met_at ? <span className="text-xs text-ink-3">Met {dateTime(w.met_at, tz)}</span> : null}
            </div>
            <p className="mt-1.5 font-medium">{w.condition}</p>
            {w.note ? <p className="mt-0.5 text-[13px] text-ink-3">{w.note}</p> : null}
            {w.last_result?.error ? <p className="mt-2 text-[13px] text-bad">Last check failed: {w.last_result.error}</p> : null}
            {w.last_result?.summary ? <p className="mt-2 rounded-lg bg-page px-3 py-2 text-[13px] text-ink-2">{w.last_result.summary}</p> : null}
            {w.last_result?.sources?.length ? (
              <ul className="mt-2 space-y-1">
                {w.last_result.sources.map((s) => (
                  <li key={s.url}>
                    <a href={s.url} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1 text-[13px] text-accent hover:underline">
                      <ExternalLink className="h-3 w-3 shrink-0" />
                      <span className="truncate">{s.title}</span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
            {w.status === "met" && w.last_result?.draft ? (
              <div className="mt-3 rounded-lg border border-line px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-ink-3">Draft for the user to send to their client</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      navigator.clipboard.writeText(w.last_result?.draft ?? "").then(
                        () => toast("Copied."),
                        () => toast("Could not copy. Select the text and copy it by hand.", { tone: "error" }),
                      )
                    }
                  >
                    Copy
                  </Button>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-[13px] text-ink-2">{w.last_result.draft}</p>
                <p className="mt-1.5 text-xs text-ink-3">Written by AI and not reviewed. The user cannot see it. Check it against the sources, then deliver your version on the ticket.</p>
              </div>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {w.status === "active" ? (
                <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} busy={busy === w.id + "checkWatch"} onClick={() => run(w, "checkWatch")}>
                  Check now
                </Button>
              ) : null}
              {w.status === "met" && w.task_id ? (
                <Button size="sm" variant="primary" onClick={() => onOpenTicket(w.task_id as string)}>
                  Open the follow-up ticket
                </Button>
              ) : null}
              {w.status === "active" ? (
                <Button size="sm" variant="ghost" onClick={() => run(w, "updateWatch", { status: "paused" })}>
                  Pause
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => run(w, "updateWatch", { status: "active" })}>
                  {w.status === "met" ? "Watch again" : "Resume"}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => run(w, "updateWatch", { status: "closed" })}>
                Remove
              </Button>
            </div>
          </Card>
        ))}
      </div>

      <Card className="h-fit p-4">
        <div className="text-[15px] font-semibold">Watch for something</div>
        <p className="mt-0.5 text-[13px] text-ink-3">Write it as a statement that is either true or not, with the number or place. Leave the client&apos;s name out.</p>
        <div className="mt-3 space-y-3">
          <Field label="What to watch for">
            <Textarea rows={2} value={condition} onChange={(e) => setCondition(e.target.value)} maxLength={300} placeholder={EXAMPLES[0]} />
          </Field>
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((x) => (
              <button key={x} className="rounded-full border border-line px-2.5 py-1 text-left text-xs text-ink-2 hover:bg-page" onClick={() => setCondition(x)}>
                {x}
              </button>
            ))}
          </div>
          <Field label="Why it matters for this client" hint="Optional. Used when the follow-up is drafted.">
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="They paused the search until rates drop" />
          </Field>
          <Button variant="primary" busy={adding} onClick={add}>
            Start watching
          </Button>
        </div>
      </Card>
    </div>
  );
}
