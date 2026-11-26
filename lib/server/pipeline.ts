import type { Section, SuggestedTask } from "@/lib/types";

export class PipelineError extends Error {}

export interface RawLine {
  start_ms: number | null;
  speaker: string;
  text: string;
}

/* ------------------------------------------------------------------ */
/* Transcript parsing                                                  */
/* ------------------------------------------------------------------ */

function tsToMs(ts: string): number | null {
  const m = ts.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const ms = Number((m[4] ?? "0").padEnd(3, "0"));
  return ((h * 60 + min) * 60 + s) * 1000 + ms;
}

function splitSpeaker(text: string): { speaker: string | null; text: string } {
  const voice = text.match(/^<v\s+([^>]+)>(.*)$/i);
  if (voice) return { speaker: voice[1].trim(), text: voice[2].replace(/<\/v>/gi, "").trim() };
  const m = text.match(/^([A-Za-zÀ-ɏ一-鿿][^:：\n]{0,40})(?::\s+|：\s*)(.+)$/);
  if (m && m[1].split(/\s+/).length <= 5) return { speaker: m[1].trim(), text: m[2].trim() };
  return { speaker: null, text: text.trim() };
}

function parseVtt(raw: string): RawLine[] {
  const lines: RawLine[] = [];
  const blocks = raw.replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const rows = block.split("\n").map((r) => r.trim()).filter(Boolean);
    const timeIdx = rows.findIndex((r) => r.includes("-->"));
    if (timeIdx === -1) continue;
    const start = tsToMs(rows[timeIdx].split("-->")[0]);
    const body = rows.slice(timeIdx + 1).join(" ").replace(/<\/?[^v][^>]*>/g, "").trim();
    if (!body) continue;
    const { speaker, text } = splitSpeaker(body);
    if (!text) continue;
    const prev = lines[lines.length - 1];
    const who = speaker ?? prev?.speaker ?? "Speaker";
    if (prev && prev.speaker === who && prev.text.length + text.length < 320 && !/[.?!。？！]$/.test(prev.text)) {
      prev.text = `${prev.text} ${text}`;
    } else {
      lines.push({ start_ms: start, speaker: who, text });
    }
  }
  return lines;
}

function parsePlain(raw: string): RawLine[] {
  const lines: RawLine[] = [];
  const rows = raw.replace(/\r/g, "").split("\n").map((r) => r.trim());
  let pendingTs: number | null = null;
  let sawSpeaker = false;
  for (const row of rows) {
    if (!row) continue;
    let rest = row;
    let ts: number | null = null;
    const lead = rest.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–]?\s*(.*)$/);
    if (lead) {
      ts = tsToMs(lead[1]);
      rest = lead[2];
      if (!rest) {
        pendingTs = ts;
        continue;
      }
    }
    const { speaker, text } = splitSpeaker(rest);
    if (!text) continue;
    const prev = lines[lines.length - 1];
    if (speaker) sawSpeaker = true;
    // Continuation lines join the previous turn only in a dialogue. Notes keep one line per row so each fact can cite its own line.
    if (sawSpeaker && !speaker && ts === null && pendingTs === null && prev && prev.text.length < 600) {
      prev.text = `${prev.text} ${text}`;
      continue;
    }
    lines.push({ start_ms: ts ?? pendingTs, speaker: speaker ?? prev?.speaker ?? "Note", text });
    pendingTs = null;
  }
  if (lines.length === 1 && lines[0].text.length > 400) {
    const only = lines[0];
    const sentences = only.text.match(/[^.?!。？！]+[.?!。？！]+|\S[^.?!。？！]*$/g) ?? [only.text];
    const out: RawLine[] = [];
    let buf = "";
    for (const s of sentences) {
      if ((buf + s).length > 260 && buf) {
        out.push({ start_ms: null, speaker: only.speaker, text: buf.trim() });
        buf = "";
      }
      buf += s;
    }
    if (buf.trim()) out.push({ start_ms: null, speaker: only.speaker, text: buf.trim() });
    return out;
  }
  return lines;
}

