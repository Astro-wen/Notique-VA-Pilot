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
  const m = text.match(/^([A-Za-zÀ-ɏ一-鿿][^:：\n]{0,40})[:：]\s+(.+)$/);
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

export async function startTranscription(audioUrl: string): Promise<string> {
  const res = await fetch(`${AAI}/transcript`, {
    method: "POST",
    headers: { authorization: aaiKey(), "content-type": "application/json" },
    body: JSON.stringify({ audio_url: audioUrl, speaker_labels: true, punctuate: true, format_text: true, language_detection: true }),
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
      "supersedes_id": "<id of the earlier verified fact this replaces, only when one is listed and clearly replaced>",
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
6. Include suggested_task only for questions and next_steps where a remote assistant could do the work from documents and online research, such as finding listings, building a comparison, preparing a brief, or drafting a follow-up for the agent to send. The assistant never phones or messages the client or third parties. Omit suggested_task otherwise.
7. Omit optional fields that do not apply. Do not add commentary outside the JSON.
8. If the event contains nothing relevant, return an empty facts array.`;

export async function extractFacts(input: {
  lines: RawLine[];
  eventTitle: string;
  eventType: string;
  occurredAt: string;
  project: { client_name: string; deal_type: string; area: string | null; budget: string | null };
  priorFacts: { id: string; section: string; statement: string }[];
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
  const user = `Client: ${input.project.client_name} (${input.project.deal_type})
Area: ${input.project.area ?? "not set"}
Budget on file: ${input.project.budget ?? "not set"}
Event: ${input.eventTitle} (${input.eventType}), ${input.occurredAt.slice(0, 10)}

Earlier verified facts for this client (id | section | statement):
${prior}

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
