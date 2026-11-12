"use client";
import { useState } from "react";
import { BadgeCheck, CalendarClock, ChevronDown, Quote } from "lucide-react";
import { clock, dateOnly, plainDate } from "@/lib/client/format";
import { SECTIONS, type Fact } from "@/lib/types";
import { Badge, Button, cx } from "./ui";

export function FactRow({ fact, tz, action }: { fact: Fact; tz?: string; action?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium leading-snug">{fact.statement}</p>
          {fact.change_type === "changed" ? (
            <Badge tone="warn" className="mt-1.5 !whitespace-normal">
              Changed{fact.changed_from ? ` from ${fact.changed_from}` : ""}
            </Badge>
          ) : null}
          {fact.follow_up_date || fact.follow_up_condition ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-[13px] text-ink-2">
              <CalendarClock className="h-3.5 w-3.5 text-ink-3" />
              Follow up{fact.follow_up_date ? ` on ${plainDate(fact.follow_up_date)}` : ""}
              {fact.follow_up_condition ? `${fact.follow_up_date ? ", or once: " : ": "}${fact.follow_up_condition}` : ""}
            </p>
          ) : null}
        </div>
        {action}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {fact.evidence.length ? (
          <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="inline-flex h-7 items-center gap-1 rounded-full border border-line px-2.5 text-xs text-accent hover:bg-accent-soft">
            <Quote className="h-3 w-3" />
            {fact.event_title ?? "Source"}
            {fact.event_occurred_at ? `, ${dateOnly(fact.event_occurred_at, tz)}` : ""}
            <ChevronDown className={cx("h-3 w-3 transition-transform", open && "rotate-180")} />
          </button>
        ) : null}
        {fact.verdict !== "insufficient" ? (
          <span className="inline-flex items-center gap-1 text-xs text-ok">
            <BadgeCheck className="h-3.5 w-3.5" />
            Verified{fact.verified_by_name ? ` by ${fact.verified_by_name.split(" ")[0]}` : ""}
          </span>
        ) : null}
      </div>
      {open ? (
        <div className="mt-2 space-y-1.5">
          {fact.evidence.map((ev, i) => (
            <blockquote key={i} className="rounded-lg bg-page px-3 py-2 text-[13px] text-ink-2">
              <span className="font-medium text-ink">{ev.speaker}</span>
              {ev.start_ms !== null ? <span className="ml-1.5 font-mono text-xs text-ink-3">{clock(ev.start_ms)}</span> : null}
              <span className="block">{ev.quote}</span>
            </blockquote>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Verified facts grouped by section. Shared by the VA profile, the agent view, and the share page. */
export function DealFacts({ facts, tz, onResolve }: { facts: Fact[]; tz?: string; onResolve?: (fact: Fact) => void }) {
  return (
    <div className="space-y-4">
      {SECTIONS.map((s) => {
        const rows = facts.filter((f) => f.section === s.key);
        if (rows.length === 0) return null;
        return (
          <section key={s.key} className="rounded-xl border border-line bg-white px-4 pt-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-3">{s.label}</h3>
            <div className="divide-y divide-line">
              {rows.map((f) => (
                <FactRow
                  key={f.id}
                  fact={f}
                  tz={tz}
                  action={
                    onResolve && (s.key === "questions" || s.key === "next_steps" || s.key === "risks") ? (
                      <Button size="sm" variant="ghost" onClick={() => onResolve(f)}>
                        {s.key === "next_steps" ? "Mark done" : "Mark resolved"}
                      </Button>
                    ) : null
                  }
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function profileNote(clientName: string, facts: Fact[], verified: { at: string; by: string } | null, tz?: string): string {
  const lines: string[] = [`${clientName}: deal profile from Notique`];
  if (verified) lines.push(`Verified by ${verified.by} on ${dateOnly(verified.at, tz)}`);
  for (const s of SECTIONS) {
    const rows = facts.filter((f) => f.section === s.key);
    if (rows.length === 0) continue;
    lines.push("", `${s.label}:`);
    rows.forEach((f, i) => {
      const follow = f.follow_up_date ? ` (follow up ${plainDate(f.follow_up_date)})` : f.follow_up_condition ? ` (follow up when ${f.follow_up_condition})` : "";
      lines.push(`${i + 1}. ${f.statement}${follow}`);
    });
  }
  return lines.join("\n");
}