export function parseTranscriptText(raw: string): RawLine[] {
  const text = raw.replace(/^﻿/, "");
  const lines = /^WEBVTT/m.test(text.slice(0, 200)) || /\d{2}:\d{2}[.,]\d{3}\s*-->/.test(text)
    ? parseVtt(text)
    : parsePlain(text);
  return lines
    .map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() }))
    .filter((l) => l.text.length > 0)
    .slice(0, 4000);
}

export async function docxToText(buffer: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

/* ------------------------------------------------------------------ */
/* Speech to text (AssemblyAI)                                         */
/* ------------------------------------------------------------------ */

const AAI = "https://api.assemblyai.com/v2";

function aaiKey(): string {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) throw new PipelineError("Audio transcription is not configured. Add ASSEMBLYAI_API_KEY in Vercel and redeploy.");
  return key;
}

export async function startTranscription(audioUrl: string, webhookUrl?: string | null): Promise<string> {
  const res = await fetch(`${AAI}/transcript`, {
    method: "POST",
    headers: { authorization: aaiKey(), "content-type": "application/json" },
    body: JSON.stringify({ audio_url: audioUrl, speaker_labels: true, punctuate: true, format_text: true, language_detection: true, ...(webhookUrl ? { webhook_url: webhookUrl } : {}) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.id) {
    throw new PipelineError(`Transcription could not start: ${body.error ?? res.statusText}`);
  }
  return body.id as string;
}

export interface SttResult {
  status: "queued" | "processing" | "completed" | "error";
  error?: string;
  lines?: RawLine[];
  durationSec?: number;
}

export async function getTranscription(id: string): Promise<SttResult> {
  let res: Response;
  try {
    res = await fetch(`${AAI}/transcript/${id}`, { headers: { authorization: aaiKey() }, signal: AbortSignal.timeout(20000) });
  } catch {
    return { status: "processing" }; // Network blip. Try again on the next poll.
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 429 || res.status >= 500) return { status: "processing" };
  if (!res.ok) return { status: "error", error: body.error ?? res.statusText };
  if (body.status === "error") return { status: "error", error: body.error ?? "Transcription failed" };
  if (body.status !== "completed") return { status: body.status === "queued" ? "queued" : "processing" };
  const utterances: { start: number; speaker: string; text: string }[] = body.utterances ?? [];
  let lines: RawLine[] = utterances.map((u) => ({
    start_ms: Math.round(u.start),
    speaker: `Speaker ${u.speaker}`,
    text: u.text,
  }));
  if (lines.length === 0 && typeof body.text === "string" && body.text.trim()) {
    lines = parseTranscriptText(body.text);
  }
  return { status: "completed", lines, durationSec: Math.round(body.audio_duration ?? 0) || undefined };
}

/* ------------------------------------------------------------------ */
/* LLM (OpenRouter)                                                    */
/* ------------------------------------------------------------------ */

// Chosen from a side by side run on real pilot transcripts (Nov 2026). Override with OPENROUTER_MODEL.
const DEFAULT_MODELS = ["anthropic/claude-haiku-5.5", "google/gemini-2.5-flash"];

type ChatContent = string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];

/** The model that answered the most recent chatJson call in this request. */
export let lastModelUsed: string | null = null;

async function chatJson(messages: { role: "system" | "user"; content: ChatContent }[], onlyModel?: string): Promise<unknown> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new PipelineError("AI extraction is not configured. Add OPENROUTER_API_KEY in Vercel and redeploy.");
  const configured = (process.env.OPENROUTER_MODEL ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  const models = onlyModel ? [onlyModel] : configured.length ? configured : DEFAULT_MODELS;
  let lastError = "";
  // Client conversations are only sent to providers that do not keep or train on them, unless explicitly relaxed.
  const strictPrivacy = process.env.OPENROUTER_ALLOW_DATA_COLLECTION !== "1";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let res: Response;
    try {
      res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      signal: AbortSignal.timeout(110000),
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "x-title": "Notique VA Console",
      },
      body: JSON.stringify({
        model: models[0],
        models,
        messages,
        temperature: 0.1,
        response_format: { type: "json_object" },
        ...(strictPrivacy ? { provider: { data_collection: "deny" } } : {}),
      }),
      });
    } catch (err) {
      lastError = (err as Error)?.name === "TimeoutError" ? "The model took too long to answer." : "Could not reach the model.";
      continue;
    }
    const body = await res.json().catch(() => ({}));
    const content: unknown = body?.choices?.[0]?.message?.content;
    if (typeof body?.model === "string") lastModelUsed = body.model;
    if (res.ok && typeof content === "string" && content.trim()) {
      const parsed = parseLooseJson(content);
      if (parsed !== null) return parsed;
      lastError = "The model returned text that was not valid JSON.";
      continue;
    }
    lastError = body?.error?.message ?? res.statusText ?? "Unknown error";
    if (res.status === 401 || res.status === 402) break;
  }
  throw new PipelineError(`AI extraction failed: ${lastError}`);
}

