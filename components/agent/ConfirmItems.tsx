"use client";
import { useState } from "react";
import { CircleHelp } from "lucide-react";
import { ApiError, rpc } from "@/lib/client/api";
import { SECTIONS, type Fact } from "@/lib/types";
import { FactRow } from "../DealFacts";
import { Button, Field, Modal, Textarea, useToast } from "../ui";

const MAX = 400;

/** Items the assistant could not settle from the conversation. The user confirms, fixes or rejects each one. */
export function ConfirmItems({ items, tz, vaName, preview, onChanged }: { items: Fact[]; tz: string; vaName: string; preview?: boolean; onChanged: () => Promise<unknown> | void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [fixing, setFixing] = useState<Fact | null>(null);
  const [text, setText] = useState("");
  const [fixError, setFixError] = useState<string | null>(null);
  const who = vaName === "your assistant" ? "Your assistant" : vaName;

  if (items.length === 0) return null;

  async function answer(fact: Fact, kind: "yes" | "fix" | "no", statement?: string): Promise<boolean> {
    setBusy(`${fact.id}:${kind}`);
    try {
      const res = await rpc<{ verdict: string; suggested_tasks: number }>("answerFact", { fact_id: fact.id, answer: kind, statement });
      await onChanged();
      const extra = res.suggested_tasks ? " A follow-up is suggested under Requests." : "";
      const done = kind === "no" ? `Removed. ${who} will see you said it is not true.` : `Added to your deal status.${extra}`;
      toast(done, {
        action: {
          label: "Undo",
          run: async () => {
            try {
              await rpc("answerFact", { fact_id: fact.id, answer: "undo" });
            } catch (err) {
              toast((err as Error).message, { tone: "error" });
            }
            await onChanged();
          },
        },
      });
      return true;
    } catch (err) {
      if (kind === "fix") setFixError((err as Error).message);
      else toast((err as Error).message, { tone: "error" });
      if (err instanceof ApiError && err.status === 409) await onChanged();
      return false;
    } finally {
      setBusy(null);
    }
  }

  function openFix(fact: Fact) {
    setText(fact.statement);
    setFixError(null);
    setFixing(fact);
  }

  async function saveFix() {
    if (!fixing) return;
    const value = text.trim();
    if (!value) {
      setFixError("Write what is true, or close this and choose Not true.");
      return;
    }
    if (await answer(fixing, "fix", value)) setFixing(null);
  }

  return (
    <div id="to-confirm" data-tour="to-confirm" className="scroll-mt-4 rounded-xl border border-[#f0d9a8] bg-white px-4 pt-3">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-warn">
        <CircleHelp className="h-3.5 w-3.5" />
        Can you confirm? ({items.length})
      </div>
      <p className="mt-1 text-[13px] text-ink-2">
        {who} could not tell {items.length === 1 ? "this" : "these"} for sure from your conversations. {preview ? "The user answers here." : "Your answer goes into your deal status."}
      </p>
      <div className="divide-y divide-line">
        {items.map((f) => (
          <div key={f.id} className="pb-3">
            <div className="pt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{SECTIONS.find((s) => s.key === f.section)?.label}</div>
            <div className="-mt-3">
              <FactRow fact={f} tz={tz} />
            </div>
            {preview ? null : (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="primary" busy={busy === `${f.id}:yes`} disabled={!!busy} onClick={() => void answer(f, "yes")}>
                  Yes, correct
                </Button>
                <Button size="sm" disabled={!!busy} onClick={() => openFix(f)}>
                  Fix it
                </Button>
                <Button size="sm" variant="ghost" busy={busy === `${f.id}:no`} disabled={!!busy} onClick={() => void answer(f, "no")}>
                  Not true
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
      <Modal
        open={!!fixing}
        onClose={() => setFixing(null)}
        title="Fix this item"
        footer={
          <>
            <Button onClick={() => setFixing(null)}>Cancel</Button>
            <Button variant="primary" busy={!!busy} onClick={() => void saveFix()}>
              Save
            </Button>
          </>
        }
      >
        <Field label="What is true" error={fixError} hint={`${text.length}/${MAX}`}>
          <Textarea
            autoFocus
            rows={3}
            maxLength={MAX}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setFixError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void saveFix();
            }}
          />
        </Field>
      </Modal>
    </div>
  );
}
