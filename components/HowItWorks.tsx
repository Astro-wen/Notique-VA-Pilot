"use client";
import { useState } from "react";
import { cx } from "./ui";

const ACC = "#3b6cf0";
const AI = "#8b5cf6";
const VA = "#12a070";
const US = "#7a8291";
const X0 = 124;
const CW = 232;
const BW = 200;
const BH = 88;
const UY = 112;
const AY = 258;
const VY = 404;
const W = X0 + 6 * CW + 4;
const H = 700;
const bx = (i: number) => X0 + i * CW;
const cxOf = (i: number) => bx(i) + BW / 2;

type Lane = "user" | "ai" | "va";
interface Node {
  stage: number;
  lane: Lane;
  title: string;
  lines: string[];
}
const LANE_Y: Record<Lane, number> = { user: UY, ai: AY, va: VY };
const LANE_COLOR: Record<Lane, string> = { user: US, ai: AI, va: VA };

const NODES: Node[] = [
  { stage: 0, lane: "user", title: "Add a conversation", lines: ["After meeting a client, the user", "uploads the recording, a text", "thread, or a typed note."] },
  { stage: 0, lane: "ai", title: "Draft the facts", lines: ["AI writes down what was said", "and pulls out the key facts,", "each linked to its quote."] },
  { stage: 1, lane: "va", title: "Check every fact", lines: ["The VA reads each fact next to", "its quote, fixes or removes", "what is wrong, then submits."] },
  { stage: 2, lane: "user", title: "See what changed", lines: ["The user sees only the facts", "the VA checked, plus a few", "suggested follow-ups."] },
  { stage: 3, lane: "user", title: "Ask for help", lines: ["The user taps Send on a", "suggestion, or writes what", "they need in their own words."] },
  { stage: 3, lane: "ai", title: "Write a first draft", lines: ["AI drafts the work from the", "checked facts. Only the VA", "can see this draft."] },
  { stage: 4, lane: "va", title: "Do the work", lines: ["The VA says when it will be", "ready, finishes the draft,", "and delivers it."] },
  { stage: 4, lane: "user", title: "Answer a question", lines: ["If the VA gets stuck, they ask.", "The user replies in the", "same thread."] },
  { stage: 5, lane: "user", title: "Review and send", lines: ["The user reads it, sends it to", "the client, and says whether", "it was useful."] },
];

interface Edge {
  d: string;
  handoff?: boolean;
  both?: boolean;
  /** Stages this edge belongs to. It stays lit when any of them is selected. */
  stages: number[];
  label?: { x: number; y: number; text: string; end?: boolean };
}
const g1 = bx(1) + BW + 16;
const g5 = bx(4) + BW + 16;
const EDGES: Edge[] = [
  { d: `M${cxOf(0)},${UY + BH} V${AY - 3}`, stages: [0], label: { x: cxOf(0) + 8, y: UY + BH + 33, text: "the file goes to AI" } },
  { d: `M${bx(0) + BW},${AY + BH / 2} H${cxOf(1)} V${VY - 3}`, stages: [0, 1], label: { x: bx(0) + BW + 8, y: AY + BH / 2 - 7, text: "the VA gets the draft" } },
  { d: `M${bx(1) + BW},${VY + BH / 2} H${g1} V${UY + BH / 2} H${bx(2) - 3}`, handoff: true, stages: [1, 2], label: { x: g1 + 8, y: AY + BH / 2 + 4, text: "the VA submits" } },
  { d: `M${bx(2) + BW},${UY + BH / 2} H${bx(3) - 3}`, stages: [2, 3] },
  { d: `M${cxOf(3)},${UY + BH} V${AY - 3}`, handoff: true, stages: [3], label: { x: cxOf(3) + 8, y: UY + BH + 33, text: "this becomes a ticket" } },
  { d: `M${bx(3) + BW},${AY + BH / 2} H${cxOf(4) - 44} V${VY - 3}`, stages: [3, 4], label: { x: bx(3) + BW + 8, y: AY + BH / 2 - 7, text: "the VA gets the draft" } },
  { d: `M${cxOf(4) + 44},${VY - 4} V${UY + BH + 4}`, handoff: true, both: true, stages: [4], label: { x: cxOf(4) + 36, y: UY + BH + 33, text: "they talk here", end: true } },
  { d: `M${bx(4) + BW},${VY + 26} H${g5} V${UY + BH / 2} H${bx(5) - 3}`, handoff: true, stages: [4, 5], label: { x: g5 + 8, y: VY - 20, text: "the VA delivers" } },
  { d: `M${cxOf(5) + 40},${UY + BH} V${VY + 62} H${bx(4) + BW + 3}`, handoff: true, stages: [5, 4], label: { x: cxOf(5) + 48, y: AY + BH + 26, text: "asks for changes" } },
];