function parseLooseJson(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export interface ExtractedFact {
  section: Section;
  statement: string;
  lineIdx: number[];
  confidence: number;
  change_type: "new" | "changed";
  changed_from: string | null;
  supersedes_id: string | null;
  follow_up_date: string | null;
  follow_up_condition: string | null;
  suggested_task: SuggestedTask | null;
}

export interface Extraction {
  facts: ExtractedFact[];
  summary: string;
  speakers: Record<string, string>;
}

const SECTION_KEYS: Section[] = ["decisions", "budget", "needs", "questions", "risks", "next_steps"];

const SYSTEM_PROMPT = `You prepare draft notes for a human assistant who supports a US real estate agent.
You read one conversation or message thread between the agent and their client, and propose candidate facts.
A human verifies every candidate against the transcript before the agent sees anything, so precision matters more than coverage.

Return one JSON object with this exact shape:
{
  "summary": "two or three plain sentences on what happened in this event",
  "speakers": { "<generic label such as Speaker A>": "<the person's real name, only when the transcript makes it clear; omit labels that are already names>" },
  "facts": [
    {
      "section": "decisions" | "budget" | "needs" | "questions" | "risks" | "next_steps",
      "statement": "one short sentence, specific, in English",
      "lines": [<line numbers that directly support the statement>],
      "confidence": <number from 0 to 1>,
      "change_type": "new" | "changed",
      "changed_from": "<the earlier value only, at most five words, such as $900,000 or two bedrooms; omit when the change is not a value>",
      "supersedes_id": "<id of the earlier verified fact this replaces, answers, or settles; only when one is listed>",
      "follow_up_date": "<YYYY-MM-DD only if the conversation names a date by which something should be followed up>",
      "follow_up_condition": "<the condition the client said they are waiting on, in a few words, if any>",
      "suggested_task": { "title": "...", "description": "...", "category": "Research" | "Listing shortlist" | "Comparison table" | "Follow-up draft" | "Meeting brief" | "Document prep" | "Other", "est_minutes": <integer> }
    }
  ]
}

Sections:
decisions: something the client or agent decided, including ruling a property or area in or out, and the reason.
budget: price ceiling, monthly payment limit, down payment, pre-approval, financing status.
needs: must-haves, nice-to-haves, and deal breakers for the property, and any change to them.
questions: a question that was asked and not answered in this event, or something the agent promised to find out.
risks: concerns, objections, hesitations, or anything that could stall the deal.
next_steps: agreed actions with an owner, such as scheduling a showing or sending listings.

Rules:
1. Every fact must cite at least one line number that exists in the transcript. Cite the fewest lines that prove it, usually one and at most three. Never cite a line that does not support the statement on its own, such as a transition or an acknowledgement.
2. Keep amounts, dates, addresses, and conditions exactly as said. Keep qualifiers such as "if", "unless", "about".
3. Do not infer financial ability, intent, or personal characteristics that were not said. Fair housing: never mention race, color, religion, national origin, sex, disability, familial status (marital status, children, pregnancy), age, or military or veteran status, in any fact or in the summary, even when the client volunteers it. Record the property requirement instead, for example "needs at least four bedrooms" rather than "has three kids", "no school district preference" rather than "his son is in elementary school", and "plans to use a VA loan" rather than "is a veteran". Before returning, reread every statement and the summary and remove any mention of a spouse, children, family, age, retirement, religion, disability, or military service.
4. Use change_type "changed" only when the transcript itself or the earlier verified facts show a different earlier value.
5. Calibrate confidence honestly. Use 0.9 or above only when a speaker states the fact directly and unambiguously. Use 0.7 to 0.85 when you combined two lines, paraphrased loosely, or resolved a pronoun or a spoken number. Use 0.4 to 0.6 when the wording is hedged ("might", "maybe", "not decided"), the speaker is unclear, or a number might belong to another topic. Do not give every fact the same score.
10. If something that matters for the deal came up but was left unsettled or never asked (which school, which lender, a deadline, who else decides), record it in "questions", phrased as the question the agent should ask the client next, citing the line where it came up.
9. Record only what an agent would need to move this deal forward. Skip small talk, compliments, and general impressions. Do not record the same point twice in different sections; pick the best section. Most conversations yield 3 to 8 facts.
6. Include suggested_task only for questions and next_steps where a remote assistant could do the work from documents and online research, such as finding listings, building a comparison, preparing a brief, or drafting a follow-up for the agent to send. The assistant never phones or messages the client or third parties. Omit suggested_task otherwise. The agent reads suggested_task and sends it to the assistant with one tap, so write title and description in the agent's own voice as an instruction to the assistant ("Draft a follow-up email to Michael about...", "Find out whether..."), never "the agent" in the third person, and do not repeat a date that will already have passed.
7. Omit optional fields that do not apply. Do not add commentary outside the JSON.
11. The agent reads every fact. Refer to the agent by the first name given above, never as "the agent", for example "Sarah will send three comparable sales this week".
12. When this conversation settles, answers, or replaces an earlier verified fact, set supersedes_id on the new fact to that earlier fact's id, so the old line is retired and the agent never sees two versions side by side. This covers: an offer amount or plan that changed; a decision that was reversed; an open question that now has an answer; a risk that turned out not to be one. An answer is never itself an open question: file it where it belongs (a decision, budget, needs, or a risk that remains) and point supersedes_id at the question it answers. Example: earlier question "Are the solar panels owned or leased?" and earlier risk "The solar panels may be leased"; the client now says they are owned, so write a decision "The solar panels are owned and come with the house" with supersedes_id set to the risk or question it settles (pick the one it most directly replaces). Use each earlier id at most once.
13. Do not put a suggested_task on a fact when the same work is already in the list of requested or suggested work above.
8. If the event contains nothing relevant, return an empty facts array.`;

export async function extractFacts(input: {
  lines: RawLine[];
  eventTitle: string;
  eventType: string;
  occurredAt: string;
  project: { client_name: string; deal_type: string; area: string | null; budget: string | null };
  priorFacts: { id: string; section: string; statement: string }[];
  /** First name of the agent who owns the project, so facts never say "the agent". */
  agentName?: string | null;
  /** Work already requested or suggested, so it is not suggested again. */
  openRequests?: string[];
  /** Force one model with no fallback. Used to compare models. */
  model?: string;
}): Promise<Extraction> {
  const transcript = input.lines
    .map((l, i) => {
      const ts = l.start_ms !== null ? ` [${formatMs(l.start_ms)}]` : "";
      return `${i + 1}${ts} ${l.speaker}: ${l.text}`;
    })
    .join("\n");
  const prior = input.priorFacts.length
    ? input.priorFacts.map((f) => `${f.id} | ${f.section} | ${f.statement}`).join("\n")
    : "None yet.";
  const user = `Agent: ${input.agentName ?? "not known"}
Client: ${input.project.client_name} (${input.project.deal_type})
Area: ${input.project.area ?? "not set"}
Budget on file: ${input.project.budget ?? "not set"}
Event: ${input.eventTitle} (${input.eventType}), ${input.occurredAt.slice(0, 10)}

Earlier verified facts for this client (id | section | statement):
${prior}

Work already requested from the assistant or already suggested (do not suggest these again):
${input.openRequests?.length ? input.openRequests.map((t) => `- ${t}`).join("\n") : "None."}

Transcript, one numbered line per turn:
${transcript}`;

  const raw = (await chatJson([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ], input.model)) as Record<string, unknown>;

  const priorIds = new Set(input.priorFacts.map((f) => f.id));
  const facts: ExtractedFact[] = [];
  const rawFacts = Array.isArray(raw?.facts) ? (raw.facts as Record<string, unknown>[]) : [];
  for (const f of rawFacts) {
    const section = String(f.section ?? "") as Section;
    const statement = String(f.statement ?? "").trim();
    if (!SECTION_KEYS.includes(section) || statement.length < 3) continue;
    const lineIdx = (Array.isArray(f.lines) ? f.lines : [])
      .map((n) => Number(n) - 1)
      .filter((n) => Number.isInteger(n) && n >= 0 && n < input.lines.length);
    const unique = Array.from(new Set(lineIdx)).slice(0, 4);
    if (unique.length === 0) continue;
    const conf = Number(f.confidence);
    const st = f.suggested_task as Record<string, unknown> | undefined;
    const allowTask = section === "questions" || section === "next_steps";
    const date = typeof f.follow_up_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.follow_up_date) ? f.follow_up_date : null;
    const supersedes = typeof f.supersedes_id === "string" && priorIds.has(f.supersedes_id) ? f.supersedes_id : null;
    const changed = f.change_type === "changed";
    facts.push({
      section,
      statement: statement.slice(0, 400),
      lineIdx: unique,
      confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.5,
      change_type: changed ? "changed" : "new",
      changed_from: changed && typeof f.changed_from === "string" && f.changed_from.trim() && f.changed_from.trim().length <= 40 ? f.changed_from.trim() : null,
      supersedes_id: changed ? supersedes : null,
      follow_up_date: date,
      follow_up_condition:
        typeof f.follow_up_condition === "string" && f.follow_up_condition.trim()
          ? f.follow_up_condition.trim().slice(0, 160)
          : null,
      suggested_task:
        allowTask && st && typeof st.title === "string" && st.title.trim()
          ? {
              title: st.title.trim().slice(0, 140),
              description: String(st.description ?? "").trim().slice(0, 600),
              category: String(st.category ?? "Research").slice(0, 40),
              est_minutes: Number.isFinite(Number(st.est_minutes)) ? Math.max(5, Math.round(Number(st.est_minutes))) : null,
            }
          : null,
    });
  }

  const speakers: Record<string, string> = {};
  if (raw?.speakers && typeof raw.speakers === "object") {
    for (const [k, v] of Object.entries(raw.speakers as Record<string, unknown>)) {
      // Only rename generic labels. A label that is already a name must not be replaced by a role.
      if (typeof v === "string" && v.trim() && v.trim() !== k && /^(speaker|note|me|unknown|client|agent)\b/i.test(k) && !/^(speaker|unknown)\b/i.test(v.trim())) speakers[k] = v.trim().slice(0, 40);
    }
  }
  return {
    facts: facts.slice(0, 40),
    summary: typeof raw?.summary === "string" ? raw.summary.trim().slice(0, 600) : "",
    speakers,
  };
}

