"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { rpc } from "@/lib/client/api";
import { useSession } from "./Session";
import { Button, composing, cx, isTyping } from "./ui";

export interface CoachStep {
  /** Value of a data-tour attribute. Omit for a centered card. */
  target?: string;
  title: string;
  body: string;
}

const REPLAY_EVENT = "notique:replay-tour";

function seenKey(userId: string, name: string) {
  return `notique.tour.${userId}.${name}`;
}

let mounted = 0;
const ALL_TOURS = ["va-home", "va-verify", "va-ticket", "agent-home", "agent-project", "admin"];

/** Marks every tour as unseen for this user and restarts the one on screen, or goes to the home screen if this page has none. */
export function replayTours(userId: string, home: string) {
  try {
    for (const name of ALL_TOURS) window.localStorage.setItem(seenKey(userId, name), "0");
  } catch {
    /* Storage is unavailable. The tour still replays for this visit. */
  }
  if (mounted > 0) window.dispatchEvent(new Event(REPLAY_EVENT));
  else window.location.assign(home);
}

function findTarget(name?: string): HTMLElement | null {
  if (!name) return null;
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`));
  return nodes.find((n) => n.offsetParent !== null && n.getBoundingClientRect().width > 0) ?? null;
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const CARD_W = 320;
const GAP = 14;

/**
 * Guided walkthrough that spotlights real controls on the page, one at a time.
 * Starts on its own the first time a user reaches the screen. `ready` should be
 * true once the screen's data has rendered.
 */
export function Coach({ name, steps, ready = true, primary }: { name: string; steps: CoachStep[]; ready?: boolean; primary?: boolean }) {
  const { me, refresh } = useSession();
  const userId = me?.profile.id ?? "";
  const [index, setIndex] = useState<number | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [view, setView] = useState({ w: 1200, h: 800 });

  /* Skip steps whose control is not on screen (for example the side menu on a phone). */
  const usable = useCallback(() => steps.filter((s) => !s.target || findTarget(s.target)), [steps]);
  const [list, setList] = useState<CoachStep[]>([]);

  const retry = useRef<number | null>(null);
  const startRef = useRef<() => void>(() => {});
  const start = useCallback(() => {
    // Never cover a dialog or interrupt someone who is typing. Try again once they are done.
    if (document.querySelector("[data-modal]") || isTyping()) {
      if (retry.current) window.clearTimeout(retry.current);
      retry.current = window.setTimeout(() => startRef.current(), 2000);
      return;
    }
    const next = usable();
    if (next.length === 0) return;
    setList(next);
    setIndex(0);
  }, [usable]);
  useEffect(() => {
    startRef.current = start;
  }, [start]);
  useEffect(
    () => () => {
      if (retry.current) window.clearTimeout(retry.current);
    },
    [],
  );

  useEffect(() => {
    if (!ready || !userId) return;
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(seenKey(userId, name));
    } catch {
      stored = null;
    }
    // "0" means the user asked to replay. Otherwise the account flag covers a new browser.
    const seen = stored === "1" || (stored !== "0" && !!primary && !!me?.profile.onboarded_at);
    if (seen) return;
    const id = window.setTimeout(start, 500);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, userId, name]);

  useEffect(() => {
    if (!ready) return;
    mounted += 1;
    return () => {
      mounted -= 1;
    };
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    const onReplay = () => window.setTimeout(start, 150);
    window.addEventListener(REPLAY_EVENT, onReplay);
    return () => window.removeEventListener(REPLAY_EVENT, onReplay);
  }, [ready, start]);

  const step = index === null ? null : list[index] ?? null;

  const measure = useCallback(() => {
    setView({ w: window.innerWidth, h: window.innerHeight });
    const el = findTarget(step?.target);
    if (!el) return setBox(null);
    const r = el.getBoundingClientRect();
    const pad = 6;
    setBox({ top: r.top - pad, left: r.left - pad, width: r.width + pad * 2, height: r.height + pad * 2 });
  }, [step]);

  useLayoutEffect(() => {
    if (!step) return;
    const el = findTarget(step.target);
    el?.scrollIntoView({ block: "center", inline: "nearest" });
    measure();
    const again = window.setTimeout(measure, 250);
    // Content that loads after the step starts (a table, a draft) moves things: follow it.
    const watch = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => measure()) : null;
    watch?.observe(document.body);
    if (el) watch?.observe(el);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.clearTimeout(again);
      watch?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step, measure]);

  const finish = useCallback(async () => {
    setIndex(null);
    try {
      window.localStorage.setItem(seenKey(userId, name), "1");
    } catch {
      /* The tour may show again next visit. */
    }
    if (primary && !me?.profile.onboarded_at) {
      try {
        await rpc("completeOnboarding");
        await refresh();
      } catch {
        /* Not critical. */
      }
    }
  }, [userId, name, primary, me?.profile.onboarded_at, refresh]);

  useEffect(() => {
    if (index === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (composing(e) || isTyping(e.target)) return;
      if (e.key === "Enter" && (e.target as HTMLElement | null)?.closest?.("button,a")) return;
      if (e.key === "Escape") finish();
      else if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        if (index >= list.length - 1) finish();
        else setIndex(index + 1);
      } else if (e.key === "ArrowLeft") setIndex(Math.max(0, index - 1));
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, list.length, finish]);

  if (index === null || !step) return null;
  const last = index === list.length - 1;

  /* Place the card next to the spotlight, on whichever side has room. */
  const cardW = Math.min(CARD_W, view.w - 24);
  let cardStyle: React.CSSProperties = { top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: cardW };
  let arrow: { side: "top" | "bottom" | "left" | "right"; offset: number } | null = null;
  if (box) {
    const clampX = (x: number) => Math.max(12, Math.min(view.w - cardW - 12, x));
    const estH = 210;
    const clampY = (y: number) => Math.max(12, Math.min(view.h - estH - 12, y));
    const cx0 = box.left + box.width / 2;
    const cy0 = box.top + box.height / 2;
    if (box.top + box.height + GAP + estH < view.h) {
      const left = clampX(cx0 - cardW / 2);
      cardStyle = { top: box.top + box.height + GAP, left, width: cardW };
      arrow = { side: "top", offset: Math.max(18, Math.min(cardW - 18, cx0 - left)) };
    } else if (box.top - GAP - estH > 0) {
      const left = clampX(cx0 - cardW / 2);
      cardStyle = { bottom: view.h - box.top + GAP, left, width: cardW };
      arrow = { side: "bottom", offset: Math.max(18, Math.min(cardW - 18, cx0 - left)) };
    } else if (box.left + box.width + GAP + cardW < view.w) {
      const top = clampY(cy0 - estH / 2);
      cardStyle = { top, left: box.left + box.width + GAP, width: cardW };
      arrow = { side: "left", offset: Math.max(18, Math.min(estH - 18, cy0 - top)) };
    } else if (box.left - GAP - cardW > 0) {
      const top = clampY(cy0 - estH / 2);
      cardStyle = { top, left: box.left - GAP - cardW, width: cardW };
      arrow = { side: "right", offset: Math.max(18, Math.min(estH - 18, cy0 - top)) };
    } else {
      cardStyle = { bottom: 16, left: clampX(cx0 - cardW / 2), width: cardW };
    }
  }

  const arrowStyle: React.CSSProperties | undefined = arrow
    ? arrow.side === "top"
      ? { top: -6, left: arrow.offset - 6 }
      : arrow.side === "bottom"
        ? { bottom: -6, left: arrow.offset - 6 }
        : arrow.side === "left"
          ? { left: -6, top: arrow.offset - 6 }
          : { right: -6, top: arrow.offset - 6 }
    : undefined;

  return (
    <div className="fixed inset-0 z-[80]" data-modal role="dialog" aria-modal="true" aria-label="Guided tour">
      {/* Click shield. The page underneath is not interactive during the tour. */}
      <div className="absolute inset-0" onClick={() => (last ? finish() : setIndex(index + 1))} />
      {box ? (
        <>
          <div className="coach-spot pointer-events-none absolute rounded-xl" style={{ top: box.top, left: box.left, width: box.width, height: box.height }} />
          <div className="coach-ring pointer-events-none absolute rounded-xl" style={{ top: box.top, left: box.left, width: box.width, height: box.height }} />
        </>
      ) : (
        <div className="pointer-events-none absolute inset-0 bg-black/55" />
      )}
      <div key={index} className="coach-card absolute rounded-2xl bg-white p-4 shadow-2xl" style={cardStyle}>
        {arrowStyle ? <span className="absolute h-3 w-3 rotate-45 bg-white" style={arrowStyle} /> : null}
        <div className="flex items-center justify-between text-xs text-ink-3">
          <span>
            {index + 1} of {list.length}
          </span>
          <button className="underline" onClick={finish}>
            Skip tour
          </button>
        </div>
        <h2 className="mt-1.5 text-[15px] font-semibold">{step.title}</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{step.body}</p>
        <div className="mt-3 flex items-center justify-between">
          <div className="flex gap-1" aria-hidden>
            {list.map((_, i) => (
              <span key={i} className={cx("h-1.5 rounded-full transition-all", i === index ? "w-4 bg-ink" : "w-1.5 bg-[#d5d8dc]")} />
            ))}
          </div>
          <div className="flex gap-2">
            {index > 0 ? (
              <Button size="sm" onClick={() => setIndex(index - 1)}>
                Back
              </Button>
            ) : null}
            <Button size="sm" variant="primary" onClick={() => (last ? finish() : setIndex(index + 1))}>
              {last ? "Done" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Tours ---------- */

export const TOURS = {
  vaHome: [
    { title: "Welcome to the VA Console", body: "A one minute tour of where things are. Use Next, or the arrow keys. One rule first: you never contact the user's clients or any third party. Everything goes to the user." },
    { target: "agent-select", title: "Who you are serving", body: "Everything on screen belongs to this user. Switch here when you work for someone else. Deadlines follow the user's time zone." },
    { target: "nav-queue", title: "Queue: start here every shift", body: "Conversations the user recorded or uploaded, waiting for you to check. The number shows how many are waiting." },
    { target: "queue-table", title: "Conversations to verify", body: "Sorted by deadline, most urgent on top. Click Verify to open one and check the AI's draft against the transcript." },
    { target: "add-conversation", title: "Add something yourself", body: "Got a recording, transcript, or text thread from the user by email or text? Upload it here and it joins the queue." },
    { target: "nav-projects", title: "Projects: one per client", body: "Each client has a deal profile with every verified fact, the tickets, the files, and anything you are watching in the market for them." },
    { target: "nav-tasks", title: "Tickets: work the user asked for", body: "The user calls these requests. Open one to set an ETA, finish the AI's first draft, and deliver. If the user asks for something by text, email or phone, use Log a request there so it is tracked." },
    { target: "nav-checkin", title: "Check-in: once a day", body: "A ready message asking the user what is still open and offering to take it over. Edit it, send it, mark it done." },
    { target: "nav-sources", title: "Data sources", body: "Every way a conversation can come in, with an upload button for each." },
    { target: "nav-qc", title: "Quality review", body: "Your numbers: how many AI drafts you approved, edited, or declined, and what the user did with your deliverables." },
    { target: "nav-how", title: "How it works", body: "A one-page picture of the whole flow: who does what at each step, and where you and the user hand work to each other." },
    { target: "user-menu", title: "Help lives here", body: "Replay this tour, open Help, or sign out." },
  ],
  vaVerify: [
    { title: "Checking a conversation", body: "The transcript is on the left, the AI's drafts are on the right. Your job: decide on every draft, then submit." },
    { target: "fact", title: "One draft at a time", body: "Read the quote under it. Approve if it matches. Edit to fix the wording or move it to another section. Decline if the AI got it wrong. Ask user if the transcript does not settle it. Keys A, E, D, I do the same. Some drafts carry a suggested request: approving sends that suggestion to the user. No Approve button means the AI was unsure or the wording describes a person instead of the property: use Edit and approve." },
    { target: "transcript", title: "Click a quote to jump here", body: "The matching line flashes in the transcript. With a recording, the audio jumps to that moment." },
    { target: "add-fact", title: "The AI missed something?", body: "Click the transcript lines that prove it (they turn blue), then click Add fact and write it yourself." },
    { target: "settles", title: "Did this settle anything from before?", body: "Below the drafts is the client's list of earlier open questions, concerns and next steps. Tick the ones this conversation answered. The AI pre-ticks its guesses. On submit they disappear from the user's deal profile." },
    { target: "checks", title: "Four checks before you submit", body: "Tick each one only after you have checked it yourself. No consent, the wrong client, or audio you cannot follow: use Escalate at the bottom instead of submitting." },
    { target: "submit", title: "Submit", body: "Unlocks when every draft has a decision and all four checks are ticked. The user sees the approved facts and the summary right away. You can reopen for 24 hours." },
  ],
  vaTicket: [
    { target: "ticket-eta", title: "Set an ETA first", body: "The user sees it immediately. Setting it moves the ticket to In progress." },
    { target: "ticket-timer", title: "Track your time", body: "Start when you begin, pause when you stop. It also pauses on its own when you ask the user a question." },
    { target: "ticket-draft", title: "AI first draft", body: "A starting point written from the verified facts. The user cannot see it. Fill in every [ADD: ...], check each fact, then save it to Deliverables." },
    { target: "ticket-deliverables", title: "Deliverables", body: "The saved draft, an uploaded file, or a link. The user sees nothing here until you mark the ticket delivered." },
    { target: "ticket-thread", title: "Talk to the user", body: "Send a message, or use Ask user and pause when you are blocked. If the user replies by text or email, log the reply here." },
    { target: "ticket-deliver", title: "Mark delivered", body: "Sends the deliverables to the user and stops the timer. The user sends them on to the client." },
  ],
  agentHome: [
    { title: "Welcome to Notique", body: "Your assistant turns each client conversation into checked notes and follow-up work. Here is where things are." },
    { target: "add-conversation", title: "Start here", body: "After a meeting, add the recording, a transcript, a text thread, or a written note." },
    { target: "new-task", title: "Submit a request", body: "Need research, a comparison, or a draft? Ask your assistant here." },
    { target: "home-waiting", title: "Waiting on you", body: "Anything that needs you, across all clients: a question from your assistant, a delivery to review, or a suggested follow-up to send or skip." },
    { target: "home-with", title: "With your assistant", body: "Everything your assistant is working on for you, and when to expect it." },
    { target: "project-list", title: "One project per client", body: "Open a client to see what was decided, what changed, and what is still open." },
    { target: "user-menu", title: "Help lives here", body: "Replay this tour or open Help any time." },
  ],
  agentProject: [
    { target: "waiting", title: "Start here", body: "Anything that needs you is listed at the top: deliveries to review, questions from your assistant, and suggested follow-ups." },
    { target: "tab-status", title: "Deal status", body: "Facts your assistant checked against the recording: decisions, budget, client needs, open questions, risks. Tap a source to read the exact quote." },
    { target: "tab-timeline", title: "Timeline", body: "Each conversation by day, with a short summary of what happened." },
    { target: "tab-tasks", title: "Requests", body: "Suggested follow-up work appears here. Send what you want done, edit it first, or write your own. When something is delivered, open it and say if you used it. Your assistant never contacts your clients." },
    { target: "tab-files", title: "Files", body: "Every file in one place: what your assistant delivered, labeled with its request, plus documents you shared." },
    { target: "add-conversation", title: "After every meeting", body: "Add the recording or your notes here. Checked results arrive by 9:00 AM the next business day." },
  ],
  admin: [
    { target: "admin-add", title: "Add people", body: "Create a login for each VA and each user. Send them the sign-in address, their email and the temporary password yourself. Notique does not email them." },
    { target: "admin-matrix", title: "Match VAs to users", body: "Tick the box where a VA's row meets a user's column. Until you do, the VA sees nothing and the user has no assistant." },
    { target: "admin-edit", title: "Edit a person", body: "Change the name or time zone. For a user, this is also where you turn on email or text alerts once they have agreed to them." },
  ],
} satisfies Record<string, CoachStep[]>;