interface StageInfo {
  name: string;
  line: string;
  user: string;
  ai: string;
  va: string;
  meet: string;
  clicks: { who: "User" | "VA"; steps: string }[];
  userHref?: string;
  vaHref?: string;
}
const STAGES: StageInfo[] = [
  {
    name: "Capture",
    line: "A client conversation goes in.",
    user: "Adds a recording, a transcript, screenshots of a text thread, or a typed note, and picks the client.",
    ai: "Transcribes audio with speakers and timestamps, then drafts facts in six sections. Every draft points at the exact lines it came from.",
    va: "Nothing yet. The VA can also add material the user sent by text or email.",
    meet: "No hand-off. The user sees a notice that the conversation is being checked.",
    clicks: [{ who: "User", steps: "Tap Add conversation, choose what you are adding, pick the client, attach the file or paste the text, then tap Send." }],
    userHref: "/agent",
    vaHref: "/va?view=sources",
  },
  {
    name: "Verify",
    line: "A person checks every AI draft against what was said.",
    user: "Nothing. They wait for the result.",
    ai: "Marks how sure it is about each draft. Drafts it is unsure about cannot be approved without editing.",
    va: "Reads each draft next to its quote. Approves, edits, declines, or asks the user. Ticks four checks: consent, personal data, fair housing, right client. Submits.",
    meet: "Submit is the hand-off. Due 9:00 AM the next business day in the user's time zone.",
    clicks: [{ who: "VA", steps: "Open Queue and click Verify. For each fact, choose Approve, Edit, Decline or Ask user. Tick the four checks, then click Submit." }],
    vaHref: "/va",
  },
  {
    name: "See",
    line: "The user sees only what was checked.",
    user: "Opens the client. Deal status shows decisions, budget, client needs, open questions, risks and next steps. Timeline shows what happened each day. Every line opens to its quote.",
    ai: "Nothing. AI text that a VA has not checked never appears here.",
    va: "Can preview exactly what the user sees with User view.",
    meet: "The facts and the suggested follow-ups arrive together. Anything that needs the user is listed first under Waiting on you.",
    clicks: [{ who: "User", steps: "Open the client and read Deal status. Tap the source under any line to see the exact quote." }],
    userHref: "/agent",
    vaHref: "/va?view=projects",
  },
  {
    name: "Ask",
    line: "The user asks for follow-up work with one tap.",
    user: "Taps Send on a suggested follow-up, edits it first, or writes a new request. Or just texts the VA.",
    ai: "Writes a first draft of the deliverable from the verified facts and lists what still has to be looked up. Only the VA sees it.",
    va: "Gets a ticket. If the user asked by text or email, the VA logs the ticket and attaches a screenshot as proof.",
    meet: "The request becomes a ticket. Same item, two names: Request for the user, Ticket for the VA.",
    clicks: [
      { who: "User", steps: "Open Requests and tap Send on a suggestion. Or tap Submit a request and describe what you need." },
      { who: "VA", steps: "If the user asked by text or email, open the project, click New ticket for the user, and attach a screenshot of the message." },
    ],
    userHref: "/agent",
    vaHref: "/va?view=tasks",
  },
  {
    name: "Do",
    line: "The VA finishes the work and delivers it.",
    user: "Sees the expected delivery time. Answers a question if the VA asks one.",
    ai: "Rewrites the draft when the VA gives a short instruction.",
    va: "Sets the ETA, completes the draft, checks every fact, saves it to Deliverables, and marks the ticket delivered. Never contacts the client.",
    meet: "Two hand-offs. Ask user and pause sends a question and the user's answer resumes the ticket. Mark delivered sends the result.",
    clicks: [
      { who: "VA", steps: "Open the ticket and set the ETA. Edit the AI first draft, click Save to deliverables, then click Mark delivered." },
      { who: "User", steps: "Open the request, type your answer, and tap Send." },
    ],
    userHref: "/agent",
    vaHref: "/va?view=tasks",
  },
  {
    name: "Review",
    line: "The user sends it to the client and says how it went.",
    user: "Opens the delivery, sends it to the client themselves, and marks Used as is, Edited it, or Not used. Ask for changes sends it back with a note.",
    ai: "Nothing.",
    va: "Sees the feedback. A request for changes reopens the ticket.",
    meet: "Feedback closes the loop. It is also how the pilot measures whether the work was good enough to send.",
    clicks: [{ who: "User", steps: "Open the delivery under Waiting on you and read the file. Then tap Used as is, Edited it, or Not used. Tap Ask for changes to send it back." }],
    userHref: "/agent",
    vaHref: "/va?view=tasks",
  },
];