/** Reads text message screenshots into "Sender: message" lines. */
export async function transcribeScreenshots(imageUrls: string[]): Promise<string> {
  const raw = (await chatJson([
    {
      role: "system",
      content:
        'You transcribe screenshots of text message or email threads exactly as written. Return JSON: {"messages":[{"sender":"name or Me or Client","time":"as shown or empty","text":"exact message text"}]} in reading order. Do not summarize or correct anything.',
    },
    {
      role: "user",
      content: [
        { type: "text", text: "Transcribe every message in these screenshots, in order." },
        ...imageUrls.map((url) => ({ type: "image_url" as const, image_url: { url } })),
      ],
    },
  ])) as { messages?: { sender?: string; text?: string }[] };
  const msgs = Array.isArray(raw?.messages) ? raw.messages : [];
  return msgs
    .filter((m) => typeof m.text === "string" && m.text.trim())
    .map((m) => `${(m.sender ?? "Speaker").toString().trim() || "Speaker"}: ${m.text!.trim().replace(/\n+/g, " ")}`)
    .join("\n");
}

export function formatMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}


/* ------------------------------------------------------------------ */
/* Watches: a condition checked against the live web                    */
/* ------------------------------------------------------------------ */

export interface WatchResult {
  met: boolean;
  /** One or two sentences on what was found, with the figure and its date. */
  summary: string;
  sources: { title: string; url: string }[];
  model: string | null;
}

