"use client";
import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { rpc } from "@/lib/client/api";
import { CHANNEL_LABEL, dateTime } from "@/lib/client/format";
import type { TaskMessage } from "@/lib/types";
import { Button, Select, Textarea, cx, useToast } from "./ui";

interface Props {
  taskId: string;
  messages: TaskMessage[];
  viewer: "va" | "agent";
  otherName: string;
  disabled?: string | null;
  canAsk?: boolean;
  onSent: () => void;
}

/** Conversation between the agent and the VA on one task. */
export function TaskThread({ taskId, messages, viewer, otherName, disabled, canAsk, onSent }: Props) {
  const toast = useToast();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"send" | "log">("send");
  const [channel, setChannel] = useState("text");
  const endRef = useRef<HTMLDivElement>(null);
  const count = messages.length;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [count]);

  async function send(ask: boolean) {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await rpc("sendTaskMessage", {
        task_id: taskId,
        body,
        ask,
        ...(viewer === "va" && mode === "log" ? { as_agent: true, channel } : {}),
      });
      setBody("");
      onSent();
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="max-h-80 space-y-3 overflow-y-auto pr-1">
        {messages.length === 0 ? <p className="py-2 text-[13px] text-ink-3">No messages yet.</p> : null}
        {messages.map((m) => {
          if (m.sender_role === "system") {
            return (
              <div key={m.id} className="text-center text-xs text-ink-3">
                {m.body} {dateTime(m.created_at)}
              </div>
            );
          }
          const mine = m.sender_role === viewer;
          const who = mine ? "You" : m.sender_name ?? (m.sender_role === "agent" ? (viewer === "va" ? otherName : "You") : otherName);
          return (
            <div key={m.id} className={cx("flex flex-col", mine ? "items-end" : "items-start")}>
              <div className={cx("max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm", mine ? "bg-ink text-white" : "bg-page text-ink")}>{m.body}</div>
              <div className="mt-1 text-xs text-ink-3">
                {m.sender_role === "agent" && !m.sender_id && viewer === "va" ? `${otherName}, logged from ${CHANNEL_LABEL[m.channel]?.toLowerCase() ?? m.channel}` : who}
                {", "}
                {dateTime(m.created_at)}
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {disabled ? (
        <p className="mt-3 rounded-lg bg-page px-3 py-2 text-[13px] text-ink-3">{disabled}</p>
      ) : (
        <div className="mt-3">
          {viewer === "va" ? (
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[13px]">
              <div className="inline-flex rounded-md border border-line p-0.5">
                {(["send", "log"] as const).map((key) => (
                  <button key={key} onClick={() => setMode(key)} className={cx("h-7 rounded px-2.5", mode === key ? "bg-ink text-white" : "text-ink-2")}>
                    {key === "send" ? `Message ${otherName}` : "Log agent reply"}
                  </button>
                ))}
              </div>
              {mode === "log" ? (
                <Select aria-label="Where the agent replied" className="!h-8 !w-auto" value={channel} onChange={(e) => setChannel(e.target.value)}>
                  <option value="text">Replied by text</option>
                  <option value="email">Replied by email</option>
                  <option value="call">Replied on a call</option>
                </Select>
              ) : null}
            </div>
          ) : null}
          <Textarea
            rows={2}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={viewer === "va" ? (mode === "log" ? "Paste or summarise what the agent said" : "Write to the agent") : `Message ${otherName}`}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(false);
            }}
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            {viewer === "va" && mode === "send" && canAsk ? (
              <Button size="sm" onClick={() => send(true)} disabled={!body.trim() || busy} title="Sends the message, pauses the timer, and marks the ticket as waiting on the agent">
                Ask agent and pause
              </Button>
            ) : null}
            <Button size="sm" variant={viewer === "agent" ? "primary" : "outline"} icon={<Send className="h-3.5 w-3.5" />} onClick={() => send(false)} disabled={!body.trim()} busy={busy}>
              {viewer === "va" && mode === "log" ? "Log reply" : "Send"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