const DAILY: { title: string; lane: Lane; planned?: boolean; lines: string[]; detail: string }[] = [
  { title: "Check-in", lane: "va", lines: ["Once a day the VA asks the user what is still", "open and offers to take it off their plate."], detail: "Once a day the VA opens Check-in. It lists everything waiting on the user and writes the message. The VA sends it and marks it done. When the user says yes to something, one button turns it into a ticket." },
  { title: "Watches", lane: "ai", lines: ["The VA sets a condition, like a rate dropping.", "AI checks daily and opens a ticket when it happens."], detail: "The VA writes a condition for a client, such as a mortgage rate or a listing price. It is checked against the live web every day. When it becomes true a ticket opens with the sources and a drafted note, for the VA to check and deliver." },
  { title: "Email and text alerts", lane: "ai", planned: true, lines: ["The user gets an email or text when something", "is ready. It is built but not switched on yet."], detail: "The product can email or text the user when a delivery is ready or a question is waiting, and send a morning brief. It is built and off. It needs the sending accounts connected and each user's agreement." },
  { title: "Recorder auto-sync", lane: "ai", planned: true, lines: ["Recordings from the Notique recorder will", "arrive on their own, with no uploading."], detail: "Today the user or the VA uploads each recording. The plan is for recordings made with the Notique recorder to arrive on their own." },
];