const WATCH_PROMPT = `You check whether a real estate market condition is currently true, using web search.
Today is {today}.
Rules:
1. Search for current, dated figures from primary or well known sources (for mortgage rates: Freddie Mac, Mortgage News Daily, Bankrate; for listings and prices: the listing portals or the local association).
2. Only answer met=true when a source dated within the last 7 days clearly supports it. If the evidence is old, mixed, or missing, answer met=false and say what you found.
3. The summary states the figure, the source name, and the date of the figure, in at most two sentences. No advice.
4. Never include names of private people in searches.
Return only JSON: {"met": true or false, "summary": "...", "sources": [{"title": "...", "url": "https://..."}]}`;

/** Number of web searches the provider reports for this request. Native search and OpenRouter's own tool report it under different keys. */
function searchCount(usage: unknown, depth = 0): number {
  if (!usage || typeof usage !== "object" || depth > 3) return 0;
  let n = 0;
  for (const [key, value] of Object.entries(usage as Record<string, unknown>)) {
    if (typeof value === "number" && /^(web_search_requests|tool_calls_requested|web_search_count)$/.test(key)) n += value;
    else if (value && typeof value === "object") n += searchCount(value, depth + 1);
  }
  return n;
}

/** Asks a model with live web search whether the condition holds right now. */
export async function checkCondition(condition: string): Promise<WatchResult> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new PipelineError("AI is not configured. Add OPENROUTER_API_KEY in Vercel and redeploy.");
  const configured = (process.env.OPENROUTER_WATCH_MODEL ?? process.env.OPENROUTER_MODEL ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  const model = configured[0] ?? DEFAULT_MODELS[0];
  const messages = [
    { role: "system", content: WATCH_PROMPT.replace("{today}", new Date().toISOString().slice(0, 10)) },
    { role: "user", content: `Condition to check: ${condition.slice(0, 500)}` },
  ];
  // The server tool is the current interface. The plugin form is kept as a fallback for accounts or models that reject it.
  const variants: Record<string, unknown>[] = [{ tools: [{ type: "openrouter:web_search", parameters: { max_results: 5 } }] }, { plugins: [{ id: "web", max_results: 5 }] }];
  let lastError = "";
  for (const extra of variants) {
    let res: Response;
    try {
      res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        signal: AbortSignal.timeout(90000),
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-title": "Notique VA Console" },
        body: JSON.stringify({ model, messages, temperature: 0, ...extra }),
      });
    } catch (err) {
      lastError = (err as Error)?.name === "TimeoutError" ? "The search took too long." : "Could not reach the model.";
      continue;
    }
    const body = await res.json().catch(() => ({}));
    const message = body?.choices?.[0]?.message;
    const content: unknown = message?.content;
    if (!res.ok || typeof content !== "string" || !content.trim()) {
      lastError = body?.error?.message ?? res.statusText ?? "Unknown error";
      if (res.status === 401 || res.status === 402) break;
      continue;
    }
    const parsed = parseLooseJson(content) as { met?: unknown; summary?: unknown; sources?: unknown } | null;
    if (!parsed || typeof parsed.summary !== "string") {
      lastError = "The model did not return a usable answer.";
      continue;
    }
    const sources: { title: string; url: string }[] = [];
    const push = (title: unknown, url: unknown) => {
      if (typeof url !== "string" || !/^https?:\/\//i.test(url) || sources.some((x) => x.url === url)) return;
      sources.push({ title: typeof title === "string" && title.trim() ? title.trim().slice(0, 140) : new URL(url).hostname, url: url.slice(0, 500) });
    };
    // Prefer the citations the search engine attached over links the model typed out.
    for (const a of Array.isArray(message?.annotations) ? message.annotations : []) push(a?.url_citation?.title, a?.url_citation?.url);
    // Proof that a search really ran: citations attached by the engine, or the search count in the usage report.
    // Links the model typed on its own do not count.
    const searched = sources.length > 0 || searchCount(body?.usage) > 0;
    if (!searched && extra !== variants[variants.length - 1]) {
      lastError = "The model answered without searching.";
      continue;
    }
    for (const x of Array.isArray(parsed.sources) ? parsed.sources : []) push((x as { title?: unknown })?.title, (x as { url?: unknown })?.url);
    if (!searched) return { met: false, summary: `Not confirmed by a live search. ${parsed.summary.trim()}`.slice(0, 600), sources: sources.slice(0, 5), model: typeof body?.model === "string" ? body.model : model };
    return { met: parsed.met === true, summary: parsed.summary.trim().slice(0, 600), sources: sources.slice(0, 5), model: typeof body?.model === "string" ? body.model : model };
  }
  throw new PipelineError(`The check could not run: ${lastError}`);
}

