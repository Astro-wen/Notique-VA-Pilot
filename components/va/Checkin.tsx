"use client";
import { useEffect, useRef, useState } from "react";
import { Check, ClipboardCopy, MessagesSquare, Send } from "lucide-react";
import { rpc } from "@/lib/client/api";
import { CHANNEL_LABEL, dateTime, taskNo } from "@/lib/client/format";
import type { CheckinItem, CheckinResult } from "@/lib/types";
import { Badge, Button, Card, Empty, ErrorNote, Select, Spinner, Textarea, useLoad, useToast, type Tone } from "../ui";
import type { VaNav } from "./Console";

const KIND: Record<CheckinItem["kind"], { label: string; tone: Tone }> = {
  waiting: { label: "Needs their answer", tone: "warn" },
  suggested: { label: "Suggested, user has not decided", tone: "accent" },
  unreviewed: { label: "Delivered, no feedback", tone: "neutral" },
  question: { label: "User still has to ask the client. Remind them in your message.", tone: "neutral" },
};

/** Once a day the VA asks the user what is still open, and offers to take it over. */
export function Checkin({ nav }: { nav: VaNav }) {
  const toast = useToast();
  const { data, setData, error, loading, reload } = useLoad(() => rpc<CheckinResult>("vaCheckin", { agent_id: nav.agent.id }), [nav.agent.id]);
  const [message, setMessage] = useState("");
  const [touched, setTouched] = useState(false);
  const [channel, setChannel] = useState("text");
  const [busy, setBusy] = useState<string | null>(null);
  const tz = nav.agent.timezone;
  const first = nav.agent.name.split(" ")[0];
  const current = useRef(nav.agent.id);
  current.current = nav.agent.id;

  // Fill the draft once per user. Later reloads must not overwrite what the VA has edited.
  const suggested = data?.message ?? "";
  useEffect(() => {
    setTouched(false);
  }, [nav.agent.id]);
  useEffect(() => {
    if (!touched) setMessage(suggested);
  }, [suggested, touched]);

  if (error && !data) return <ErrorNote message={error} onRetry={() => reload()} />;
  if (loading && !data) return <Spinner />;
  if (!data) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(message);
      toast("Copied. Paste it into your text or email to the user.");
    } catch {
      toast("Could not copy. Select the text and copy it by hand.", { tone: "error" });
    }
  }

  async function markDone() {
    setBusy("done");
    try {
      const forUser = nav.agent.id;
      const next = await rpc<CheckinResult>("logCheckin", { agent_id: forUser, channel });
      // Ignore the answer if the VA has switched to another user in the meantime.
      if (current.current !== forUser) return;
      setData(next);
      nav.refreshCounts();
      toast("Check-in logged for today.");
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function send(via: "email" | "sms" | "both") {
    if (!message.trim()) return;
    setBusy("send");
    try {
      const forUser = nav.agent.id;
      const next = await rpc<CheckinResult & { delivery: { sent: string[]; failed: string[] } }>("sendCheckin", { agent_id: forUser, message, channel: via });
      if (current.current !== forUser) return;
      setData(next);
      nav.refreshCounts();
      toast(next.delivery.failed.length ? `Sent by ${next.delivery.sent.join(" and ")}. The ${next.delivery.failed.join(" and ")} did not go through.` : "Sent, and logged for today.", next.delivery.failed.length ? { tone: "error" } : undefined);
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function act(item: CheckinItem, fn: "assignTask" | "dismissTask") {
    setBusy(item.id);
    try {
      await rpc(fn, { task_id: item.task_id, requested_via: channel });
      toast(fn === "assignTask" ? "Ticket opened. It is in your Tickets now." : "Removed from the list.");
      await reload(true);
      nav.refreshCounts();
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  const historyCard = data.history.length ? (
      <Card className="p-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-ink-3">Recent check-ins</div>
        <ul className="mt-2 space-y-1.5 text-[13px] text-ink-2">
          {data.history.map((h) => (
            <li key={h.at} className="flex justify-between gap-3">
              <span>
                {dateTime(h.at, tz)}, {h.by.split(" ")[0]}, {(CHANNEL_LABEL[h.channel] ?? h.channel).toLowerCase()}
              </span>
              <span className="text-ink-3">{h.count} open</span>
            </li>
          ))}
        </ul>
      </Card>
  ) : null;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">Daily check-in</h1>
        {data.doneToday ? <Badge tone="ok">Done today</Badge> : data.items.length ? <Badge tone="warn">Not done today</Badge> : null}
      </div>
      <p className="mt-0.5 max-w-3xl text-[13px] text-ink-3">
        Once a day, ask {first} what is still open and offer to take it over. Three steps: edit the message, send it, mark it done. When {first} says yes to something, press the button on that item so it becomes a ticket.
      </p>

      {data.items.length === 0 ? (
        <>
          <Card className="mt-4">
            <Empty icon={<MessagesSquare className="h-5 w-5" />} title={`Nothing is waiting on ${first}`} body="Suggested follow-ups, unanswered questions, and deliveries without feedback show up here." />
          </Card>
          <div className="mt-4 max-w-md">{historyCard}</div>
        </>
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-1.5">
            {data.items.map((item, i) => {
              const kind = KIND[item.kind];
              return (
                <Card key={`${item.kind}-${item.id}`} className="p-3.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-ink-3">{i + 1}</span>
                    <Badge tone={kind.tone}>{kind.label}</Badge>
                    {item.days >= 2 ? <Badge tone="bad">Open {item.days} days</Badge> : item.days === 1 ? <span className="text-xs text-ink-3">Since yesterday</span> : <span className="text-xs text-ink-3">Today</span>}
                    {item.task_number ? <span className="font-mono text-xs text-ink-3">{taskNo(item.task_number)}</span> : null}
                  </div>
                  <p className="mt-1.5 text-sm">{item.title}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button className="text-[13px] text-accent hover:underline" onClick={() => nav.go("project", { id: item.project_id, tab: item.kind === "question" ? "profile" : "tickets", task: item.kind === "question" || item.kind === "suggested" ? undefined : item.task_id ?? undefined })}>
                      {item.project_name}
                    </button>
                    <span className="flex-1" />
                    {item.kind === "suggested" ? (
                      <>
                        <Button size="sm" busy={busy === item.id} onClick={() => act(item, "dismissTask")}>
                          {first} will do it
                        </Button>
                        <Button size="sm" busy={busy === item.id} onClick={() => act(item, "assignTask")}>
                          {first} wants me to do it
                        </Button>
                      </>
                    ) : item.task_id ? (
                      <Button size="sm" onClick={() => nav.go("project", { id: item.project_id, tab: "tickets", from: "checkin", task: item.task_id ?? undefined })}>
                        Open ticket
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => nav.go("project", { id: item.project_id, tab: "profile" })}>
                        Open deal profile
                      </Button>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>

          <div className="space-y-4">
            <Card className="p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-ink-3">Message to {first}</div>
              <Textarea
                className="mt-2"
                rows={11}
                aria-label="Check-in message"
                value={message}
                onChange={(e) => {
                  setTouched(true);
                  setMessage(e.target.value);
                }}
              />
              <p className="mt-1.5 text-xs text-ink-3">
                {data.reach.email || data.reach.sms ? `Edit it to sound like you, then send it from here${data.reach.email && data.reach.sms ? "" : data.reach.email ? " by email" : " by text"}, or copy it and send it yourself.` : `Edit it to sound like you. Copy it and send it to ${first} from your own phone or email (only to ${first}, never to a client), then mark it done.`}
              </p>
              {data.reach.email || data.reach.sms ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {data.reach.email ? (
                    <Button size="sm" icon={<Send className="h-3.5 w-3.5" />} busy={busy === "send"} disabled={!message.trim()} onClick={() => send("email")}>
                      Email {first}
                    </Button>
                  ) : null}
                  {data.reach.sms ? (
                    <Button size="sm" icon={<Send className="h-3.5 w-3.5" />} busy={busy === "send"} disabled={!message.trim()} onClick={() => send("sms")}>
                      Text {first}
                    </Button>
                  ) : null}
                  <span className="text-xs text-ink-3">{[data.reach.email ? data.reach.emailTo : null, data.reach.sms ? data.reach.smsTo : null].filter(Boolean).join(", ")}</span>
                </div>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button size="sm" icon={<ClipboardCopy className="h-3.5 w-3.5" />} onClick={copy} disabled={!message.trim()}>
                  Copy message
                </Button>
                <span className="flex-1" />
                <Select aria-label="How did you send it?" className="!h-8 !w-auto" value={channel} onChange={(e) => setChannel(e.target.value)}>
                  <option value="text">I sent it by text</option>
                  <option value="email">I sent it by email</option>
                  <option value="call">I called instead</option>
                </Select>
                <Button size="sm" variant={data.doneToday ? "outline" : "primary"} icon={<Check className="h-3.5 w-3.5" />} busy={busy === "done"} onClick={markDone}>
                  {data.doneToday ? "Log another check-in today" : "Mark done for today"}
                </Button>
              </div>
            </Card>

            {historyCard}
          </div>
        </div>
      )}
    </div>
  );
}
