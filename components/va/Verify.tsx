"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, CircleHelp, Flag, Pencil, Plus, Quote, RotateCcw, Search, Timer, Trash2, X } from "lucide-react";
import { rpc } from "@/lib/client/api";
import { SOURCE_LABEL, clock, dateTime, plainDate, remaining } from "@/lib/client/format";
import { SECTIONS, TASK_CATEGORIES, type EventChecks, type EventDetail, type Fact, type Section, type SuggestedTask, type Verdict } from "@/lib/types";
import { Badge, Button, ErrorNote, Field, IconButton, Input, Kbd, Modal, Select, Spinner, Textarea, cx, useToast } from "../ui";
import type { VaNav } from "./Console";

const CHECKS: { key: keyof EventChecks; label: string; help: string }[] = [
  { key: "consent", label: "Consent heard", help: "Everyone on the recording was told it is being recorded, or this source does not need consent (notes, texts)." },
  { key: "pii", label: "Personal data masked", help: "No SSN, bank, or card numbers appear in any approved item." },
  { key: "fair_housing", label: "Fair housing safe", help: "No approved item mentions race, religion, family status, disability, or other protected traits." },
  { key: "type_match", label: "Matches the project", help: "This conversation is about this client and this deal." },
];

const VERDICT_LABEL: Record<Verdict, string> = { pending: "To decide", approved: "Approved", edited: "Edited", declined: "Declined", insufficient: "Needs agent input" };
const VERDICT_TONE: Record<Verdict, "neutral" | "ok" | "accent" | "bad" | "warn"> = { pending: "neutral", approved: "ok", edited: "accent", declined: "bad", insufficient: "warn" };

function confidenceLabel(c: number | null): { text: string; tone: "ok" | "warn" | "bad" } | null {
  if (c === null) return null;
  const pct = Math.round(c * 100);
  if (c >= 0.8) return { text: `High confidence ${pct}%`, tone: "ok" };
  if (c >= 0.6) return { text: `Medium confidence ${pct}%`, tone: "warn" };
  return { text: `Low confidence ${pct}%`, tone: "bad" };
}

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable;
}

interface Draft {
  statement: string;
  follow_up_date: string;
  follow_up_condition: string;
  withTask: boolean;
  task: SuggestedTask;
}

function toDraft(f: Fact): Draft {
  return {
    statement: f.statement,
    follow_up_date: f.follow_up_date ?? "",
    follow_up_condition: f.follow_up_condition ?? "",
    withTask: !!f.suggested_task,
    task: f.suggested_task ?? { title: "", description: "", category: "Research", est_minutes: null },
  };
}