/** Drafts the note a user could send their client once a watched condition is met. A VA reviews it before delivery. */
export async function draftFollowUp(input: { clientName: string; condition: string; finding: string; note: string | null; facts: string[] }): Promise<string> {
  const raw = (await chatJson([
    {
      role: "system",
      content:
        'You draft a short follow-up message a real estate agent sends to their own client. Use only the verified facts given. Be specific about what changed and why it matters to this client, suggest one next step, and keep it under 110 words. No pressure tactics, no promises about the market, and never mention race, religion, national origin, sex, disability, family status, or age. Return JSON: {"message": "..."}',
    },
    { role: "user", content: JSON.stringify({ client: input.clientName, condition_now_true: input.condition, what_we_found: input.finding, why_it_matters: input.note, verified_facts_about_this_deal: input.facts.slice(0, 25) }) },
  ])) as { message?: unknown } | null;
  return typeof raw?.message === "string" ? raw.message.trim().slice(0, 1200) : "";
}


/* ------------------------------------------------------------------ */
/* First drafts for tickets                                             */
/* ------------------------------------------------------------------ */

export interface DraftResult {
  body: string;
  /** Things the VA has to look up or confirm before this can be delivered. */
  gaps: string[];
  sources: { title: string; url: string }[];
  model: string | null;
}