/** Interactive left to right picture of how one conversation becomes a finished follow-up. */
export function HowItWorks({ role }: { role: "agent" | "va" | "admin" }) {
  const [stage, setStage] = useState<number | null>(null);
  const [daily, setDaily] = useState<number | null>(null);
  const lit = (stages: number[]) => stage === null || stages.includes(stage);
  const info = stage !== null ? STAGES[stage] : null;
  const href = info ? (role === "agent" ? info.userHref : info.vaHref) : undefined;
  const dw = (W - 48 - 3 * 16) / 4;
  const by = 536;

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {STAGES.map((s, i) => (
          <button
            key={s.name}
            onClick={() => {
              setStage(stage === i ? null : i);
              setDaily(null);
            }}
            aria-pressed={stage === i}
            className={cx("inline-flex h-9 items-center gap-2 rounded-full border px-3 text-[13px] font-medium", stage === i ? "border-ink bg-ink text-white" : "border-line bg-white text-ink-2 hover:bg-page")}
          >
            <span className={cx("flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold", stage === i ? "bg-white text-ink" : "bg-ink text-white")}>{i + 1}</span>
            {s.name}
          </button>
        ))}
        {stage !== null ? (
          <button className="h-9 px-2 text-[13px] text-accent hover:underline" onClick={() => setStage(null)}>
            Show all
          </button>
        ) : (
          <span className="flex h-9 items-center px-1 text-[13px] text-ink-3">Click a step, or any box, to see who does what.</span>
        )}
      </div>

      <div className="mt-3 overflow-x-auto rounded-xl border border-line bg-white p-2">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full min-w-[1040px] text-ink" role="img" aria-label="How Notique works: the user adds a conversation, AI drafts the facts, the VA checks them and submits, the user asks for help, AI writes a first draft, the VA does the work and delivers it, and the user reviews and sends it.">
          <defs>
            <marker id="hw-n" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="currentColor" fillOpacity="0.7" />
            </marker>
            <marker id="hw-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill={ACC} />
            </marker>
          </defs>

          {(
            [
              [UY, "USER", "real estate agent"],
              [AY, "NOTIQUE AI", "automatic"],
              [VY, "VA", "human assistant"],
            ] as const
          ).map(([y, name, sub]) => (
            <g key={name}>
              <rect x={8} y={y - 14} width={W - 16} height={BH + 28} rx={12} fill="currentColor" fillOpacity={0.03} />
              <text x={24} y={y + 36} fontSize={12.5} fontWeight={700} letterSpacing={0.6} fill="currentColor">
                {name}
              </text>
              <text x={24} y={y + 53} fontSize={10.5} fill="currentColor" fillOpacity={0.6}>
                {sub}
              </text>
            </g>
          ))}

          {STAGES.map((s, i) => (
            <g key={s.name} opacity={lit([i]) ? 1 : 0.3} className="cursor-pointer" onClick={() => setStage(stage === i ? null : i)}>
              <circle cx={bx(i) + 11} cy={72} r={11} fill="currentColor" />
              <text x={bx(i) + 11} y={76.5} fontSize={12} fontWeight={700} textAnchor="middle" fill="#fff">
                {i + 1}
              </text>
              <text x={bx(i) + 30} y={77} fontSize={15} fontWeight={700} fill="currentColor">
                {s.name}
              </text>
            </g>
          ))}

          {EDGES.map((e, i) => (
            <g key={i} opacity={lit(e.stages) ? 1 : 0.18}>
              <path d={e.d} fill="none" stroke={e.handoff ? ACC : "currentColor"} strokeWidth={e.handoff ? 2 : 1.3} strokeOpacity={e.handoff ? 1 : 0.65} markerEnd={`url(#${e.handoff ? "hw-a" : "hw-n"})`} markerStart={e.both ? "url(#hw-a)" : undefined} />
              {e.label ? (
                <text x={e.label.x} y={e.label.y} fontSize={11} fontWeight={e.handoff ? 700 : 500} textAnchor={e.label.end ? "end" : "start"} fill={e.handoff ? ACC : "currentColor"} fillOpacity={e.handoff ? 1 : 0.75}>
                  {e.label.text}
                </text>
              ) : null}
            </g>
          ))}

          {NODES.map((n) => {
            const x = bx(n.stage);
            const y = LANE_Y[n.lane];
            const c = LANE_COLOR[n.lane];
            const on = stage === n.stage;
            return (
              <g
                key={n.title}
                opacity={lit([n.stage]) ? 1 : 0.25}
                className="cursor-pointer"
                tabIndex={0}
                role="button"
                aria-label={`${n.title}. Step ${n.stage + 1}, ${STAGES[n.stage].name}`}
                onClick={() => {
                  setStage(stage === n.stage ? null : n.stage);
                  setDaily(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setStage(stage === n.stage ? null : n.stage);
                    setDaily(null);
                  }
                }}
              >
                <rect x={x} y={y} width={BW} height={BH} rx={10} fill={c} fillOpacity={on ? 0.22 : 0.13} stroke={c} strokeWidth={on ? 2.4 : 1.5} />
                <text x={x + 14} y={y + 23} fontSize={13.5} fontWeight={700} fill="currentColor">
                  {n.title}
                </text>
                {n.lines.map((l, k) => (
                  <text key={k} x={x + 14} y={y + 43 + k * 15} fontSize={11.5} fill="currentColor" fillOpacity={0.75}>
                    {l}
                  </text>
                ))}
              </g>
            );
          })}

          <text x={24} y={by + 4} fontSize={12.5} fontWeight={700} letterSpacing={0.6} fill="currentColor">
            ALSO RUNNING EVERY DAY
          </text>
          {DAILY.map((d, k) => {
            const x = 24 + k * (dw + 16);
            const c = LANE_COLOR[d.lane];
            const on = daily === k;
            return (
              <g
                key={d.title}
                className="cursor-pointer"
                tabIndex={0}
                role="button"
                aria-label={d.title}
                opacity={stage === null ? 1 : 0.3}
                onClick={() => {
                  setDaily(daily === k ? null : k);
                  setStage(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setDaily(daily === k ? null : k);
                    setStage(null);
                  }
                }}
              >
                <rect x={x} y={by + 18} width={dw} height={84} rx={10} fill={c} fillOpacity={d.planned ? 0.05 : on ? 0.22 : 0.13} stroke={c} strokeWidth={on ? 2.4 : 1.5} strokeDasharray={d.planned ? "6 4" : undefined} />
                <text x={x + 14} y={by + 43} fontSize={13.5} fontWeight={700} fill="currentColor">
                  {d.title}
                </text>
                {d.lines.map((l, j) => (
                  <text key={j} x={x + 14} y={by + 62 + j * 16} fontSize={11.5} fill="currentColor" fillOpacity={0.75}>
                    {l}
                  </text>
                ))}
              </g>
            );
          })}

          {(
            [
              [24, US, "User does this", false],
              [174, AI, "AI does this, no one waits", false],
              [384, VA, "VA does this", false],
              [514, US, "Dashed: planned, not live yet", true],
            ] as const
          ).map(([x, c, t, planned]) => (
            <g key={t}>
              <rect x={x} y={657} width={22} height={14} rx={4} fill={c} fillOpacity={planned ? 0.05 : 0.13} stroke={c} strokeWidth={1.5} strokeDasharray={planned ? "6 4" : undefined} />
              <text x={x + 30} y={668} fontSize={11.5} fill="currentColor">
                {t}
              </text>
            </g>
          ))}
          <line x1={744} y1={664} x2={776} y2={664} stroke={ACC} strokeWidth={2} markerEnd="url(#hw-a)" />
          <text x={786} y={668} fontSize={11.5} fill="currentColor">
            User and VA hand off to each other
          </text>
          <line x1={1024} y1={664} x2={1056} y2={664} stroke="currentColor" strokeOpacity={0.65} strokeWidth={1.3} markerEnd="url(#hw-n)" />
          <text x={1066} y={668} fontSize={11.5} fill="currentColor">
            Automatic step
          </text>
        </svg>
      </div>

      {info ? (
        <div className="mt-3 rounded-xl border border-line bg-white p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ink text-xs font-bold text-white">{(stage as number) + 1}</span>
            <h2 className="text-[17px] font-semibold">{info.name}</h2>
            <span className="text-sm text-ink-2">{info.line}</span>
            {href ? (
              <a href={href} className="ml-auto inline-flex h-8 items-center rounded-md border border-line px-3 text-[13px] font-medium hover:bg-page">
                Open this screen
              </a>
            ) : null}
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            {(
              [
                ["User", info.user, US],
                ["Notique AI", info.ai, AI],
                ["VA", info.va, VA],
              ] as const
            ).map(([who, text, c]) => (
              <div key={who} className="rounded-lg p-3" style={{ background: `${c}1f`, border: `1.5px solid ${c}` }}>
                <div className="text-xs font-semibold uppercase tracking-wide">{who}</div>
                <p className="mt-1 text-[13px] text-ink-2">{text}</p>
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-lg p-3" style={{ border: `1.5px solid ${ACC}` }}>
            <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: ACC }}>
              Where the user and the VA meet
            </div>
            <p className="mt-1 text-[13px] text-ink-2">{info.meet}</p>
          </div>
          <div className="mt-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-3">The clicks</div>
            <ul className="mt-1 space-y-1 text-[13px] text-ink-2">
              {info.clicks.map((c) => (
                <li key={c.who + c.steps}>
                  <span className="font-semibold text-ink">{c.who}:</span> {c.steps}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : daily !== null ? (
        <div className="mt-3 rounded-xl border border-line bg-white p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[17px] font-semibold">{DAILY[daily].title}</h2>
            {DAILY[daily].planned ? <span className="rounded-full border border-dashed border-line-strong px-2 py-0.5 text-xs text-ink-2">Planned, not live yet</span> : <span className="rounded-full bg-ok-soft px-2 py-0.5 text-xs text-ok">Live today</span>}
          </div>
          <p className="mt-2 text-[13px] text-ink-2">{DAILY[daily].detail}</p>
        </div>
      ) : (
        <p className="mt-3 text-[13px] text-ink-3">Read left to right. Solid boxes are live today. Dashed boxes are planned. Blue arrows are the moments the user and the VA hand work to each other. Nothing written by AI reaches the user until the VA has checked it.</p>
      )}
    </div>
  );
}