export function Verify({ nav, eventId }: { nav: VaNav; eventId: string }) {
  const toast = useToast();
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [adding, setAdding] = useState<{ section: Section; statement: string } | null>(null);
  const [search, setSearch] = useState("");
  const [hot, setHot] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [escalate, setEscalate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const unsent = useRef(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await rpc<EventDetail>("getEvent", { event_id: eventId });
      setDetail(data);
      setError(null);
      setFocusId((cur) => cur ?? data.facts.find((f) => f.verdict === "pending")?.id ?? data.facts[0]?.id ?? null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [eventId]);

  useEffect(() => {
    setDetail(null);
    setFocusId(null);
    setEditId(null);
    setSelected([]);
    setElapsed(0);
    unsent.current = 0;
    load();
  }, [load]);

  const loadedId = detail?.event.id;
  useEffect(() => {
    if (!loadedId) return;
    const first = document.querySelector<HTMLElement>("[data-pending-fact]");
    first?.scrollIntoView({ block: "center" });
  }, [loadedId]);

  const event = detail?.event;
  const readOnly = !event || !["ready", "in_review"].includes(event.status);
  const tz = nav.agent.timezone;

  /* Review timer. Counts only while this tab is visible. */
  useEffect(() => {
    if (readOnly) return;
    const tick = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      unsent.current += 1000;
      setElapsed((v) => v + 1000);
    }, 1000);
    const flush = () => {
      const ms = unsent.current;
      if (ms < 1000) return;
      unsent.current = 0;
      rpc("updateEventMeta", { event_id: eventId, add_ms: ms }).catch(() => {
        unsent.current += ms;
      });
    };
    const push = window.setInterval(flush, 30000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(push);
      flush();
    };
  }, [readOnly, eventId]);

  const facts = useMemo(() => {
    const order = SECTIONS.map((s) => s.key);
    return [...(detail?.facts ?? [])].sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section) || a.position - b.position || a.created_at.localeCompare(b.created_at));
  }, [detail?.facts]);
  const pending = facts.filter((f) => f.verdict === "pending").length;
  const checks = event?.checks ?? {};
  const checksDone = CHECKS.every((c) => checks[c.key]);
  const speakerMap = event?.speaker_map ?? {};
  const nameOf = (raw: string) => speakerMap[raw] || raw;
  const speakers = useMemo(() => Array.from(new Set((detail?.lines ?? []).map((l) => l.speaker))).slice(0, 8), [detail?.lines]);

  function patchFact(next: Fact) {
    setDetail((d) => (d ? { ...d, facts: d.facts.map((f) => (f.id === next.id ? { ...f, ...next } : f)) } : d));
  }

  function focusNextPending(afterId: string) {
    const index = facts.findIndex((f) => f.id === afterId);
    const rest = [...facts.slice(index + 1), ...facts.slice(0, index)];
    const next = rest.find((f) => f.verdict === "pending");
    if (next) {
      setFocusId(next.id);
      document.getElementById(`fact-${next.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  async function decide(fact: Fact, verdict: Verdict, extra: Record<string, unknown> = {}) {
    if (readOnly) return;
    if (verdict === "approved" && fact.origin === "ai" && fact.confidence !== null && fact.confidence < 0.6) {
      toast("Low confidence. Edit the wording to confirm it, decline it, or mark it as needing agent input.", { tone: "error" });
      return;
    }
    const before = fact;
    patchFact({ ...fact, verdict, ...(verdict === "edited" && typeof extra.statement === "string" ? { statement: extra.statement } : {}) });
    try {
      const saved = await rpc<Fact>("setVerdict", { fact_id: fact.id, verdict, ...extra });
      patchFact(saved);
      if (verdict !== "pending") focusNextPending(fact.id);
    } catch (err) {
      patchFact(before);
      toast((err as Error).message, { tone: "error" });
    }
  }

  function startEdit(fact: Fact) {
    if (readOnly) return;
    setFocusId(fact.id);
    setEditId(fact.id);
    setDraft(toDraft(fact));
  }

  async function saveEdit(fact: Fact) {
    if (!draft) return;
    if (!draft.statement.trim()) return toast("The statement cannot be empty.", { tone: "error" });
    const canTask = fact.section === "questions" || fact.section === "next_steps";
    if (canTask && draft.withTask && !draft.task.title.trim()) return toast("Give the suggested task a title, or untick it.", { tone: "error" });
    const unchanged = draft.statement.trim() === (fact.ai_statement ?? fact.statement).trim();
    setEditId(null);
    await decide(fact, unchanged && fact.origin === "ai" && (fact.confidence ?? 1) >= 0.6 ? "approved" : "edited", {
      statement: draft.statement.trim(),
      follow_up_date: draft.follow_up_date || null,
      follow_up_condition: draft.follow_up_condition || null,
      suggested_task: canTask && draft.withTask ? draft.task : null,
    });
  }

  function jump(lineId: string, startMs: number | null) {
    setHot(lineId);
    document.getElementById(`line-${lineId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    if (startMs !== null && audioRef.current) {
      audioRef.current.currentTime = startMs / 1000;
    }
    window.setTimeout(() => setHot((cur) => (cur === lineId ? null : cur)), 1800);
  }

  async function setCheck(key: keyof EventChecks, value: boolean) {
    if (!detail || readOnly) return;
    const next = { ...checks, [key]: value };
    setDetail({ ...detail, event: { ...detail.event, checks: next } });
    try {
      await rpc("updateEventMeta", { event_id: eventId, checks: { [key]: value } });
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
      load();
    }
  }

  async function renameSpeaker(raw: string, name: string) {
    setRenaming(null);
    if (!detail) return;
    const next = { ...speakerMap };
    if (name.trim()) next[raw] = name.trim();
    else delete next[raw];
    setDetail({ ...detail, event: { ...detail.event, speaker_map: next } });
    try {
      await rpc("updateEventMeta", { event_id: eventId, speaker_map: next });
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    }
  }

  async function addFact() {
    if (!adding || !detail) return;
    if (!adding.statement.trim()) return toast("Write the fact in one sentence.", { tone: "error" });
    setBusy(true);
    try {
      const fact = await rpc<Fact>("addFact", { event_id: eventId, section: adding.section, statement: adding.statement, line_ids: selected });
      setDetail({ ...detail, facts: [...detail.facts, fact] });
      setAdding(null);
      setSelected([]);
      setFocusId(fact.id);
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function removeFact(fact: Fact) {
    if (!detail) return;
    setDetail({ ...detail, facts: detail.facts.filter((f) => f.id !== fact.id) });
    try {
      await rpc("deleteFact", { fact_id: fact.id });
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
      load();
    }
  }

  async function submit() {
    setBusy(true);
    try {
      const res = await rpc<{ suggested_tasks: number; accepted: number }>("submitEvent", { event_id: eventId });
      toast(`Submitted. ${res.accepted} ${res.accepted === 1 ? "fact" : "facts"} published${res.suggested_tasks ? `, ${res.suggested_tasks} ${res.suggested_tasks === 1 ? "task" : "tasks"} suggested to the agent` : ""}.`);
      nav.refreshCounts();
      nav.go("queue");
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  }

  async function doEscalate() {
    if (!escalate?.trim()) return toast("Say why this cannot be verified.", { tone: "error" });
    setBusy(true);
    try {
      await rpc("escalateEvent", { event_id: eventId, note: escalate });
      toast("Escalated. It stays out of the agent's view until someone returns it to the queue.");
      nav.refreshCounts();
      nav.go("queue");
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function reopen() {
    setBusy(true);
    try {
      await rpc("reopenEvent", { event_id: eventId });
      await load();
      nav.refreshCounts();
    } catch (err) {
      toast((err as Error).message, { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  /* Keyboard shortcuts. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector("[data-modal]")) return;
      if (typing(e.target)) {
        if (e.key === "Escape") (e.target as HTMLElement).blur();
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (key === "?") {
        setShowKeys(true);
        return;
      }
      if (facts.length === 0) return;
      const index = Math.max(0, facts.findIndex((f) => f.id === focusId));
      const current = facts[index];
      if (key === "j" || key === "arrowdown" || key === "k" || key === "arrowup") {
        e.preventDefault();
        const next = facts[Math.min(facts.length - 1, Math.max(0, index + (key === "j" || key === "arrowdown" ? 1 : -1)))];
        setFocusId(next.id);
        document.getElementById(`fact-${next.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        return;
      }
      if (readOnly || !current || editId) return;
      if (key === "a") decide(current, "approved");
      else if (key === "d") decide(current, "declined");
      else if (key === "i") decide(current, "insufficient");
      else if (key === "u") decide(current, "pending");
      else if (key === "e") {
        e.preventDefault();
        startEdit(current);
      } else if (key === "enter" && !["BUTTON", "A", "SUMMARY"].includes((e.target as HTMLElement)?.tagName) && current.evidence[0]) jump(current.evidence[0].line_id, current.evidence[0].start_ms);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (error && !detail) {
    return (
      <div className="mx-auto max-w-md p-6">
        <ErrorNote message={error} onRetry={load} />
        <Button className="mt-4" onClick={() => nav.go("queue")}>
          Back to queue
        </Button>
      </div>
    );
  }
  if (!detail || !event) return <Spinner label="Opening event" />;

  const due = remaining(event.due_at);
  const needle = search.trim().toLowerCase();
  const matches = needle ? detail.lines.filter((l) => l.text.toLowerCase().includes(needle)).length : 0;
  const counts = {
    approved: facts.filter((f) => f.verdict === "approved").length,
    edited: facts.filter((f) => f.verdict === "edited").length,
    declined: facts.filter((f) => f.verdict === "declined").length,
    insufficient: facts.filter((f) => f.verdict === "insufficient").length,
    tasks: facts.filter((f) => (f.verdict === "approved" || f.verdict === "edited") && f.suggested_task && (f.section === "questions" || f.section === "next_steps")).length,
  };

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      {/* Header */}
      <div className="border-b border-line bg-white px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <IconButton label="Back to queue" onClick={() => nav.go("queue")}>
            <ArrowLeft className="h-4 w-4" />
          </IconButton>
          <div className="min-w-[60%] flex-1 sm:min-w-0">
            <h1 className="truncate text-base font-semibold">{event.title}</h1>
            <div className="truncate text-xs text-ink-3">
              <button className="text-accent hover:underline" onClick={() => nav.go("project", { id: detail.project.id, tab: "profile" })}>
                {detail.project.client_name}
              </button>
              {", "}
              {SOURCE_LABEL[event.source]}, {dateTime(event.occurred_at, tz)}
              {!readOnly && detail.position.total > 0 ? `, ${detail.position.index} of ${detail.position.total} in queue` : ""}
            </div>
          </div>
          {!readOnly && due ? <Badge tone={due.tone === "late" ? "bad" : due.tone === "soon" ? "warn" : "neutral"}>Due {dateTime(event.due_at, tz)}, {due.text.toLowerCase()}</Badge> : null}
          {!readOnly ? (
            <Badge>
              <Timer className="h-3 w-3" />
              {clock(event.review_ms + elapsed)}
            </Badge>
          ) : null}
          <IconButton label="Keyboard shortcuts" onClick={() => setShowKeys(true)}>
            <CircleHelp className="h-4 w-4" />
          </IconButton>
        </div>
        {event.status === "submitted" ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-ok-soft px-3 py-2 text-[13px] text-ok">
            <Check className="h-4 w-4" />
            <span className="flex-1">Submitted {dateTime(event.submitted_at, tz)}. The agent can see the approved facts.</span>
            {detail.canReopen ? (
              <Button size="sm" busy={busy} onClick={reopen}>
                Reopen to edit
              </Button>
            ) : (
              <span className="text-ink-3">Reopening closes 24 hours after submission.</span>
            )}
          </div>
        ) : event.status === "escalated" ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
            <Flag className="h-4 w-4" />
            <span className="flex-1">Escalated: {event.escalation_note}</span>
            <Button size="sm" busy={busy} onClick={reopen}>
              Return to queue
            </Button>
          </div>
        ) : event.status === "failed" || event.status === "processing" || event.status === "extracting" ? (
          <ErrorNote className="mt-3" message={event.status === "failed" ? event.error ?? "Processing failed. Retry it from the queue." : "This event is still being prepared. Go back to the queue and it will appear when ready."} />
        ) : (
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
            {CHECKS.map((c) => (
              <label key={c.key} className="flex items-center gap-2 text-[13px]" title={c.help}>
                <input type="checkbox" className="h-4 w-4 accent-[#177245]" checked={!!checks[c.key]} onChange={(e) => setCheck(c.key, e.target.checked)} />
                <span className={checks[c.key] ? "text-ink" : "text-ink-2"}>{c.label}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,2fr)_minmax(0,3fr)] lg:grid-cols-2 lg:grid-rows-1">
        {/* Transcript */}
        <section aria-label="Transcript" className="flex min-h-0 flex-col border-b border-line bg-white lg:border-b-0 lg:border-r">
          <div className="space-y-2 border-b border-line px-4 py-2.5">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ink-3" />
                <Input ref={searchRef} aria-label="Search transcript" className="!pl-8" placeholder="Search transcript" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              {needle ? <span className="text-xs text-ink-3">{matches} {matches === 1 ? "match" : "matches"}</span> : null}
            </div>
            {speakers.length ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {speakers.map((raw) =>
                  renaming === raw ? (
                    <Input
                      key={raw}
                      autoFocus
                      aria-label={`Name for ${raw}`}
                      defaultValue={speakerMap[raw] ?? ""}
                      placeholder={raw}
                      className="!h-7 !w-36 !text-xs"
                      onBlur={(e) => renameSpeaker(raw, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                    />
                  ) : (
                    <button key={raw} disabled={readOnly} onClick={() => setRenaming(raw)} title="Rename this speaker" className="inline-flex h-7 items-center gap-1 rounded-full border border-line px-2.5 text-xs text-ink-2 hover:bg-page">
                      {speakerMap[raw] && speakerMap[raw] !== raw ? (
                        <>
                          <span className="text-ink-3">{raw} =</span> <span className="font-medium text-ink">{speakerMap[raw]}</span>
                        </>
                      ) : (
                        raw
                      )}
                      {!readOnly ? <Pencil className="h-3 w-3 text-ink-3" /> : null}
                    </button>
                  ),
                )}
              </div>
            ) : null}
            {detail.audioUrl ? <audio ref={audioRef} controls preload="none" src={detail.audioUrl} className="h-9 w-full" /> : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {detail.lines.length === 0 ? <p className="p-4 text-[13px] text-ink-3">This event has no transcript.</p> : null}
            {detail.lines.map((l) => {
              const isSelected = selected.includes(l.id);
              const dim = needle && !l.text.toLowerCase().includes(needle);
              return (
                <div
                  key={l.id}
                  id={`line-${l.id}`}
                  className={cx("group flex gap-2 rounded-md px-2 py-1.5", hot === l.id && "flash", isSelected && "bg-accent-soft", dim && "opacity-35")}
                >
                  {!readOnly ? (
                    <input
                      type="checkbox"
                      aria-label={`Select line ${l.idx + 1}`}
                      className={cx("mt-1 h-3.5 w-3.5 shrink-0 accent-[#4b75f2]", isSelected ? "" : "opacity-0 focus:opacity-100 group-hover:opacity-100")}
                      checked={isSelected}
                      onChange={(e) => setSelected((cur) => (e.target.checked ? [...cur, l.id].slice(-4) : cur.filter((id) => id !== l.id)))}
                    />
                  ) : null}
                  <div className="min-w-0 flex-1 text-sm">
                    <div className="flex items-baseline gap-2 text-xs">
                      <span className="font-semibold text-ink-2">{nameOf(l.speaker)}</span>
                      {l.start_ms !== null ? (
                        <button
                          className="font-mono text-ink-3 hover:text-accent"
                          title={detail.audioUrl ? "Play from here" : undefined}
                          onClick={() => {
                            if (audioRef.current) {
                              audioRef.current.currentTime = (l.start_ms ?? 0) / 1000;
                              audioRef.current.play().catch(() => {});
                            }
                          }}
                        >
                          {clock(l.start_ms)}
                        </button>
                      ) : null}
                    </div>
                    <div className="text-ink">{l.text}</div>
                  </div>
                </div>
              );
            })}
          </div>
          {!readOnly ? (
            <div className="border-t border-line px-4 py-2.5">
              {adding ? (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <Select aria-label="Section" className="!w-44" value={adding.section} onChange={(e) => setAdding({ ...adding, section: e.target.value as Section })}>
                      {SECTIONS.map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.label}
                        </option>
                      ))}
                    </Select>
                    <Input autoFocus aria-label="Fact" placeholder="State the fact in one sentence" value={adding.statement} onChange={(e) => setAdding({ ...adding, statement: e.target.value })} onKeyDown={(e) => e.key === "Enter" && addFact()} />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button size="sm" onClick={() => setAdding(null)}>
                      Cancel
                    </Button>
                    <Button size="sm" variant="primary" busy={busy} onClick={addFact}>
                      Add fact
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <span className="hidden text-[13px] text-ink-3 sm:inline">{selected.length ? `${selected.length} ${selected.length === 1 ? "line" : "lines"} selected` : "Did the AI miss something? Tick up to four lines that prove it."}</span>
                  <div className="flex gap-2">
                    {selected.length ? (
                      <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                        Clear
                      </Button>
                    ) : null}
                    <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} disabled={selected.length === 0} onClick={() => setAdding({ section: "decisions", statement: "" })}>
                      Add fact from selection
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </section>

        {/* Facts */}
        <section aria-label="Items to verify" className="flex min-h-0 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {event.summary ? <p className="mb-3 rounded-lg bg-white px-3 py-2 text-[13px] text-ink-2 ring-1 ring-line">{event.summary}</p> : null}
            {facts.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line-strong bg-white p-6 text-center">
                <div className="font-semibold">The AI found nothing to verify</div>
                <p className="mx-auto mt-1 max-w-sm text-[13px] text-ink-3">Skim the transcript. If something matters, tick the lines and add a fact. If nothing does, confirm the checks and submit.</p>
              </div>
            ) : null}
            {SECTIONS.map((s) => {
              const rows = facts.filter((f) => f.section === s.key);
              if (rows.length === 0) return null;
              return (
                <div key={s.key} className="mb-4">
                  <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">
                    {s.label} ({rows.length})
                  </h2>
                  <div className="space-y-2">
                    {rows.map((f) => {
                      const focused = f.id === focusId;
                      const conf = f.origin === "ai" ? confidenceLabel(f.confidence) : null;
                      const editing = editId === f.id && draft;
                      const canTask = f.section === "questions" || f.section === "next_steps";
                      const done = f.verdict !== "pending";
                      return (
                        <div
                          key={f.id}
                          id={`fact-${f.id}`}
                          data-pending-fact={!done ? "" : undefined}
                          onClick={() => setFocusId(f.id)}
                          className={cx("rounded-xl border bg-white p-3.5 transition-shadow", focused ? "border-accent shadow-[0_0_0_3px_rgba(75,117,242,0.15)]" : "border-line", done && !editing && f.verdict === "declined" && "opacity-60")}
                        >
                          <div className="flex flex-wrap items-center gap-1.5">
                            {f.origin === "va" ? <Badge tone="dark">Added by you</Badge> : f.change_type === "changed" ? <Badge tone="warn">Changed{f.changed_from ? ` from ${f.changed_from}` : ""}</Badge> : <Badge>New</Badge>}
                            {conf ? <Badge tone={conf.tone}>{conf.text}</Badge> : null}
                            {done ? <Badge tone={VERDICT_TONE[f.verdict]}>{VERDICT_LABEL[f.verdict]}</Badge> : null}
                          </div>

                          {editing ? (
                            <div className="mt-2.5 space-y-3">
                              <Textarea autoFocus rows={2} aria-label="Statement" value={draft.statement} onChange={(e) => setDraft({ ...draft, statement: e.target.value })} onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && saveEdit(f)} />
                              <div className="grid gap-3 sm:grid-cols-2">
                                <Field label="Follow up on" hint="Optional date">
                                  <Input type="date" value={draft.follow_up_date} onChange={(e) => setDraft({ ...draft, follow_up_date: e.target.value })} />
                                </Field>
                                <Field label="Or follow up when" hint="Optional condition">
                                  <Input placeholder="Lender sends pre-approval" value={draft.follow_up_condition} onChange={(e) => setDraft({ ...draft, follow_up_condition: e.target.value })} />
                                </Field>
                              </div>
                              {canTask ? (
                                <div className="rounded-lg bg-page p-3">
                                  <label className="flex items-center gap-2 text-[13px] font-medium">
                                    <input type="checkbox" className="h-4 w-4 accent-[#0d0d0d]" checked={draft.withTask} onChange={(e) => setDraft({ ...draft, withTask: e.target.checked })} />
                                    Suggest a task to the agent
                                  </label>
                                  {draft.withTask ? (
                                    <div className="mt-2 space-y-2">
                                      <Input aria-label="Task title" placeholder="Compare HOA fees for the three shortlisted condos" value={draft.task.title} onChange={(e) => setDraft({ ...draft, task: { ...draft.task, title: e.target.value } })} />
                                      <Textarea rows={2} aria-label="Task description" placeholder="What the deliverable should contain" value={draft.task.description} onChange={(e) => setDraft({ ...draft, task: { ...draft.task, description: e.target.value } })} />
                                      <Select aria-label="Category" value={draft.task.category} onChange={(e) => setDraft({ ...draft, task: { ...draft.task, category: e.target.value } })}>
                                        {TASK_CATEGORIES.map((c) => (
                                          <option key={c}>{c}</option>
                                        ))}
                                      </Select>
                                    </div>
                                  ) : null}
                                </div>
                              ) : null}
                              <div className="flex justify-end gap-2">
                                <Button size="sm" onClick={() => setEditId(null)}>
                                  Cancel
                                </Button>
                                <Button size="sm" variant="primary" onClick={() => saveEdit(f)}>
                                  Save and approve
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <p className={cx("mt-2 text-[15px] font-medium leading-snug", f.verdict === "declined" && "line-through")}>{f.statement}</p>
                              {f.verdict === "edited" && f.ai_statement && f.ai_statement !== f.statement ? <p className="mt-1 text-xs text-ink-3">AI draft: {f.ai_statement}</p> : null}
                              {f.follow_up_date || f.follow_up_condition ? (
                                <p className="mt-1.5 text-[13px] text-ink-2">
                                  Follow up {f.follow_up_date ? `on ${plainDate(f.follow_up_date)}` : ""}
                                  {f.follow_up_date && f.follow_up_condition ? ", or " : ""}
                                  {f.follow_up_condition ? `when ${f.follow_up_condition}` : ""}
                                </p>
                              ) : null}
                              <div className="mt-2.5 space-y-1.5">
                                {f.evidence.map((ev) => (
                                  <button key={ev.line_id} onClick={() => jump(ev.line_id, ev.start_ms)} className="flex w-full gap-2 rounded-lg bg-page px-2.5 py-2 text-left text-[13px] text-ink-2 hover:bg-accent-soft" title="Show in transcript">
                                    <Quote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3" />
                                    <span>
                                      <span className="font-medium text-ink">{nameOf(ev.speaker)}</span>
                                      {ev.start_ms !== null ? <span className="ml-1.5 font-mono text-xs text-ink-3">{clock(ev.start_ms)}</span> : null}
                                      <span className="block">{ev.quote.length > 260 ? `${ev.quote.slice(0, 260)}...` : ev.quote}</span>
                                    </span>
                                  </button>
                                ))}
                              </div>
                              {canTask && f.suggested_task ? (
                                <p className="mt-2 rounded-lg border border-dashed border-line-strong px-2.5 py-2 text-[13px] text-ink-2">
                                  <span className="font-medium text-ink">If approved, suggests a task:</span> {f.suggested_task.title}
                                </p>
                              ) : null}

                              {!readOnly ? (
                                done ? (
                                  <div className="mt-3 flex items-center gap-2">
                                    <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => decide(f, "pending")}>
                                      Undo {focused ? <Kbd>U</Kbd> : null}
                                    </Button>
                                    {f.verdict !== "declined" ? (
                                      <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => startEdit(f)}>
                                        Edit
                                      </Button>
                                    ) : null}
                                    {f.origin === "va" ? (
                                      <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => removeFact(f)}>
                                        Remove
                                      </Button>
                                    ) : null}
                                  </div>
                                ) : (
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    <Button size="sm" variant="primary" icon={<Check className="h-3.5 w-3.5" />} onClick={() => decide(f, "approved")}>
                                      Approve {focused ? <Kbd>A</Kbd> : null}
                                    </Button>
                                    <Button size="sm" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => startEdit(f)}>
                                      Edit {focused ? <Kbd>E</Kbd> : null}
                                    </Button>
                                    <Button size="sm" icon={<X className="h-3.5 w-3.5" />} onClick={() => decide(f, "declined")} title="The AI got this wrong. It is discarded.">
                                      Decline {focused ? <Kbd>D</Kbd> : null}
                                    </Button>
                                    <Button size="sm" icon={<CircleHelp className="h-3.5 w-3.5" />} onClick={() => decide(f, "insufficient")} title="The transcript does not settle this. It is held for the agent to confirm.">
                                      Insufficient {focused ? <Kbd>I</Kbd> : null}
                                    </Button>
                                  </div>
                                )
                              ) : null}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {!readOnly ? (
            <div className="flex flex-wrap items-center gap-3 border-t border-line bg-white px-4 py-3">
              <div className="min-w-0 flex-1 text-[13px] text-ink-3">
                {facts.length - pending} of {facts.length} decided<span className="hidden sm:inline">. Saved automatically.</span>
              </div>
              <Button icon={<Flag className="h-4 w-4" />} onClick={() => setEscalate("")}>
                Escalate
              </Button>
              <Button variant="primary" disabled={pending > 0 || !checksDone} onClick={() => setConfirm(true)} title={pending > 0 ? "Decide every item first" : !checksDone ? "Confirm all four checks first" : undefined}>
                {pending > 0 ? `Submit (${pending} unresolved)` : !checksDone ? "Submit (checks missing)" : "Submit"}
              </Button>
            </div>
          ) : null}
        </section>
      </div>

      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Submit this event?"
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>Keep reviewing</Button>
            <Button variant="primary" busy={busy} onClick={submit}>
              Submit to agent
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">{nav.agent.name} will see the approved facts on {detail.project.client_name} right away.</p>
        <dl className="mt-4 divide-y divide-line rounded-lg border border-line text-sm">
          {[
            ["Published as written", counts.approved],
            ["Published with your edits", counts.edited],
            ["Declined and discarded", counts.declined],
            ["Held for agent input", counts.insufficient],
            ["Tasks suggested to the agent", counts.tasks],
          ].map(([label, value]) => (
            <div key={label as string} className="flex justify-between px-3 py-2">
              <dt className="text-ink-2">{label}</dt>
              <dd className="font-semibold">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-ink-3">You can reopen it for 24 hours if you spot a mistake.</p>
      </Modal>

      <Modal
        open={escalate !== null}
        onClose={() => setEscalate(null)}
        title="Escalate this event"
        footer={
          <>
            <Button onClick={() => setEscalate(null)}>Cancel</Button>
            <Button variant="primary" busy={busy} onClick={doEscalate}>
              Escalate
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">Use this when the event should not be verified as it is. Nothing from it reaches the agent.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {["No recording consent heard", "Wrong project or client", "Audio too poor to verify", "Contains sensitive personal data"].map((r) => (
            <button key={r} onClick={() => setEscalate(r)} className="h-8 rounded-full border border-line px-3 text-[13px] hover:bg-page">
              {r}
            </button>
          ))}
        </div>
        <Field label="Reason" className="mt-3">
          <Textarea rows={3} value={escalate ?? ""} onChange={(e) => setEscalate(e.target.value)} />
        </Field>
      </Modal>

      <Modal open={showKeys} onClose={() => setShowKeys(false)} title="Keyboard shortcuts">
        <dl className="space-y-2 text-sm">
          {[
            ["J or K", "Next or previous item"],
            ["A", "Approve"],
            ["E", "Edit, then save with Ctrl or Cmd and Enter"],
            ["D", "Decline: the AI got it wrong"],
            ["I", "Insufficient: hold for the agent to confirm"],
            ["U", "Undo the decision"],
            ["Enter", "Show the first quote in the transcript"],
            ["/", "Search the transcript"],
          ].map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-4">
              <dt>
                <Kbd>{k}</Kbd>
              </dt>
              <dd className="text-ink-2">{v}</dd>
            </div>
          ))}
        </dl>
      </Modal>
    </div>
  );
}