const DRAFT_PROMPT = `You prepare the first draft of a deliverable for a real estate agent. A human assistant will check and finish it before the agent sees it.
Rules:
1. Use only the verified facts given about this client and deal. Never invent addresses, prices, listings, names, dates, or numbers.
2. Where something is needed that you do not have, write a bracketed placeholder in the text, for example [ADD: three comparable sales near Maple St], and list it in "gaps".
3. Write the deliverable itself, ready to edit: an email or message in the agent's voice, a checklist, a comparison outline, a call script, or a short research brief, whichever the request calls for.
4. Plain text. Short paragraphs. No markdown symbols. Under 350 words.
5. Fair housing: never mention or steer on race, color, religion, national origin, sex, disability, familial status, age, or military status. Describe properties and requirements, not people.
6. No pressure tactics and no promises about the market.
Return only JSON: {"draft": "...", "gaps": ["..."]}`;

/** Drafts a ticket's deliverable from the verified deal profile. */
export async function draftDeliverable(input: { title: string; description: string; category: string; clientName: string; dealType: string; area: string | null; budget: string | null; facts: string[]; thread: string[]; instructions?: string | null }): Promise<DraftResult> {
  const raw = (await chatJson([
    { role: "system", content: DRAFT_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        request: { title: input.title, details: input.description, category: input.category },
        client: { name: input.clientName, deal: input.dealType, area: input.area, budget: input.budget },
        verified_facts: input.facts.slice(0, 40),
        messages_on_this_ticket: input.thread.slice(-8),
        extra_instructions_from_the_assistant: input.instructions ?? null,
      }),
    },
  ])) as { draft?: unknown; gaps?: unknown } | null;
  const body = typeof raw?.draft === "string" ? raw.draft.trim().slice(0, 6000) : "";
  if (!body) throw new PipelineError("The model did not return a draft.");
  const gaps = Array.isArray(raw?.gaps) ? raw.gaps.filter((g): g is string => typeof g === "string" && !!g.trim()).map((g) => g.trim().slice(0, 200)).slice(0, 10) : [];
  return { body, gaps, sources: [], model: lastModelUsed };
}
