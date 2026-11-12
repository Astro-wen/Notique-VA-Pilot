"use client";
import { useEffect, useState } from "react";
import { CheckCircle2, ClipboardList, FileAudio, Inbox, ListChecks, MessageSquare, ShieldCheck, Sparkles, Users } from "lucide-react";
import { rpc } from "@/lib/client/api";
import type { Role } from "@/lib/types";
import { useSession } from "./Session";
import { Button, cx } from "./ui";

interface Step {
  icon: React.ReactNode;
  title: string;
  body: string;
  points?: string[];
}

export const TOUR_STEPS: Record<Role, Step[]> = {
  va: [
    {
      icon: <Inbox className="h-6 w-6" />,
      title: "Your queue is the starting point",
      body: "Every conversation an agent records or uploads lands in Queue, sorted by what is due first.",
      points: ["Pick the agent you are serving at the top of the screen", "Missing a source? Add it yourself under Data sources"],
    },
    {
      icon: <ShieldCheck className="h-6 w-6" />,
      title: "Check each AI draft against the transcript",
      body: "Open an event and decide on every item. Click a quote to jump to that moment in the transcript.",
      points: ["A to approve, E to edit, D to decline, I when the transcript does not settle it", "J and K move between items, U undoes your last decision", "Select transcript lines to add a fact the AI missed"],
    },
    {
      icon: <CheckCircle2 className="h-6 w-6" />,
      title: "Submit when all four checks pass",
      body: "Consent heard, personal data masked, fair housing safe, and type matches the project. The agent only sees what you approved.",
      points: ["No consent on the recording? Escalate instead of submitting", "You can reopen a submitted event for 24 hours"],
    },
    {
      icon: <ClipboardList className="h-6 w-6" />,
      title: "Tickets are tasks the agent assigned to you",
      body: "Set an ETA first so the agent knows when to expect it. Run the timer while you work, attach the deliverable, then mark it delivered.",
      points: ["Blocked? Ask agent and pause stops the clock until they answer", "If the agent replies by text or email, log the reply on the ticket"],
    },
    {
      icon: <Users className="h-6 w-6" />,
      title: "Two rules that never bend",
      body: "You never contact the agent's clients or any third party. Everything you prepare goes to the agent, who decides what to send.",
    },
  ],
  admin: [
    {
      icon: <Users className="h-6 w-6" />,
      title: "Start by adding people",
      body: "Open Admin to create accounts for VAs and agents, then tick which agents each VA serves.",
      points: ["Each person gets their own login", "You can reset a password at any time"],
    },
    {
      icon: <Inbox className="h-6 w-6" />,
      title: "You can work as a VA too",
      body: "Admins see every agent in the VA Console and can verify events and handle tickets.",
    },
  ],
  agent: [
    {
      icon: <FileAudio className="h-6 w-6" />,
      title: "Add a conversation",
      body: "Upload a recording, a transcript, a text thread, or a quick voice memo after a meeting. One project per client.",
    },
    {
      icon: <ShieldCheck className="h-6 w-6" />,
      title: "Your assistant verifies the facts",
      body: "By 9:00 AM the next business day, Deal status shows what was decided, what changed, and what is still open. Tap any source to read the exact quote.",
    },
    {
      icon: <Sparkles className="h-6 w-6" />,
      title: "Hand off the follow-up work",
      body: "Tasks suggests work based on each conversation. Assign the ones you want, edit them first if needed, or write your own.",
      points: ["You get an ETA once your assistant starts", "Nothing is sent to your clients. You review every deliverable first"],
    },
    {
      icon: <MessageSquare className="h-6 w-6" />,
      title: "Tell us how it went",
      body: "When a task is delivered, tap Used as is, Edited, or Not used. That is how your assistant learns your style.",
    },
  ],
};

/** First-login walkthrough. Reopened from the account menu. */
export function Tour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me, refresh } = useSession();
  const [index, setIndex] = useState(0);
  const role = me?.profile.role ?? "agent";
  const steps = role === "admin" ? [...TOUR_STEPS.admin, ...TOUR_STEPS.va] : TOUR_STEPS[role];

  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  async function finish() {
    onClose();
    if (!me?.profile.onboarded_at) {
      try {
        await rpc("completeOnboarding");
        await refresh();
      } catch {
        /* The tour will simply show again next time. */
      }
    }
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setIndex((i) => Math.min(steps.length - 1, i + 1));
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, steps.length]);

  if (!open) return null;
  const step = steps[index];
  const last = index === steps.length - 1;
  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/50 sm:items-center sm:p-4" data-modal role="dialog" aria-modal="true" aria-label="Getting started">
      <div className="rise w-full rounded-t-2xl bg-white p-6 shadow-xl sm:max-w-md sm:rounded-2xl">
        <div className="flex items-center justify-between text-xs text-ink-3">
          <span>
            Step {index + 1} of {steps.length}
          </span>
          <button className="underline" onClick={finish}>
            Skip
          </button>
        </div>
        <div className="mt-5 flex h-12 w-12 items-center justify-center rounded-xl bg-accent-soft text-accent">{step.icon}</div>
        <h2 className="mt-4 text-lg font-semibold">{step.title}</h2>
        <p className="mt-2 text-sm text-ink-2">{step.body}</p>
        {step.points ? (
          <ul className="mt-3 space-y-1.5">
            {step.points.map((p) => (
              <li key={p} className="flex gap-2 text-[13px] text-ink-2">
                <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" />
                {p}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-6 flex items-center justify-between">
          <div className="flex gap-1.5" aria-hidden>
            {steps.map((_, i) => (
              <span key={i} className={cx("h-1.5 rounded-full transition-all", i === index ? "w-5 bg-ink" : "w-1.5 bg-[#d5d8dc]")} />
            ))}
          </div>
          <div className="flex gap-2">
            {index > 0 ? <Button onClick={() => setIndex(index - 1)}>Back</Button> : null}
            <Button variant="primary" data-autofocus onClick={() => (last ? finish() : setIndex(index + 1))}>
              {last ? "Get started" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
