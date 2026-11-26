"use client";
import { useEffect, useRef, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import { rpc } from "@/lib/client/api";
import { ago } from "@/lib/client/format";
import type { TaskDraft } from "@/lib/types";
import { Button, Input, Spinner, Textarea, useToast } from "../ui";

/**
 * AI first draft of the deliverable. The VA edits it here and saves it as a deliverable.
 * The user never sees this panel or its text until the VA delivers.
 */
export function DraftPanel({ taskId, draft, open, onSaved, onChanged }: { taskId: string; draft: TaskDraft | null; open: boolean; onSaved: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const dirty = useRef(false);
  const [replace, setReplace] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const pending = useRef<{ taskId: string; body: string } | null>(null);
  const timer = useRef<number | null>(null);
  const stamp = draft?.status === "ready" ? draft.updated_at : null;

  // Edits are kept on the server about a second after typing stops, and right away when leaving.
  const flush = useRef(async () => {});
  flush.current = async () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    const job = pending.current;
    if (!job) return;
    pending.current = null;
    setSaveState("saving");
    try {
      await rpc("saveDraftText", { task_id: job.taskId, body: job.body });
      setSaveState("saved");
    } catch {
      setSaveState("failed");
    }
  };
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!pending.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      void flush.current();
    };
  }, [taskId]);

  // Load a new draft into the editor, but never over text the VA is changing.
  useEffect(() => {
    dirty.current = false;
    setSaveState("idle");
  }, [taskId]);
  useEffect(() => {
    if (!dirty.current && draft?.status === "ready") {
      setText(draft.body ?? "");
      // Edits saved earlier, even in another visit, count as the VA's work: writing again must ask first.
      if (draft.edited_at) dirty.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, stamp]);

  // While the draft is being written, look again every few seconds.
  const working = draft?.status === "working";
  const changed = useRef(onChanged);
  useEffect(() => {
    changed.current = onChanged;
  });
  useEffect(() => {
    if (!working) return;
    const id = window.setInterval(() => changed.current(), 4000);
    return () => window.clearInterval(id);
  }, [working]);

  if (!open) return null;
  const label = "text-xs font-semibold uppercase tracking-wide text-ink-3";

  async function redraft() {
    // Edits in the box are only replaced after a second, deliberate click.
    if (dirty.current && !replace) return setReplace(true);
    setReplace(false);
    setBusy("redraft");
    try {
      dirty.current = false;
      await rpc("redraftTask", { task_id: taskId, instructions });
      setInstructions("");
      onChanged();
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!text.trim()) return toast("The draft is empty.", { tone: "error" });
    if (/\[(ADD|NEEDS?)[:\]]/i.test(text)) return toast("There are still bracketed placeholders in the text. Fill them in or remove them first.", { tone: "error" });
    setBusy("save");
    try {
      await rpc("saveTextDeliverable", { task_id: taskId, text });
      dirty.current = false;
      toast("Saved under Deliverables. Nothing is sent yet. The user sees it once you mark the ticket delivered.");
      onSaved();
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className={`${label} flex items-center gap-1.5`}>
          <Sparkles className="h-3.5 w-3.5" /> AI first draft
        </h3>
        {draft?.status === "ready" ? <span className="text-xs text-ink-3">Written {ago(draft.updated_at).toLowerCase()} from the verified deal profile</span> : null}
      </div>

      {!draft ? <p className="mt-2 text-[13px] text-ink-3">No draft yet. Ask for one below.</p> : null}
      {working ? (
        <div className="mt-2 flex items-center gap-2 text-[13px] text-ink-3">
          <Spinner /> Writing a first draft from what has been verified for this client.
        </div>
      ) : null}
      {draft?.status === "failed" ? <p className="mt-2 text-[13px] text-bad">The draft could not be written: {draft.error}</p> : null}

      {draft?.status === "ready" ? (
        <>
          {draft.gaps.length ? (
            <div className="mt-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-ink-2">
              <div className="font-medium text-ink">Before you deliver, look up or confirm</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {draft.gaps.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <Textarea
            className="mt-2 font-[450]"
            rows={12}
            aria-label="Draft deliverable"
            value={text}
            onChange={(e) => {
              dirty.current = true;
              setText(e.target.value);
              pending.current = { taskId, body: e.target.value };
              setSaveState("idle");
              if (timer.current) window.clearTimeout(timer.current);
              timer.current = window.setTimeout(() => void flush.current(), 1200);
            }}
            onBlur={() => void flush.current()}
          />
          <div className="mt-1 h-4 text-xs text-ink-3" aria-live="polite">
            {saveState === "saving" ? "Saving your edits" : saveState === "saved" ? "Your edits are saved" : saveState === "failed" ? <span className="text-bad">Your edits could not be saved. Copy them somewhere safe and reload.</span> : null}
          </div>
          <p className="mt-1.5 text-xs text-ink-3">Written by AI and not reviewed. The user cannot see it. Check every fact, finish it, then save it to Deliverables below.</p>
        </>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input className="!h-9 min-w-0 flex-1" aria-label="Instruction for a new draft" placeholder="Optional: shorter, as a text message, lead with the price drop" value={instructions} maxLength={400} onChange={(e) => setInstructions(e.target.value)} />
        <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} busy={busy === "redraft"} disabled={working} onClick={redraft}>
          {replace ? "Replace my edits" : draft ? "Write again" : "Write a draft"}
        </Button>
        {draft?.status === "ready" ? (
          <Button size="sm" variant="primary" busy={busy === "save"} onClick={save}>
            Save to deliverables
          </Button>
        ) : null}
      </div>
    </div>
  );
}
