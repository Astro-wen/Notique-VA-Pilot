/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomBytes, randomUUID } from "node:crypto";
import { after } from "next/server";
import { BUCKET, db } from "./supabase";
import { nextBusinessDayNine, startOfWeekUtc } from "./time";
import {
  PipelineError,
  checkCondition,
  docxToText,
  draftFollowUp,
  extractFacts,
  getTranscription,
  lastModelUsed,
  parseTranscriptText,
  startTranscription,
  transcribeScreenshots,
  type RawLine,
} from "./pipeline";
import type {
  AdminUser,
  AgentSummary,
  EventDetail,
  EventRow,
  EventSource,
  Evidence,
  Fact,
  FileRow,
  MeResult,
  Profile,
  Project,
  ProjectDetail,
  ProjectListItem,
  QcResult,
  QueueEvent,
  QueueResult,
  Section,
  ShareView,
  Task,
  TaskDetail,
  TaskMessage,
  Verdict,
  CheckinItem,
  CheckinResult,
  Watch,
} from "@/lib/types";

export class RpcError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface Ctx {
  profile: Profile | null;
}

type Handler = (ctx: Ctx, args: any) => Promise<unknown>;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function q<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new RpcError(`Database error: ${res.error.message}`, 500);
  return res.data as T;
}

function me(ctx: Ctx): Profile {
  if (!ctx.profile) throw new RpcError("Please sign in again.", 401);
  return ctx.profile;
}

function isStaff(p: Profile): boolean {
  return p.role === "va" || p.role === "admin";
}

function staff(ctx: Ctx): Profile {
  const p = me(ctx);
  if (!isStaff(p)) throw new RpcError("This action is only available to the VA team.", 403);
  return p;
}

function admin(ctx: Ctx): Profile {
  const p = me(ctx);
  if (p.role !== "admin") throw new RpcError("This action is only available to admins.", 403);
  return p;
}

function str(v: unknown, label: string, max = 500): string {
  if (typeof v !== "string" || !v.trim()) throw new RpcError(`${label} is required.`);
  return v.trim().slice(0, max);
}

/** Rejects text over the limit instead of silently cutting the end off. */
function longText(v: unknown, label: string, max: number): string {
  if (typeof v !== "string" || !v.trim()) throw new RpcError(`${label} is required.`);
  if (v.trim().length > max) throw new RpcError(`${label} can be at most ${max} characters. It is ${v.trim().length} now.`);
  return v.trim();
}

function optStr(v: unknown, max = 500): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A record id from the client. Anything that is not a UUID is treated as not found instead of reaching the database. */
function uid(v: unknown, label: string): string {
  if (typeof v !== "string" || !UUID.test(v.trim())) throw new RpcError(`${label} not found.`, 404);
  return v.trim();
}

/** Passwords are used exactly as typed. Trimming would make the saved password differ from what the admin entered. */
function password(v: unknown, label: string): string {
  if (typeof v !== "string" || v.length < 8) throw new RpcError(`${label} must be at least 8 characters.`);
  if (v.length > 200) throw new RpcError(`${label} is too long.`);
  return v;
}

function timezone(v: unknown): string {
  const tz = typeof v === "string" ? v.trim() : "";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    if (tz) return tz;
  } catch {
    /* fall through */
  }
  throw new RpcError("Choose a valid time zone, for example America/Los_Angeles.");
}

/** Storage keys are issued by createUpload. Only that exact shape is accepted, so a key can never point outside its project. */
function ownKey(path: string, prefix: string): boolean {
  return path.startsWith(prefix) && /^[A-Za-z0-9._/-]+$/.test(path) && !path.includes("..") && !path.includes("//") && path.slice(prefix.length).indexOf("/") === -1;
}

/** Long enough to mean something. Chinese, Japanese and Korean say more per character. */
function enoughText(text: string): boolean {
  const t = text.trim();
  return t.length >= 20 || (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(t) && t.length >= 6);
}

async function assertAgentAccess(p: Profile, agentId: string): Promise<void> {
  if (p.role === "admin") return;
  if (p.role === "agent") {
    if (p.id !== agentId) throw new RpcError("You do not have access to this user.", 403);
    return;
  }
  const rows = q(await db().from("assignments").select("agent_id").eq("va_id", p.id).eq("agent_id", agentId));
  if (!rows || (rows as any[]).length === 0) throw new RpcError("This user is not assigned to you.", 403);
}

async function loadProject(p: Profile, projectId: unknown): Promise<Project> {
  const id = uid(projectId, "Project");
  const row = q(await db().from("projects").select("*").eq("id", id).maybeSingle()) as Project | null;
  if (!row) throw new RpcError("Project not found.", 404);
  await assertAgentAccess(p, row.agent_id);
  return row;
}

async function loadEvent(p: Profile, eventId: unknown): Promise<EventRow & { raw_text: string | null; stt_id: string | null; source_path: string | null }> {
  const id = uid(eventId, "Event");
  const row = q(await db().from("events").select("*").eq("id", id).maybeSingle()) as any;
  if (!row) throw new RpcError("Event not found.", 404);
  await assertAgentAccess(p, row.agent_id);
  return row;
}

async function loadTask(p: Profile, taskId: unknown): Promise<Task> {
  const id = uid(taskId, "Task");
  const row = q(await db().from("tasks").select("*").eq("id", id).maybeSingle()) as Task | null;
  if (!row) throw new RpcError("Task not found.", 404);
  await assertAgentAccess(p, row.agent_id);
  return row;
}

async function audit(p: Profile | null, action: string, type: string, id: string, detail?: unknown) {
  await db().from("audit_log").insert({ actor_id: p?.id ?? null, action, object_type: type, object_id: id, detail: detail ?? null });
}

async function nameMap(ids: (string | null | undefined)[]): Promise<Record<string, string>> {
  const unique = Array.from(new Set(ids.filter(Boolean))) as string[];
  if (unique.length === 0) return {};
  const rows = q(await db().from("profiles").select("id,name").in("id", unique)) as { id: string; name: string }[];
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

function pauseTimerPatch(task: Task): Record<string, unknown> {
  if (!task.timer_started_at) return {};
  const add = Math.max(0, Date.now() - new Date(task.timer_started_at).getTime());
  return { logged_ms: Number(task.logged_ms) + Math.min(add, 12 * 3600 * 1000), timer_started_at: null };
}

async function systemMessage(taskId: string, body: string) {
  await db().from("task_messages").insert({ task_id: taskId, sender_role: "system", channel: "in_app", body });
}

function stripEvent(e: any, forAgent = false): EventRow {
  const { raw_text: _r, stt_id: _s, source_path: _p, submitted_by: _b, created_by: _c, ...rest } = e;
  void _r; void _s; void _p; void _b; void _c;
  if (!forAgent) return rest as EventRow;
  // Agents only get what a VA has verified. The AI summary and internal review data stay on the VA side.
  return { ...rest, summary: rest.status === "submitted" ? rest.summary : null, checks: {}, review_ms: 0, escalation_note: null, audio_path: null, speaker_map: {}, error: rest.status === "failed" ? rest.error : null } as EventRow;
}

async function fetchLines(eventId: string): Promise<any[]> {
  const all: any[] = [];
  for (let from = 0; from < 8000; from += 1000) {
    const page = q(await db().from("transcript_lines").select("*").eq("event_id", eventId).order("idx").range(from, from + 999)) as any[];
    all.push(...page);
    if (page.length < 1000) break;
  }
  return all;
}

/* ------------------------------------------------------------------ */
/* Processing                                                          */
/* ------------------------------------------------------------------ */

async function setEventStatus(id: string, status: string, extra: Record<string, unknown> = {}) {
  q(await db().from("events").update({ status, status_changed_at: new Date().toISOString(), ...extra }).eq("id", id).select("id"));
}

async function failEvent(id: string, err: unknown) {
  const message = err instanceof PipelineError || err instanceof RpcError ? err.message : `Processing failed: ${(err as Error)?.message ?? "unknown error"}`;
  // Only work that is still in flight can fail. A late error from a second worker must not undo a finished event.
  q(await db().from("events").update({ status: "failed", status_changed_at: new Date().toISOString(), error: message.slice(0, 500) }).eq("id", id).in("status", ["processing", "extracting"]).select("id"));
}

async function insertLines(eventId: string, lines: RawLine[]) {
  await db().from("transcript_lines").delete().eq("event_id", eventId);
  const rows = lines.map((l, idx) => ({ event_id: eventId, idx, start_ms: l.start_ms, speaker: l.speaker.slice(0, 60), text: l.text }));
  for (let i = 0; i < rows.length; i += 500) {
    q(await db().from("transcript_lines").insert(rows.slice(i, i + 500)).select("id"));
  }
}

async function runExtraction(eventId: string) {
  const event = q(await db().from("events").select("*").eq("id", eventId).single()) as any;
  const project = q(await db().from("projects").select("*").eq("id", event.project_id).single()) as Project;
  const lines = await fetchLines(eventId);
  if (lines.length === 0) throw new PipelineError("No readable text was found in this upload.");

  const submitted = q(await db().from("events").select("id").eq("project_id", project.id).eq("status", "submitted")) as { id: string }[];
  let prior: { id: string; section: string; statement: string }[] = [];
  if (submitted.length) {
    prior = q(
      await db()
        .from("facts")
        .select("id,section,statement")
        .eq("project_id", project.id)
        .in("event_id", submitted.map((e) => e.id))
        .in("verdict", ["approved", "edited"])
        .is("resolved_at", null)
        .order("created_at", { ascending: false })
        .limit(60),
    ) as any[];
  }

  const result = await extractFacts({
    lines: lines.map((l) => ({ start_ms: l.start_ms, speaker: l.speaker, text: l.text })),
    eventTitle: event.title,
    eventType: event.event_type,
    occurredAt: event.occurred_at,
    project,
    priorFacts: prior,
  });

  // Another run may have finished while the model was working. Never overwrite facts a VA is already deciding on.
  const current = q(await db().from("events").select("status").eq("id", eventId).single()) as { status: string };
  if (current.status !== "extracting") return;
  await db().from("facts").delete().eq("event_id", eventId).eq("origin", "ai");
  const order: Section[] = ["decisions", "budget", "needs", "questions", "risks", "next_steps"];
  const sorted = [...result.facts].sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section) || a.lineIdx[0] - b.lineIdx[0]);
  const rows = sorted.map((f, position) => {
    const evidence: Evidence[] = f.lineIdx.map((i) => ({
      line_id: lines[i].id,
      idx: lines[i].idx,
      start_ms: lines[i].start_ms,
      speaker: lines[i].speaker,
      quote: lines[i].text,
    }));
    return {
      event_id: eventId,
      project_id: project.id,
      section: f.section,
      statement: f.statement,
      ai_statement: f.statement,
      confidence: f.confidence,
      change_type: f.change_type,
      changed_from: f.changed_from,
      supersedes_id: f.supersedes_id,
      follow_up_date: f.follow_up_date,
      follow_up_condition: f.follow_up_condition,
      evidence,
      suggested_task: f.suggested_task,
      origin: "ai",
      position,
    };
  });
  if (rows.length) q(await db().from("facts").insert(rows).select("id"));

  await audit(null, "event.extract", "event", eventId, { model: lastModelUsed, facts: rows.length });
  const speakerMap = { ...(result.speakers ?? {}), ...(event.speaker_map ?? {}) };
  q(
    await db()
      .from("events")
      .update({ status: "ready", status_changed_at: new Date().toISOString(), summary: result.summary || null, speaker_map: speakerMap, error: null })
      .eq("id", eventId)
      .eq("status", "extracting")
      .select("id"),
  );
}

async function processText(eventId: string, text: string) {
  const lines = parseTranscriptText(text);
  if (lines.length === 0) throw new PipelineError("No readable text was found in this upload.");
  await insertLines(eventId, lines);
  await runExtraction(eventId);
}

/** Reads an uploaded file, a set of screenshots, or pasted text into transcript lines, then drafts facts. */
async function ingestSource(eventId: string, src: { imagePaths?: string[]; filePath?: string | null; text?: string | null }) {
  let body = src.text ?? "";
  if (src.imagePaths?.length) {
    const urls = await Promise.all(src.imagePaths.map((path) => signedUrl(path, 1800)));
    body = await transcribeScreenshots(urls);
  } else if (src.filePath) {
    const dl = await db().storage.from(BUCKET).download(src.filePath);
    if (dl.error || !dl.data) throw new PipelineError(`Could not read the uploaded file: ${dl.error?.message ?? "unknown error"}`);
    const buffer = Buffer.from(await dl.data.arrayBuffer());
    body = /\.docx$/i.test(src.filePath) ? await docxToText(buffer) : buffer.toString("utf8");
  }
  q(await db().from("events").update({ raw_text: body.slice(0, 400000) }).eq("id", eventId).select("id"));
  await processText(eventId, body);
}

/** Runs slow work after the response has been sent, so dialogs never wait on the AI. */
function inBackground(eventId: string, work: () => Promise<void>) {
  const run = async () => {
    try {
      await work();
    } catch (err) {
      await failEvent(eventId, err).catch(() => {});
    }
  };
  try {
    after(run);
  } catch {
    void run();
  }
}

async function signedUrl(path: string, seconds: number, download?: string): Promise<string> {
  const res = await db().storage.from(BUCKET).createSignedUrl(path, seconds, download ? { download } : undefined);
  if (res.error || !res.data) throw new RpcError(`Could not open file: ${res.error?.message ?? "unknown error"}`, 500);
  return res.data.signedUrl;
}

async function startAudio(eventId: string, audioPath: string) {
  const url = await signedUrl(audioPath, 6 * 3600);
  const sttId = await startTranscription(url);
  await setEventStatus(eventId, "processing", { stt_id: sttId, error: null });
}

/** Moves a processing event forward if the transcription has finished. */
async function advanceEvent(event: any): Promise<void> {
  if (event.status === "processing" && !event.stt_id) {
    if (Date.now() - new Date(event.status_changed_at).getTime() > 5 * 60 * 1000) {
      await failEvent(event.id, new PipelineError("Transcription did not start. Press Retry."));
    }
    return;
  }
  if (event.status === "processing" && event.stt_id) {
    const stt = await getTranscription(event.stt_id);
    if (stt.status === "error") {
      await failEvent(event.id, new PipelineError(`Transcription failed: ${stt.error ?? "unknown error"}`));
      return;
    }
    if (stt.status !== "completed") return;
    const claimed = q(
      await db()
        .from("events")
        .update({ status: "extracting", status_changed_at: new Date().toISOString(), duration_sec: stt.durationSec ?? event.duration_sec })
        .eq("id", event.id)
        .eq("status", "processing")
        .select("id"),
    ) as any[];
    if (claimed.length === 0) return;
    try {
      if (!stt.lines || stt.lines.length === 0) throw new PipelineError("The recording did not contain any speech we could transcribe.");
      await insertLines(event.id, stt.lines);
      await runExtraction(event.id);
    } catch (err) {
      await failEvent(event.id, err);
    }
    return;
  }
  if (event.status === "extracting") {
    const age = Date.now() - new Date(event.status_changed_at).getTime();
    if (age < 4 * 60 * 1000) return;
    const claimed = q(
      await db()
        .from("events")
        .update({ status_changed_at: new Date().toISOString() })
        .eq("id", event.id)
        .eq("status", "extracting")
        .eq("status_changed_at", event.status_changed_at)
        .select("id"),
    ) as any[];
    if (claimed.length === 0) return;
    try {
      const lines = q(await db().from("transcript_lines").select("id").eq("event_id", event.id).limit(1)) as any[];
      if (lines.length) {
        await runExtraction(event.id);
      } else if (event.raw_text) {
        await processText(event.id, event.raw_text);
      } else {
        // The background read never finished. Fail it so Retry can pick it up again.
        throw new PipelineError("Reading this upload did not finish. Press Retry.");
      }
    } catch (err) {
      await failEvent(event.id, err);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Shared builders                                                     */
/* ------------------------------------------------------------------ */

async function agentSummaries(p: Profile): Promise<AgentSummary[]> {
  if (p.role === "agent") return [];
  let agents: Profile[];
  if (p.role === "admin") {
    agents = q(await db().from("profiles").select("*").eq("role", "agent").order("name")) as Profile[];
  } else {
    const links = q(await db().from("assignments").select("agent_id").eq("va_id", p.id)) as { agent_id: string }[];
    if (links.length === 0) return [];
    agents = q(await db().from("profiles").select("*").in("id", links.map((l) => l.agent_id)).order("name")) as Profile[];
  }
  if (agents.length === 0) return [];
  const pending = q(
    await db().from("events").select("agent_id").in("agent_id", agents.map((a) => a.id)).in("status", ["ready", "in_review"]),
  ) as { agent_id: string }[];
  return agents.map((a) => ({
    id: a.id,
    name: a.name,
    company: a.company,
    timezone: a.timezone,
    pending_events: pending.filter((e) => e.agent_id === a.id).length,
  }));
}

async function projectList(agentId: string): Promise<ProjectListItem[]> {
  const projects = q(await db().from("projects").select("*").eq("agent_id", agentId).is("archived_at", null).order("created_at", { ascending: false })) as Project[];
  if (projects.length === 0) return [];
  const ids = projects.map((p) => p.id);
  const events = q(await db().from("events").select("project_id,status,occurred_at,due_at").in("project_id", ids)) as any[];
  const tasks = q(await db().from("tasks").select("project_id,status,agent_feedback").in("project_id", ids)) as any[];
  return projects.map((p) => {
    const ev = events.filter((e) => e.project_id === p.id);
    const last = ev.map((e) => e.occurred_at).sort().pop() ?? null;
    return {
      ...p,
      event_count: ev.filter((e) => e.status === "submitted").length,
      pending_events: ev.filter((e) => ["processing", "extracting", "ready", "in_review"].includes(e.status)).length,
      verify_due: ev.filter((e) => ["processing", "extracting", "ready", "in_review"].includes(e.status) && e.due_at).map((e) => e.due_at as string).sort().pop() ?? null,
      open_tasks: tasks.filter((t) => t.project_id === p.id && ["received", "in_progress", "waiting"].includes(t.status)).length,
      to_review: tasks.filter((t) => t.project_id === p.id && t.status === "delivered" && !t.agent_feedback).length,
      needs_answer: tasks.filter((t) => t.project_id === p.id && t.status === "waiting").length,
      last_activity: last,
    };
  });
}

async function decorateTasks(tasks: Task[]): Promise<Task[]> {
  if (tasks.length === 0) return [];
  const ids = tasks.map((t) => t.id);
  const msgs = q(await db().from("task_messages").select("task_id,sender_role").in("task_id", ids)) as any[];
  const projectIds = Array.from(new Set(tasks.map((t) => t.project_id)));
  const projects = q(await db().from("projects").select("id,client_name").in("id", projectIds)) as any[];
  const eventIds = Array.from(new Set(tasks.map((t) => t.origin_event_id).filter(Boolean))) as string[];
  const events = eventIds.length ? (q(await db().from("events").select("id,title").in("id", eventIds)) as any[]) : [];
  return tasks.map((t) => ({
    ...t,
    logged_ms: Number(t.logged_ms),
    project_name: projects.find((p) => p.id === t.project_id)?.client_name ?? "",
    origin_event_title: events.find((e) => e.id === t.origin_event_id)?.title ?? null,
    message_count: msgs.filter((m) => m.task_id === t.id && m.sender_role !== "system").length,
  }));
}

async function decorateFiles(files: any[]): Promise<FileRow[]> {
  const names = await nameMap(files.map((f) => f.uploaded_by));
  return files.map((f) => ({ ...f, uploaded_by_name: f.uploaded_by ? names[f.uploaded_by] ?? null : null }));
}

/* ---------- Watches ---------- */

/** Null when the table is missing, so the rest of the product keeps working before the migration is applied. */
async function projectWatches(projectId: string, forAgent: boolean): Promise<Watch[] | null> {
  const res = await db().from("watches").select("*").eq("project_id", projectId).neq("status", "closed").order("created_at", { ascending: false });
  if (res.error) return null;
  const rows = (res.data ?? []) as Watch[];
  // Users see what is being watched and whether it happened, not the working notes.
  // Users see what is being watched and whether it happened. The finding, sources, notes and draft are unreviewed and stay with the VA.
  return forAgent ? rows.filter((w) => w.status !== "paused").map((w) => ({ ...w, note: null, last_result: null })) : rows;
}

function watchesMissing(): RpcError {
  return new RpcError("Watches are not set up yet. Ask your admin to run the watches migration in Supabase.", 503);
}

/**
 * Checks one watch against the live web. When the condition is newly met it opens a ticket
 * with what was found and a drafted client note, for the VA to review and deliver.
 */
async function runWatch(watch: Watch, actor: Profile | null): Promise<Watch> {
  const now = new Date().toISOString();
  let result: Watch["last_result"];
  try {
    const r = await checkCondition(watch.condition);
    result = { met: r.met, summary: r.summary, sources: r.sources };
  } catch (err) {
    const message = err instanceof Error ? err.message : "The check could not run.";
    const failed = { met: false, summary: watch.last_result?.summary ?? "", sources: watch.last_result?.sources ?? [], error: message };
    const kept = q(await db().from("watches").update({ last_checked_at: now, last_result: failed }).eq("id", watch.id).eq("status", watch.status).select("*")) as Watch[];
    return kept[0] ?? watch;
  }
  const patch: Record<string, unknown> = { last_checked_at: now, last_result: result };
  if (result.met && watch.status === "active") {
    // Claim it first so two checks running together cannot open two tickets.
    const claimed = q(await db().from("watches").update({ ...patch, status: "met", met_at: now }).eq("id", watch.id).eq("status", "active").select("*")) as Watch[];
    if (claimed.length === 0) return q(await db().from("watches").select("*").eq("id", watch.id).single()) as Watch;
    try {
      const project = q(await db().from("projects").select("*").eq("id", watch.project_id).single()) as Project;
      const submitted = q(await db().from("events").select("id").eq("project_id", project.id).eq("status", "submitted")) as { id: string }[];
      const facts = submitted.length
        ? (q(await db().from("facts").select("section,statement").eq("project_id", project.id).in("event_id", submitted.map((e) => e.id)).in("verdict", ["approved", "edited"]).is("resolved_at", null).limit(40)) as { section: string; statement: string }[])
        : [];
      // The draft is a convenience. It must never hold up the ticket, so it gets a short time limit.
      const draft = await Promise.race([
        draftFollowUp({ clientName: project.client_name, condition: watch.condition, finding: result.summary, note: watch.note, facts: facts.map((f) => `${f.section}: ${f.statement}`) }).catch(() => ""),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), 45000)),
      ]);
      // The user can read this ticket, so it only says what happened. The unreviewed finding and draft stay on the watch for the VA.
      const description = `Something your assistant was watching for has happened: ${watch.condition}\n\nThey are checking the details and preparing a follow-up you can send to your client.`.slice(0, 2000);
      const task = q(
        await db()
          .from("tasks")
          .insert({ project_id: project.id, agent_id: project.agent_id, title: `Follow up: ${watch.condition}`.slice(0, 140), description, category: "Follow-up draft", status: "received", requested_via: "watch", assigned_at: now, created_by: actor?.id ?? null })
          .select("*")
          .single(),
      ) as Task;
      await systemMessage(task.id, "Opened automatically because a watched condition was met.");
      await audit(actor, "watch.met", "watch", watch.id, { task_id: task.id });
      return q(await db().from("watches").update({ task_id: task.id, last_result: { ...result, draft } }).eq("id", watch.id).select("*").single()) as Watch;
    } catch (err) {
      // Without a ticket nobody would act on it. Put the watch back so the next check tries again.
      await db().from("watches").update({ status: "active", met_at: null }).eq("id", watch.id).eq("status", "met").is("task_id", null);
      throw err;
    }
  }
  // A slow check must not overwrite the state of a watch that was changed or met in the meantime.
  const saved = q(await db().from("watches").update(patch).eq("id", watch.id).eq("status", watch.status).select("*")) as Watch[];
  return saved[0] ?? (q(await db().from("watches").select("*").eq("id", watch.id).single()) as Watch);
}

/** Daily job: checks every active watch that has not been checked in the last 20 hours. */
export async function runDueWatches(budgetMs = 240000): Promise<{ checked: number; met: number; skipped: number }> {
  const started = Date.now();
  const cutoff = new Date(Date.now() - 20 * 3600 * 1000).toISOString();
  const res = await db().from("watches").select("*").eq("status", "active").or(`last_checked_at.is.null,last_checked_at.lt.${cutoff}`).order("last_checked_at", { ascending: true, nullsFirst: true }).limit(60);
  if (res.error) return { checked: 0, met: 0, skipped: 0 };
  const rows = (res.data ?? []) as Watch[];
  let checked = 0;
  let met = 0;
  for (const w of rows) {
    if (Date.now() - started > budgetMs) break;
    // Claim before the paid search, so overlapping runs do not check the same watch twice.
    let claim = db().from("watches").update({ last_checked_at: new Date().toISOString() }).eq("id", w.id).eq("status", "active");
    claim = w.last_checked_at ? claim.eq("last_checked_at", w.last_checked_at) : claim.is("last_checked_at", null);
    const got = await claim.select("id");
    if (got.error || (got.data ?? []).length === 0) continue;
    const after = await runWatch(w, null).catch(() => null);
    checked += 1;
    if (after?.status === "met") met += 1;
  }
  return { checked, met, skipped: rows.length - checked };
}

/** Daily job: moves along uploads that nobody was watching, so a finished transcription is not left waiting for someone to open a page. */
export async function reconcileEvents(budgetMs = 120000): Promise<{ advanced: number }> {
  const started = Date.now();
  const rows = q(await db().from("events").select("*").in("status", ["processing", "extracting"]).order("status_changed_at", { ascending: true }).limit(40)) as any[];
  let advanced = 0;
  for (const event of rows) {
    if (Date.now() - started > budgetMs) break;
    try {
      // A recording that has been processing for more than a day is not coming back. Fail it so Retry can pick it up.
      if (event.status === "processing" && Date.now() - new Date(event.status_changed_at).getTime() > 24 * 3600 * 1000) {
        await failEvent(event.id, new PipelineError("Transcription did not finish. Press Retry."));
      } else {
        await advanceEvent(event);
      }
      advanced += 1;
    } catch (err) {
      await failEvent(event.id, err).catch(() => {});
    }
  }
  return { advanced };
}

async function loadWatch(p: Profile, watchId: unknown): Promise<Watch> {
  const res = await db().from("watches").select("*").eq("id", uid(watchId, "Watch")).maybeSingle();
  if (res.error) throw watchesMissing();
  if (!res.data) throw new RpcError("Watch not found.", 404);
  await assertAgentAccess(p, (res.data as Watch).agent_id);
  return res.data as Watch;
}

/* ---------- Daily check-in ---------- */

function daysSince(iso: string | null | undefined): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
}

async function buildCheckin(p: Profile, agentId: string): Promise<CheckinResult> {
  const agent = q(await db().from("profiles").select("name,timezone").eq("id", agentId).single()) as { name: string; timezone: string };
  const projects = q(await db().from("projects").select("id,client_name").eq("agent_id", agentId)) as { id: string; client_name: string }[];
  const pname = (id: string) => projects.find((x) => x.id === id)?.client_name ?? "";
  const tasks = q(await db().from("tasks").select("*").eq("agent_id", agentId).in("status", ["suggested", "waiting", "delivered"]).order("created_at", { ascending: false }).limit(400)) as Task[];
  const items: CheckinItem[] = [];
  for (const t of tasks) {
    const base = { id: t.id, project_id: t.project_id, project_name: pname(t.project_id), title: t.title, task_id: t.id, task_number: t.number };
    if (t.status === "waiting") items.push({ ...base, kind: "waiting", days: daysSince(t.assigned_at ?? t.created_at) });
    else if (t.status === "suggested") items.push({ ...base, kind: "suggested", days: daysSince(t.created_at) });
    else if (t.status === "delivered" && !t.agent_feedback && daysSince(t.delivered_at) <= 14) items.push({ ...base, kind: "unreviewed", days: daysSince(t.delivered_at) });
  }
  // Open questions for the client that the user has not marked as answered.
  const submitted = q(await db().from("events").select("id").eq("agent_id", agentId).eq("status", "submitted")) as { id: string }[];
  if (submitted.length) {
    const questions = q(
      await db().from("facts").select("id,project_id,statement,created_at").in("event_id", submitted.map((e) => e.id).slice(0, 300)).eq("section", "questions").in("verdict", ["approved", "edited"]).is("resolved_at", null).order("created_at", { ascending: true }).limit(40),
    ) as { id: string; project_id: string; statement: string; created_at: string }[];
    for (const f of questions) items.push({ kind: "question", id: f.id, project_id: f.project_id, project_name: pname(f.project_id), title: f.statement, days: daysSince(f.created_at), task_id: null, task_number: null });
  }
  const order = { waiting: 0, suggested: 1, unreviewed: 2, question: 3 } as const;
  items.sort((a, b) => order[a.kind] - order[b.kind] || b.days - a.days);

  const logs = ((await db().from("audit_log").select("actor_id,detail,at").eq("action", "checkin.sent").eq("object_id", agentId).order("at", { ascending: false }).limit(8)).data ?? []) as { actor_id: string | null; detail: { channel?: string; count?: number; note?: string | null } | null; at: string }[];
  const names = await nameMap(logs.map((l) => l.actor_id));
  const history = logs.map((l) => ({ at: l.at, by: (l.actor_id && names[l.actor_id]) || "VA", channel: l.detail?.channel ?? "text", count: l.detail?.count ?? 0, note: l.detail?.note ?? null }));
  const last = history[0] ?? null;
  // "Today" is the user's calendar day, not a rolling window.
  const day = (d: Date) => {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: agent.timezone }).format(d);
    } catch {
      return d.toISOString().slice(0, 10);
    }
  };
  const doneToday = !!last && day(new Date(last.at)) === day(new Date());

  const first = (agent.name || "there").split(" ")[0];
  const mine = (p.name || "your assistant").split(" ")[0];
  const top = items.slice(0, 6);
  const line = (it: CheckinItem, i: number) => {
    const who = it.project_name ? ` (${it.project_name})` : "";
    const stale = it.days >= 2 ? ` Open ${it.days} days.` : "";
    if (it.kind === "waiting") return `${i + 1}. I need your answer to finish: ${it.title}${who}.${stale}`;
    if (it.kind === "suggested") return `${i + 1}. Suggested follow-up: ${it.title}${who}.${stale}${it.days >= 1 ? " Want me to take it?" : ""}`;
    if (it.kind === "unreviewed") return `${i + 1}. I delivered: ${it.title}${who}. Did you get to use it?`;
    return `${i + 1}. Still open with the client: ${it.title}${who}.${it.days >= 2 ? " Have you asked, or should I draft the message?" : ""}`;
  };
  const message = top.length
    ? [`Hi ${first}, ${mine} here with today's check-in.`, ...top.map(line), items.length > top.length ? `Plus ${items.length - top.length} more in Notique.` : "", "Reply with the numbers you want me to handle, or tell me what is already done."].filter(Boolean).join("\n")
    : "";
  return { items, message, last, history, doneToday };
}

async function buildProject(project: Project, forAgent: boolean): Promise<ProjectDetail> {
  const agentRow = q(await db().from("profiles").select("id,name,timezone").eq("id", project.agent_id).single()) as any;
  const vaLink = q(await db().from("assignments").select("va_id").eq("agent_id", project.agent_id).limit(1)) as any[];
  const vaNames = await nameMap(vaLink.map((l) => l.va_id));
  const rawEvents = q(await db().from("events").select("*").eq("project_id", project.id).order("occurred_at", { ascending: false })) as any[];
  const allEvents = rawEvents.map((e) => stripEvent(e));
  const submitted = allEvents.filter((e) => e.status === "submitted");
  const submittedBy = Object.fromEntries(rawEvents.map((e) => [e.id, e.submitted_by as string | null]));
  const submittedIds = submitted.map((e) => e.id);

  let facts: Fact[] = [];
  let needsInput: Fact[] = [];
  if (submittedIds.length) {
    const rows = q(
      await db()
        .from("facts")
        .select("*")
        .eq("project_id", project.id)
        .in("event_id", submittedIds)
        .in("verdict", forAgent ? ["approved", "edited"] : ["approved", "edited", "insufficient"])
        .is("resolved_at", null)
        .order("created_at", { ascending: false }),
    ) as any[];
    const names = await nameMap(rows.map((r) => r.verified_by));
    const decorated = rows.map((r) => {
      const ev = submitted.find((e) => e.id === r.event_id);
      const speakers = (ev?.speaker_map ?? {}) as Record<string, string>;
      const fact: Fact = {
        ...r,
        evidence: ((r.evidence ?? []) as Evidence[]).map((e) => ({ ...e, speaker: speakers[e.speaker] || e.speaker })),
        confidence: forAgent ? null : r.confidence === null ? null : Number(r.confidence),
        ai_statement: forAgent ? null : r.ai_statement,
        event_title: ev?.title,
        event_occurred_at: ev?.occurred_at,
        verified_by_name: r.verified_by ? names[r.verified_by] ?? null : null,
      };
      return fact;
    });
    facts = decorated.filter((f) => f.verdict === "approved" || f.verdict === "edited");
    needsInput = forAgent ? [] : decorated.filter((f) => f.verdict === "insufficient");
  }

  const hidden = forAgent ? ["dismissed", "cancelled"] : ["dismissed"];
  const taskRows = (q(await db().from("tasks").select("*").eq("project_id", project.id).order("created_at", { ascending: false })) as Task[]).filter(
    (t) => !hidden.includes(t.status),
  );
  const tasks = await decorateTasks(taskRows);

  let fileRows = q(await db().from("files").select("*").eq("project_id", project.id).order("created_at", { ascending: false })) as any[];
  if (forAgent) fileRows = fileRows.filter((f) => !(f.kind === "deliverable" && f.status === "draft") && f.kind !== "source");
  const files = await decorateFiles(fileRows);

  const links = q(
    await db().from("share_links").select("id,token,expires_at,revoked_at").eq("project_id", project.id).is("revoked_at", null).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(1),
  ) as any[];

  const lastSubmitted = [...submitted].sort((a, b) => (a.submitted_at ?? "").localeCompare(b.submitted_at ?? "")).pop();
  let lastVerified: ProjectDetail["lastVerified"] = null;
  if (lastSubmitted?.submitted_at) {
    const by = submittedBy[lastSubmitted.id];
    const names = await nameMap([by]);
    lastVerified = { at: lastSubmitted.submitted_at, by: (by && names[by]) || "the VA team" };
  }

  return {
    project,
    agent: agentRow,
    va: vaLink[0] ? { id: vaLink[0].va_id, name: vaNames[vaLink[0].va_id] ?? "Your assistant" } : null,
    events: forAgent ? rawEvents.filter((e) => e.status === "submitted").map((e) => stripEvent(e, true)) : allEvents,
    processingEvents: allEvents.filter((e) => e.status === "processing" || e.status === "extracting").length,
    facts,
    needsInput,
    tasks,
    files,
    shareLink: forAgent ? null : links[0] ?? null,
    pendingEvents: allEvents.filter((e) => ["processing", "extracting", "ready", "in_review"].includes(e.status)).length,
    pendingDue: allEvents.filter((e) => ["processing", "extracting", "ready", "in_review"].includes(e.status) && e.due_at).map((e) => e.due_at as string).sort().pop() ?? null,
    lastVerified,
    watches: await projectWatches(project.id, forAgent),
    failedUploads: rawEvents.filter((e) => e.status === "failed").map((e) => ({ id: e.id as string, title: e.title as string })),
  };
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

export const PUBLIC_FUNCTIONS = new Set(["setupStatus", "setupAdmin", "shareView"]);

export const handlers: Record<string, Handler> = {
  /* ---------- setup and session ---------- */

  async setupStatus() {
    const res = await db().from("profiles").select("id", { count: "exact", head: true });
    if (res.error) {
      return { needsSetup: false, ready: false, problem: `The database is not ready: ${res.error.message}. Run the SQL in supabase/migrations first.` };
    }
    return { needsSetup: (res.count ?? 0) === 0, ready: true, problem: null };
  },

  async setupAdmin(_ctx, args) {
    const existing = await db().from("profiles").select("id", { count: "exact", head: true });
    if (existing.error) throw new RpcError(`The database is not ready: ${existing.error.message}`, 500);
    if ((existing.count ?? 0) > 0) throw new RpcError("Setup is already complete. Ask an admin to create your account.", 403);
    const email = str(args.email, "Email", 200).toLowerCase();
    const name = str(args.name, "Name", 80);
    const pw = password(args.password, "Password");
    const created = await db().auth.admin.createUser({ email, password: pw, email_confirm: true });
    if (created.error || !created.data.user) throw new RpcError(created.error?.message ?? "Could not create the account.");
    const inserted = await db().from("profiles").insert({ id: created.data.user.id, email, name, role: "admin", timezone: args.timezone ? timezone(args.timezone) : "America/Los_Angeles" }).select("id");
    if (inserted.error) {
      await db().auth.admin.deleteUser(created.data.user.id);
      throw new RpcError(`Database error: ${inserted.error.message}`, 500);
    }
    return { ok: true };
  },

  async me(ctx): Promise<MeResult> {
    const p = me(ctx);
    let assistant: string | null = null;
    if (p.role === "agent") {
      const links = q(await db().from("assignments").select("va_id").eq("agent_id", p.id).limit(1)) as { va_id: string }[];
      if (links[0]) assistant = (await nameMap([links[0].va_id]))[links[0].va_id] ?? null;
    }
    return { profile: p, agents: await agentSummaries(p), assistant };
  },

  async completeOnboarding(ctx) {
    const p = me(ctx);
    q(await db().from("profiles").update({ onboarded_at: new Date().toISOString() }).eq("id", p.id).select("id"));
    return { ok: true };
  },

  async restartOnboarding(ctx) {
    const p = me(ctx);
    q(await db().from("profiles").update({ onboarded_at: null }).eq("id", p.id).select("id"));
    return { ok: true };
  },

  /* ---------- admin ---------- */

  async adminListUsers(ctx): Promise<AdminUser[]> {
    admin(ctx);
    const users = q(await db().from("profiles").select("*").order("created_at")) as Profile[];
    const links = q(await db().from("assignments").select("*")) as { va_id: string; agent_id: string }[];
    return users.map((u) => ({ ...u, assigned_agent_ids: links.filter((l) => l.va_id === u.id).map((l) => l.agent_id) }));
  },

  async adminCreateUser(ctx, args) {
    const p = admin(ctx);
    const email = str(args.email, "Email", 200).toLowerCase();
    const name = str(args.name, "Name", 80);
    const role = str(args.role, "Role", 10);
    if (!["admin", "va", "agent"].includes(role)) throw new RpcError("Role must be Admin, VA, or Agent.");
    const pw = password(args.password, "Temporary password");
    const created = await db().auth.admin.createUser({ email, password: pw, email_confirm: true });
    if (created.error || !created.data.user) {
      const msg = created.error?.message ?? "Could not create the account.";
      throw new RpcError(/already/i.test(msg) ? "An account with this email already exists." : msg);
    }
    const insert = await db()
      .from("profiles")
      .insert({ id: created.data.user.id, email, name, role, company: optStr(args.company, 120), timezone: args.timezone ? timezone(args.timezone) : "America/Los_Angeles" })
      .select("*")
      .single();
    if (insert.error) {
      await db().auth.admin.deleteUser(created.data.user.id);
      throw new RpcError(`Database error: ${insert.error.message}`, 500);
    }
    await audit(p, "user.create", "profile", created.data.user.id, { role });
    return insert.data;
  },

  async adminUpdateUser(ctx, args) {
    admin(ctx);
    const id = str(args.user_id, "User");
    const patch: Record<string, unknown> = {};
    if (typeof args.name === "string") patch.name = str(args.name, "Name", 80);
    if ("company" in args) patch.company = optStr(args.company, 120);
    if (typeof args.timezone === "string") patch.timezone = timezone(args.timezone);
    if (typeof args.role === "string") {
      if (!["admin", "va", "agent"].includes(args.role)) throw new RpcError("Role must be Admin, VA, or User.");
      const current = q(await db().from("profiles").select("role").eq("id", id).maybeSingle()) as { role: string } | null;
      if (!current) throw new RpcError("Account not found.", 404);
      if (current.role !== args.role) {
        if (id === me(ctx).id) throw new RpcError("You cannot change your own role.");
        if (current.role === "agent") {
          const owned = await db().from("projects").select("id", { count: "exact", head: true }).eq("agent_id", id);
      if (owned.error) throw new RpcError("Could not check whether this account owns projects. Nothing was deleted. Try again.", 500);
          if ((owned.count ?? 0) > 0) throw new RpcError("This user already has projects, so the role cannot be changed. Create a separate VA account instead.");
        }
        // Old assignments no longer make sense under the new role.
        await db().from("assignments").delete().or(`va_id.eq.${id},agent_id.eq.${id}`);
        patch.role = args.role;
      }
    }
    if (Object.keys(patch).length === 0) return { ok: true };
    q(await db().from("profiles").update(patch).eq("id", id).select("id"));
    return { ok: true };
  },

  /** Runs extraction on an existing transcript with each given model and returns the drafts side by side. Saves nothing. */
  async adminCompareModels(ctx, args) {
    admin(ctx);
    const event = await loadEvent(me(ctx), args.event_id);
    const models: string[] = Array.isArray(args.models) ? args.models.filter((m: unknown) => typeof m === "string" && /^[\w.\-:/]+$/.test(m)).slice(0, 4) : [];
    if (models.length === 0) throw new RpcError("List one to four model ids.");
    const project = q(await db().from("projects").select("*").eq("id", event.project_id).single()) as Project;
    const lines = (await fetchLines(event.id)).map((l) => ({ start_ms: l.start_ms, speaker: l.speaker, text: l.text }));
    const results = await Promise.all(
      models.map(async (model) => {
        const started = Date.now();
        try {
          const out = await extractFacts({ lines, eventTitle: event.title, eventType: event.event_type, occurredAt: event.occurred_at, project, priorFacts: [], model });
          return { model, ms: Date.now() - started, summary: out.summary, speakers: out.speakers, facts: out.facts.map((f) => ({ section: f.section, statement: f.statement, confidence: f.confidence, lines: f.lineIdx.map((i) => i + 1), task: f.suggested_task?.title ?? null })) };
        } catch (err) {
          return { model, ms: Date.now() - started, error: (err as Error).message };
        }
      }),
    );
    return { lines: lines.length, results };
  },

  async adminDeleteUser(ctx, args) {
    const p = admin(ctx);
    const id = str(args.user_id, "Account");
    if (id === p.id) throw new RpcError("You cannot delete your own account.");
    const target = q(await db().from("profiles").select("id,name,role").eq("id", id).maybeSingle()) as { id: string; name: string; role: string } | null;
    if (!target) throw new RpcError("Account not found.", 404);
    if (target.role === "agent") {
      const owned = await db().from("projects").select("id", { count: "exact", head: true }).eq("agent_id", id);
      if ((owned.count ?? 0) > 0) throw new RpcError(`${target.name} has ${owned.count} ${owned.count === 1 ? "project" : "projects"}. Deleting the account would delete their client data, so it is blocked. Reset the password instead to cut off access.`);
    }
    // People who verified events or handled tickets are referenced by that history and cannot be removed.
    const removed = await db().from("profiles").delete().eq("id", id).select("id");
    if (removed.error) {
      throw new RpcError(`${target.name} has work history in the system (verified events, tickets, or files), so the account cannot be deleted. Remove their assignments and reset the password to cut off access.`);
    }
    const auth = await db().auth.admin.deleteUser(id);
    if (auth.error) throw new RpcError(`The profile was removed but the login could not be deleted: ${auth.error.message}`, 500);
    await audit(p, "user.delete", "profile", id, { name: target.name, role: target.role });
    return { ok: true };
  },

  async adminResetPassword(ctx, args) {
    const p = admin(ctx);
    const id = str(args.user_id, "User");
    const pw = password(args.password, "New password");
    const res = await db().auth.admin.updateUserById(id, { password: pw });
    if (res.error) throw new RpcError(res.error.message);
    await audit(p, "user.reset_password", "profile", id);
    return { ok: true };
  },

  async adminSetAssignment(ctx, args) {
    const p = admin(ctx);
    const va_id = uid(args.va_id, "VA");
    const agent_id = uid(args.agent_id, "User");
    if (typeof args.on !== "boolean") throw new RpcError("Say whether to add or remove the assignment.");
    const pair = q(await db().from("profiles").select("id,role").in("id", [va_id, agent_id])) as { id: string; role: string }[];
    if (pair.find((x) => x.id === va_id)?.role === "agent" || pair.find((x) => x.id === agent_id)?.role !== "agent") throw new RpcError("Assign a VA or admin to a user account.");
    if (args.on) {
      q(await db().from("assignments").upsert({ va_id, agent_id }).select("va_id"));
    } else {
      q(await db().from("assignments").delete().eq("va_id", va_id).eq("agent_id", agent_id).select("va_id"));
    }
    await audit(p, args.on ? "assignment.add" : "assignment.remove", "profile", va_id, { agent_id });
    return { ok: true };
  },

  /* ---------- projects ---------- */

  async listProjects(ctx, args): Promise<ProjectListItem[]> {
    const p = me(ctx);
    const agentId = p.role === "agent" ? p.id : str(args.agent_id, "Agent");
    await assertAgentAccess(p, agentId);
    return projectList(agentId);
  },

  async createProject(ctx, args): Promise<Project> {
    const p = me(ctx);
    const agentId = p.role === "agent" ? p.id : str(args.agent_id, "Agent");
    await assertAgentAccess(p, agentId);
    const deal = ["buyer", "seller", "other"].includes(args.deal_type) ? args.deal_type : "buyer";
    const row = q(
      await db()
        .from("projects")
        .insert({ agent_id: agentId, client_name: str(args.client_name, "Client name", 80), deal_type: deal, area: optStr(args.area, 120), budget: optStr(args.budget, 60), created_by: p.id })
        .select("*")
        .single(),
    ) as Project;
    await audit(p, "project.create", "project", row.id);
    return row;
  },

  async updateProject(ctx, args): Promise<Project> {
    const p = me(ctx);
    const project = await loadProject(p, args.project_id);
    const patch: Record<string, unknown> = {};
    if (typeof args.client_name === "string") patch.client_name = str(args.client_name, "Client name", 80);
    if ("area" in args) patch.area = optStr(args.area, 120);
    if ("budget" in args) patch.budget = optStr(args.budget, 60);
    if (["buyer", "seller", "other"].includes(args.deal_type)) patch.deal_type = args.deal_type;
    if (args.archive === true) patch.archived_at = new Date().toISOString();
    return q(await db().from("projects").update(patch).eq("id", project.id).select("*").single()) as Project;
  },

  async getProject(ctx, args): Promise<ProjectDetail> {
    const p = me(ctx);
    const project = await loadProject(p, args.project_id);
    return buildProject(project, p.role === "agent" || args.as_agent === true);
  },

  /* ---------- uploads and files ---------- */

  async createUpload(ctx, args) {
    const p = me(ctx);
    const project = await loadProject(p, args.project_id);
    if (typeof args.name !== "string" || !args.name.trim()) throw new RpcError("File name is required.");
    // Keep the end of the name, which carries the extension the reader depends on.
    const safe = args.name.trim().replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "file";
    const path = `${project.agent_id}/${project.id}/${randomUUID()}-${safe}`;
    const res = await db().storage.from(BUCKET).createSignedUploadUrl(path);
    if (res.error || !res.data) throw new RpcError(`Could not prepare the upload: ${res.error?.message ?? "storage is not ready"}`, 500);
    return { path, token: res.data.token };
  },

  async addFile(ctx, args): Promise<FileRow> {
    const p = me(ctx);
    const project = await loadProject(p, args.project_id);
    const kind = str(args.kind, "Kind", 20);
    if (!["project", "attachment", "deliverable"].includes(kind)) throw new RpcError("Unknown file kind.");
    if (kind === "deliverable" && !isStaff(p)) throw new RpcError("Only the VA can add deliverables.", 403);
    const path = optStr(args.path, 400);
    const url = optStr(args.url, 1000);
    if (!path && !url) throw new RpcError("Add a file or a link.");
    if (path && !ownKey(path, `${project.agent_id}/${project.id}/`)) throw new RpcError("Invalid file path.");
    if (url) {
      let ok = false;
      try {
        const u = new URL(url);
        ok = (u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes(".");
      } catch {
        ok = false;
      }
      if (!ok) throw new RpcError("Enter a full link that starts with http or https.");
    }
    let taskId: string | null = null;
    if (args.task_id) {
      const task = await loadTask(p, args.task_id);
      if (task.project_id !== project.id) throw new RpcError("That task belongs to a different project.");
      taskId = task.id;
    }
    let eventId: string | null = null;
    if (args.event_id) {
      const event = await loadEvent(p, args.event_id);
      if (event.project_id !== project.id) throw new RpcError("That conversation belongs to a different project.");
      eventId = event.id;
    }
    if (path) {
      const usedFile = q(await db().from("files").select("id").eq("path", path).limit(1)) as any[];
      const usedEvent = q(await db().from("events").select("id").or(`audio_path.eq.${path},source_path.eq.${path}`).limit(1)) as any[];
      if (usedFile.length || usedEvent.length) throw new RpcError("That file is already attached. Upload it again to add another copy.");
    }
    const row = q(
      await db()
        .from("files")
        .insert({
          project_id: project.id,
          task_id: taskId,
          event_id: eventId,
          kind,
          status: kind === "deliverable" ? "draft" : "delivered",
          name: str(args.name, "File name", 200),
          path,
          url,
          size: Number.isFinite(Number(args.size)) ? Number(args.size) : null,
          mime: optStr(args.mime, 120),
          note: optStr(args.note, 200),
          uploaded_by: p.id,
          uploaded_role: p.role === "agent" ? "agent" : "va",
        })
        .select("*")
        .single(),
    ) as any;
    return (await decorateFiles([row]))[0];
  },

  async deleteFile(ctx, args) {
    const p = me(ctx);
    const row = q(await db().from("files").select("*").eq("id", str(args.file_id, "File")).maybeSingle()) as any;
    if (!row) throw new RpcError("File not found.", 404);
    await loadProject(p, row.project_id);
    if (row.kind === "deliverable" && row.status === "delivered") throw new RpcError("Delivered files cannot be removed.");
    if (p.role === "agent" && row.uploaded_by !== p.id) throw new RpcError("You can only remove files you uploaded.", 403);
    q(await db().from("files").delete().eq("id", row.id).select("id"));
    if (row.path) {
      const others = q(await db().from("files").select("id").eq("path", row.path).limit(1)) as any[];
      const events = q(await db().from("events").select("id").or(`audio_path.eq.${row.path},source_path.eq.${row.path}`).limit(1)) as any[];
      if (others.length === 0 && events.length === 0) await db().storage.from(BUCKET).remove([row.path]);
    }
    return { ok: true };
  },

  async fileUrl(ctx, args) {
    const p = me(ctx);
    const row = q(await db().from("files").select("*").eq("id", str(args.file_id, "File")).maybeSingle()) as any;
    if (!row) throw new RpcError("File not found.", 404);
    await loadProject(p, row.project_id);
    if (p.role === "agent" && row.kind === "deliverable" && row.status === "draft") throw new RpcError("File not found.", 404);
    if (row.url) return { url: row.url };
    return { url: await signedUrl(row.path, 3600, args.download ? row.name : undefined) };
  },

  /* ---------- events ---------- */

  async createEvent(ctx, args): Promise<EventRow> {
    const p = me(ctx);
    const project = await loadProject(p, args.project_id);
    const agent = q(await db().from("profiles").select("timezone").eq("id", project.agent_id).single()) as { timezone: string };
    const source = (["recording", "transcript_upload", "text_upload", "crm", "voice_memo", "note"].includes(args.source) ? args.source : "transcript_upload") as EventSource;
    const prefix = `${project.agent_id}/${project.id}/`;
    const audioPath = optStr(args.audio_path, 400);
    const filePath = optStr(args.file_path, 400);
    const imagePaths: string[] = Array.isArray(args.image_paths) ? args.image_paths.filter((x: unknown) => typeof x === "string").slice(0, 8) : [];
    const text = typeof args.text === "string" ? args.text.slice(0, 400000) : "";
    for (const path of [audioPath, filePath, ...imagePaths]) {
      if (path && !ownKey(path, prefix)) throw new RpcError("Invalid file path.");
    }
    if (!audioPath && !filePath && imagePaths.length === 0 && !enoughText(text)) {
      throw new RpcError("Add a recording, a file, or at least a few sentences of text.");
    }
    const occurred = optStr(args.occurred_at, 40);
    const occurredAt = occurred && !Number.isNaN(Date.parse(occurred)) ? new Date(occurred).toISOString() : new Date().toISOString();
    const now = new Date();
    const event = q(
      await db()
        .from("events")
        .insert({
          project_id: project.id,
          agent_id: project.agent_id,
          title: str(args.title, "Title", 120),
          event_type: optStr(args.event_type, 40) ?? "meeting",
          source,
          occurred_at: occurredAt,
          status: audioPath ? "processing" : "extracting",
          due_at: nextBusinessDayNine(now, agent.timezone).toISOString(),
          audio_path: audioPath,
          source_path: filePath ?? imagePaths[0] ?? null,
          source_name: optStr(args.file_name, 200),
          raw_text: text || null,
          created_by: p.id,
        })
        .select("*")
        .single(),
    ) as any;
    // The screenshot paths are kept here so a failed read can be retried later.
    await audit(p, "event.create", "event", event.id, { source, image_paths: imagePaths.length ? imagePaths : undefined });

    if (audioPath) {
      try {
        await startAudio(event.id, audioPath);
      } catch (err) {
        await failEvent(event.id, err);
      }
    } else {
      // Reading and fact drafting can take a minute. The upload dialog closes now and the pages poll for the result.
      inBackground(event.id, () => ingestSource(event.id, { imagePaths, filePath, text }));
    }
    return stripEvent(q(await db().from("events").select("*").eq("id", event.id).single()), p.role === "agent");
  },

  async pollEvents(ctx, args) {
    const p = me(ctx);
    const ids: string[] = Array.isArray(args.event_ids) ? args.event_ids.slice(0, 10) : [];
    const out: EventRow[] = [];
    for (const id of ids) {
      const event = await loadEvent(p, id);
      try {
        await advanceEvent(event);
      } catch (err) {
        await failEvent(event.id, err);
      }
      out.push(stripEvent(q(await db().from("events").select("*").eq("id", event.id).single()), p.role === "agent"));
    }
    return out;
  },

  /** Lets any signed-in viewer of a project move its uploads forward, so nothing waits on the VA queue being open. */
  async pollProject(ctx, args) {
    const p = me(ctx);
    const project = await loadProject(p, args.project_id);
    const rows = q(await db().from("events").select("*").eq("project_id", project.id).in("status", ["processing", "extracting"]).limit(5)) as any[];
    let changed = false;
    for (const event of rows) {
      try {
        await advanceEvent(event);
      } catch (err) {
        await failEvent(event.id, err);
      }
      const after = q(await db().from("events").select("status").eq("id", event.id).single()) as { status: string };
      if (after.status !== event.status) changed = true;
    }
    return { working: rows.length, changed };
  },

  async retryEvent(ctx, args) {
    const p = staff(ctx);
    const event = await loadEvent(p, args.event_id);
    if (event.status !== "failed") throw new RpcError("Only failed events can be retried.");
    // Claim the retry so two clicks, or two people, cannot process the same upload twice.
    const claimed = q(await db().from("events").update({ status: "extracting", status_changed_at: new Date().toISOString(), error: null }).eq("id", event.id).eq("status", "failed").select("id")) as any[];
    if (claimed.length === 0) return stripEvent(q(await db().from("events").select("*").eq("id", event.id).single()));
    try {
      const lines = q(await db().from("transcript_lines").select("id").eq("event_id", event.id).limit(1)) as any[];
      if (lines.length) {
        await setEventStatus(event.id, "extracting", { error: null });
        await runExtraction(event.id);
      } else if (event.audio_path) {
        await startAudio(event.id, event.audio_path);
      } else if (event.raw_text) {
        await setEventStatus(event.id, "extracting", { error: null });
        await processText(event.id, event.raw_text);
      } else if (event.source_path) {
        // A screenshot thread or an uploaded file that could not be read the first time.
        const made = (await db().from("audit_log").select("detail").eq("action", "event.create").eq("object_id", event.id).limit(1)).data as { detail: { image_paths?: string[] } | null }[] | null;
        const images = made?.[0]?.detail?.image_paths ?? (/\.(png|jpe?g|webp|gif|heic)$/i.test(event.source_path) ? [event.source_path] : []);
        await setEventStatus(event.id, "extracting", { error: null });
        await ingestSource(event.id, images.length ? { imagePaths: images } : { filePath: event.source_path });
      } else {
        throw new PipelineError("There is nothing to retry. Delete this event and upload the source again.");
      }
    } catch (err) {
      await failEvent(event.id, err);
    }
    return stripEvent(q(await db().from("events").select("*").eq("id", event.id).single()));
  },

  async deleteEvent(ctx, args) {
    const p = staff(ctx);
    const event = await loadEvent(p, args.event_id);
    if (event.status === "submitted") throw new RpcError("Submitted events cannot be deleted. Reopen it first if it needs changes.");
    const paths = [event.audio_path, event.source_path].filter(Boolean) as string[];
    if (paths.length) await db().storage.from(BUCKET).remove(paths);
    q(await db().from("events").delete().eq("id", event.id).select("id"));
    await audit(p, "event.delete", "event", event.id, { title: event.title });
    return { ok: true };
  },

  async vaQueue(ctx, args): Promise<QueueResult> {
    const p = staff(ctx);
    const agentId = str(args.agent_id, "Agent");
    await assertAgentAccess(p, agentId);
    const agents = await agentSummaries(p);
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) throw new RpcError("User not found.", 404);

    const rows = (q(
      await db().from("events").select("*").eq("agent_id", agentId).in("status", ["processing", "extracting", "ready", "in_review", "failed", "escalated"]).order("due_at", { ascending: true }),
    ) as any[]).map((e) => stripEvent(e));
    const projects = q(await db().from("projects").select("*").eq("agent_id", agentId).is("archived_at", null).order("client_name")) as Project[];
    const ids = rows.map((e) => e.id);
    const facts = ids.length ? (q(await db().from("facts").select("event_id,verdict").in("event_id", ids)) as any[]) : [];
    const lineCounts: Record<string, number> = {};
    for (const id of ids) {
      const res = await db().from("transcript_lines").select("id", { count: "exact", head: true }).eq("event_id", id);
      lineCounts[id] = res.count ?? 0;
    }
    const decorate = (e: EventRow): QueueEvent => ({
      ...e,
      review_ms: Number(e.review_ms),
      project_name: projects.find((pr) => pr.id === e.project_id)?.client_name ?? "Archived project",
      fact_count: facts.filter((f) => f.event_id === e.id).length,
      resolved_count: facts.filter((f) => f.event_id === e.id && f.verdict !== "pending").length,
      line_count: lineCounts[e.id] ?? 0,
    });
    const events = rows.filter((e) => e.status === "ready" || e.status === "in_review").map(decorate);
    const processing = rows.filter((e) => !(e.status === "ready" || e.status === "in_review")).map(decorate);

    const openTasks = q(
      await db().from("tasks").select("*").eq("agent_id", agentId).in("status", ["received", "in_progress", "waiting"]).order("eta", { ascending: true, nullsFirst: true }),
    ) as Task[];

    const now = Date.now();
    const endOfDay = now + 24 * 3600 * 1000;
    const weekStart = startOfWeekUtc(new Date()).toISOString();
    const verified = await db().from("events").select("id", { count: "exact", head: true }).eq("agent_id", agentId).eq("status", "submitted").gte("submitted_at", weekStart);
    const weekAgo = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
    const recent = q(await db().from("events").select("source,created_at").eq("agent_id", agentId).gte("created_at", weekAgo)) as any[];
    const sources = {} as QueueResult["sources"];
    for (const key of ["recording", "transcript_upload", "text_upload", "crm", "voice_memo", "note"] as EventSource[]) {
      const mine = recent.filter((r) => r.source === key);
      sources[key] = { count_week: mine.length, last_at: mine.map((m) => m.created_at).sort().pop() ?? null };
    }

    return {
      agent,
      events,
      processing,
      ticketsDue: await decorateTasks(openTasks.slice(0, 12)),
      stats: {
        dueSoon: events.filter((e) => e.due_at && new Date(e.due_at).getTime() - now < 2 * 3600 * 1000).length,
        dueToday: events.filter((e) => e.due_at && new Date(e.due_at).getTime() < endOfDay).length,
        verifiedThisWeek: verified.count ?? 0,
      },
      sources,
      projects,
    };
  },

  async getEvent(ctx, args): Promise<EventDetail> {
    const p = staff(ctx);
    let event = await loadEvent(p, args.event_id);
    if (event.status === "ready") {
      await setEventStatus(event.id, "in_review");
      event = { ...event, status: "in_review" };
    }
    const project = q(await db().from("projects").select("*").eq("id", event.project_id).single()) as Project;
    const lines = await fetchLines(event.id);
    const facts = (q(await db().from("facts").select("*").eq("event_id", event.id).order("position").order("created_at")) as any[]).map((f) => ({
      ...f,
      confidence: f.confidence === null ? null : Number(f.confidence),
    }));
    const queue = q(await db().from("events").select("id").eq("agent_id", event.agent_id).in("status", ["ready", "in_review"]).order("due_at", { ascending: true })) as { id: string }[];
    const index = queue.findIndex((e) => e.id === event.id);
    let audioUrl: string | null = null;
    if (event.audio_path) {
      try {
        audioUrl = await signedUrl(event.audio_path, 3 * 3600);
      } catch {
        audioUrl = null;
      }
    }
    const canReopen = event.status === "submitted" && !!event.submitted_at && Date.now() - new Date(event.submitted_at).getTime() < 24 * 3600 * 1000;
    return {
      event: { ...stripEvent(event), review_ms: Number(event.review_ms) },
      project,
      lines,
      facts,
      audioUrl,
      position: { index: index === -1 ? 0 : index + 1, total: queue.length },
      canReopen,
    };
  },

  async updateEventMeta(ctx, args) {
    const p = staff(ctx);
    const event = await loadEvent(p, args.event_id);
    const patch: Record<string, unknown> = {};
    const locked = event.status === "submitted";
    if (locked && (args.checks || args.speaker_map || typeof args.title === "string" || typeof args.summary === "string")) {
      throw new RpcError("This event is already submitted. Reopen it to make changes.");
    }
    if (args.checks && typeof args.checks === "object") {
      const next = { ...(event.checks ?? {}) } as Record<string, boolean>;
      for (const key of ["consent", "pii", "fair_housing", "type_match"]) {
        if (typeof args.checks[key] === "boolean") next[key] = args.checks[key];
      }
      patch.checks = next;
    }
    if (args.speaker_map && typeof args.speaker_map === "object") {
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(args.speaker_map as Record<string, unknown>)) {
        if (typeof v === "string" && v.trim()) next[k.slice(0, 60)] = v.trim().slice(0, 40);
      }
      patch.speaker_map = next;
    }
    if (typeof args.title === "string") patch.title = str(args.title, "Title", 120);
    if (typeof args.summary === "string") patch.summary = args.summary.trim().slice(0, 800) || null;
    if (Number.isFinite(Number(args.add_ms)) && Number(args.add_ms) > 0 && event.status !== "submitted") {
      patch.review_ms = Number(event.review_ms) + Math.min(Number(args.add_ms), 120000);
    }
    if (Object.keys(patch).length === 0) return { ok: true };
    q(await db().from("events").update(patch).eq("id", event.id).select("id"));
    return { ok: true };
  },

  async setVerdict(ctx, args): Promise<Fact> {
    const p = staff(ctx);
    const fact = q(await db().from("facts").select("*").eq("id", str(args.fact_id, "Fact")).maybeSingle()) as any;
    if (!fact) throw new RpcError("This item no longer exists.", 404);
    const event = await loadEvent(p, fact.event_id);
    if (event.status === "submitted") throw new RpcError("This event is already submitted. Reopen it to make changes.");
    const verdict = str(args.verdict, "Verdict", 20) as Verdict;
    if (!["pending", "approved", "edited", "declined", "insufficient"].includes(verdict)) throw new RpcError("Unknown verdict.");
    const patch: Record<string, unknown> = { verdict };
    if (typeof args.section === "string") {
      if (!["decisions", "budget", "needs", "questions", "risks", "next_steps"].includes(args.section)) throw new RpcError("Choose a section.");
      patch.section = args.section;
      // A suggested task only makes sense on a question or a next step.
      if (!["questions", "next_steps"].includes(args.section) && !("suggested_task" in args)) patch.suggested_task = null;
    }
    if (verdict === "approved" && fact.origin === "ai" && fact.confidence !== null && Number(fact.confidence) < 0.6) {
      throw new RpcError("Low confidence items cannot be approved as written. Edit the wording, decline it, or mark it insufficient.");
    }
    if (verdict === "edited") {
      patch.statement = str(args.statement, "Statement", 400);
    }
    if (verdict === "approved" && fact.origin === "ai" && fact.ai_statement) {
      patch.statement = fact.ai_statement;
    }
    if (verdict === "pending") {
      patch.statement = fact.origin === "ai" && fact.ai_statement ? fact.ai_statement : fact.statement;
      patch.verified_by = null;
      patch.verified_at = null;
    } else {
      patch.verified_by = p.id;
      patch.verified_at = new Date().toISOString();
    }
    if ("follow_up_date" in args) patch.follow_up_date = typeof args.follow_up_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.follow_up_date) ? args.follow_up_date : null;
    if ("follow_up_condition" in args) patch.follow_up_condition = optStr(args.follow_up_condition, 160);
    if ("suggested_task" in args) {
      const st = args.suggested_task;
      patch.suggested_task =
        st && typeof st === "object" && typeof st.title === "string" && st.title.trim()
          ? {
              title: st.title.trim().slice(0, 140),
              description: String(st.description ?? "").trim().slice(0, 600),
              category: String(st.category ?? "Research").slice(0, 40),
              est_minutes: Number.isFinite(Number(st.est_minutes)) && Number(st.est_minutes) > 0 ? Math.round(Number(st.est_minutes)) : null,
            }
          : null;
    }
    const row = q(await db().from("facts").update(patch).eq("id", fact.id).select("*").single()) as any;
    return { ...row, confidence: row.confidence === null ? null : Number(row.confidence) };
  },

  async addFact(ctx, args): Promise<Fact> {
    const p = staff(ctx);
    const event = await loadEvent(p, args.event_id);
    if (event.status === "submitted") throw new RpcError("This event is already submitted. Reopen it to make changes.");
    const section = str(args.section, "Section", 20) as Section;
    if (!["decisions", "budget", "needs", "questions", "risks", "next_steps"].includes(section)) throw new RpcError("Choose a section.");
    const lineIds: string[] = Array.isArray(args.line_ids) ? args.line_ids.slice(0, 4) : [];
    if (lineIds.length === 0) throw new RpcError("Select the transcript lines that support this fact first.");
    const lines = q(await db().from("transcript_lines").select("*").eq("event_id", event.id).in("id", lineIds).order("idx")) as any[];
    if (lines.length === 0) throw new RpcError("Select the transcript lines that support this fact first.");
    const evidence: Evidence[] = lines.map((l) => ({ line_id: l.id, idx: l.idx, start_ms: l.start_ms, speaker: l.speaker, quote: l.text }));
    const row = q(
      await db()
        .from("facts")
        .insert({
          event_id: event.id,
          project_id: event.project_id,
          section,
          statement: str(args.statement, "Statement", 400),
          verdict: "approved",
          origin: "va",
          evidence,
          verified_by: p.id,
          verified_at: new Date().toISOString(),
          position: 1000,
        })
        .select("*")
        .single(),
    ) as any;
    return { ...row, confidence: null };
  },

  async deleteFact(ctx, args) {
    const p = staff(ctx);
    const fact = q(await db().from("facts").select("*").eq("id", str(args.fact_id, "Fact")).maybeSingle()) as any;
    if (!fact) return { ok: true };
    const event = await loadEvent(p, fact.event_id);
    if (event.status === "submitted") throw new RpcError("This event is already submitted.");
    if (fact.origin !== "va") throw new RpcError("AI drafts cannot be deleted. Decline it instead.");
    q(await db().from("facts").delete().eq("id", fact.id).select("id"));
    return { ok: true };
  },

  async submitEvent(ctx, args) {
    const p = staff(ctx);
    const event = await loadEvent(p, args.event_id);
    if (event.status === "submitted") throw new RpcError("This event is already submitted.");
    if (!["ready", "in_review"].includes(event.status)) throw new RpcError("This event is not ready to submit.");
    const checks = event.checks ?? {};
    const missing = (["consent", "pii", "fair_housing", "type_match"] as const).filter((k) => !checks[k]);
    if (missing.length) throw new RpcError("Confirm all four checks at the top of the page before submitting.");
    const facts = q(await db().from("facts").select("*").eq("event_id", event.id)) as any[];
    const pending = facts.filter((f) => f.verdict === "pending").length;
    if (pending) throw new RpcError(`${pending} ${pending === 1 ? "item still needs" : "items still need"} a decision.`);

    const accepted = facts.filter((f) => f.verdict === "approved" || f.verdict === "edited");
    const now = new Date().toISOString();
    // Claim the event first so a double click or a second VA cannot submit it twice.
    const claimed = q(
      await db()
        .from("events")
        .update({ status: "submitted", status_changed_at: now, submitted_at: now, submitted_by: p.id })
        .eq("id", event.id)
        .in("status", ["ready", "in_review"])
        .select("id"),
    ) as any[];
    if (claimed.length === 0) throw new RpcError("This event is already submitted.");
    const supersededIds = accepted.map((f) => f.supersedes_id).filter(Boolean);
    if (supersededIds.length) {
      q(await db().from("facts").update({ resolved_at: now }).in("id", supersededIds).select("id"));
      // A suggestion that came from a fact which is no longer true should not stay in the agent's list.
      q(await db().from("tasks").update({ status: "dismissed" }).in("origin_fact_id", supersededIds).eq("status", "suggested").select("id"));
    }

    const withTask = accepted.filter((f) => f.suggested_task && (f.section === "questions" || f.section === "next_steps"));
    let created = 0;
    if (withTask.length) {
      const existing = q(await db().from("tasks").select("origin_fact_id").in("origin_fact_id", withTask.map((f) => f.id))) as any[];
      const have = new Set(existing.map((e) => e.origin_fact_id));
      const rows = withTask
        .filter((f) => !have.has(f.id))
        .map((f) => ({
          project_id: event.project_id,
          agent_id: event.agent_id,
          title: f.suggested_task.title,
          description: f.suggested_task.description || f.statement,
          category: f.suggested_task.category || "Research",
          est_minutes: f.suggested_task.est_minutes ?? null,
          status: "suggested",
          origin_fact_id: f.id,
          origin_event_id: event.id,
          created_by: p.id,
        }));
      if (rows.length) {
        q(await db().from("tasks").insert(rows).select("id"));
        created = rows.length;
      }
    }

    await audit(p, "event.submit", "event", event.id, { accepted: accepted.length, tasks: created });
    return { ok: true, project_id: event.project_id, suggested_tasks: created, accepted: accepted.length };
  },

  async escalateEvent(ctx, args) {
    const p = staff(ctx);
    const event = await loadEvent(p, args.event_id);
    if (!["ready", "in_review"].includes(event.status)) throw new RpcError("Only events that are ready for review can be escalated.");
    await setEventStatus(event.id, "escalated", { escalation_note: str(args.note, "Reason", 400) });
    await audit(p, "event.escalate", "event", event.id);
    return { ok: true };
  },

  async reopenEvent(ctx, args) {
    const p = staff(ctx);
    const event = await loadEvent(p, args.event_id);
    if (event.status === "escalated") {
      await setEventStatus(event.id, "in_review", { escalation_note: null });
      return { ok: true };
    }
    if (event.status !== "submitted") throw new RpcError("Only submitted events can be reopened.");
    if (!event.submitted_at || Date.now() - new Date(event.submitted_at).getTime() > 24 * 3600 * 1000) {
      throw new RpcError("Events can be reopened for 24 hours after they are submitted.");
    }
    // Undo what the submit did: bring back facts this event replaced, and withdraw suggestions nobody has acted on.
    const mine = q(await db().from("facts").select("supersedes_id").eq("event_id", event.id).not("supersedes_id", "is", null)) as { supersedes_id: string }[];
    if (mine.length) {
      q(await db().from("facts").update({ resolved_at: null }).in("id", mine.map((f) => f.supersedes_id)).select("id"));
    }
    q(await db().from("tasks").delete().eq("origin_event_id", event.id).eq("status", "suggested").select("id"));
    await setEventStatus(event.id, "in_review", { submitted_at: null, submitted_by: null });
    await audit(p, "event.reopen", "event", event.id);
    return { ok: true };
  },

  async resolveFact(ctx, args) {
    const p = me(ctx);
    const fact = q(await db().from("facts").select("*").eq("id", uid(args.fact_id, "Item")).maybeSingle()) as any;
    if (!fact) throw new RpcError("This item no longer exists.", 404);
    await loadProject(p, fact.project_id);
    // Only verified open items can be closed, and only from the sections that offer it.
    const ev = q(await db().from("events").select("status").eq("id", fact.event_id).maybeSingle()) as { status: string } | null;
    if (ev?.status !== "submitted" || !["approved", "edited"].includes(fact.verdict) || !["questions", "next_steps", "risks"].includes(fact.section)) throw new RpcError("This item cannot be marked resolved.");
    q(await db().from("facts").update({ resolved_at: args.undo ? null : new Date().toISOString() }).eq("id", fact.id).select("id"));
    return { ok: true };
  },

  /* ---------- tasks ---------- */

  async getTask(ctx, args): Promise<TaskDetail> {
    const p = me(ctx);
    const task = await loadTask(p, args.task_id);
    if (p.role === "agent" && task.status === "dismissed") throw new RpcError("Task not found.", 404);
    const project = q(await db().from("projects").select("*").eq("id", task.project_id).single()) as Project;
    const rawMessages = q(await db().from("task_messages").select("*").eq("task_id", task.id).order("created_at")) as TaskMessage[];
    const names = await nameMap(rawMessages.map((m) => m.sender_id));
    const messages = rawMessages.map((m) => ({ ...m, sender_name: m.sender_id ? names[m.sender_id] ?? undefined : undefined }));
    let files = q(await db().from("files").select("*").eq("task_id", task.id).order("created_at")) as any[];
    if (p.role === "agent") files = files.filter((f) => !(f.kind === "deliverable" && f.status === "draft"));
    const events = q(await db().from("events").select("id,title,occurred_at").eq("project_id", task.project_id).eq("status", "submitted").order("occurred_at", { ascending: false }).limit(6)) as any[];
    return { task: (await decorateTasks([task]))[0], project, messages, files: await decorateFiles(files), contextEvents: events };
  },

  async createTask(ctx, args): Promise<Task> {
    const p = me(ctx);
    const project = await loadProject(p, args.project_id);
    const staffUser = isStaff(p);
    const via = staffUser ? str(args.requested_via, "How the user asked for this", 20) : "in_app";
    if (!["in_app", "text", "email", "call"].includes(via)) throw new RpcError("Choose how the user asked for this.");
    const row = q(
      await db()
        .from("tasks")
        .insert({
          project_id: project.id,
          agent_id: project.agent_id,
          title: str(args.title, "Title", 140),
          description: longText(args.description, "Details", 2000),
          category: optStr(args.category, 40) ?? "Other",
          est_minutes: Number.isFinite(Number(args.est_minutes)) && Number(args.est_minutes) > 0 ? Math.round(Number(args.est_minutes)) : null,
          status: "received",
          requested_via: via,
          assigned_at: new Date().toISOString(),
          created_by: p.id,
        })
        .select("*")
        .single(),
    ) as Task;
    await audit(p, "task.create", "task", row.id, { via });
    return (await decorateTasks([row]))[0];
  },

  async updateTask(ctx, args): Promise<Task> {
    const p = me(ctx);
    const task = await loadTask(p, args.task_id);
    if (["delivered", "cancelled"].includes(task.status)) throw new RpcError("This task can no longer be edited.");
    if (p.role === "agent" && !["suggested", "received"].includes(task.status)) throw new RpcError("Work has started on this task. Send a message to change the request.");
    const patch: Record<string, unknown> = {};
    if (typeof args.title === "string") patch.title = str(args.title, "Title", 140);
    if (typeof args.description === "string") patch.description = longText(args.description, "Details", 2000);
    if (typeof args.category === "string") patch.category = str(args.category, "Category", 40);
    if ("est_minutes" in args) patch.est_minutes = Number.isFinite(Number(args.est_minutes)) && Number(args.est_minutes) > 0 ? Math.round(Number(args.est_minutes)) : null;
    const row = q(await db().from("tasks").update(patch).eq("id", task.id).select("*").single()) as Task;
    return (await decorateTasks([row]))[0];
  },

  async assignTask(ctx, args): Promise<Task> {
    const p = me(ctx);
    const task = await loadTask(p, args.task_id);
    if (task.status !== "suggested") throw new RpcError("This task has already been handled.");
    const via = isStaff(p) ? str(args.requested_via, "How the user approved this", 20) : "in_app";
    const row = q(
      await db().from("tasks").update({ status: "received", assigned_at: new Date().toISOString(), requested_via: via }).eq("id", task.id).eq("status", "suggested").select("*").single(),
    ) as Task;
    await audit(p, "task.assign", "task", task.id, { via });
    return (await decorateTasks([row]))[0];
  },

  async dismissTask(ctx, args) {
    const p = me(ctx);
    const task = await loadTask(p, args.task_id);
    if (args.undo) {
      if (task.status !== "dismissed") return { ok: true };
      q(await db().from("tasks").update({ status: "suggested" }).eq("id", task.id).select("id"));
      return { ok: true };
    }
    if (task.status !== "suggested") throw new RpcError("Only suggestions can be dismissed.");
    q(await db().from("tasks").update({ status: "dismissed" }).eq("id", task.id).eq("status", "suggested").select("id"));
    return { ok: true };
  },

  async cancelTask(ctx, args) {
    const p = me(ctx);
    const task = await loadTask(p, args.task_id);
    if (["delivered", "cancelled", "dismissed"].includes(task.status)) throw new RpcError("This task is already closed.");
    q(await db().from("tasks").update({ status: "cancelled", ...pauseTimerPatch(task) }).eq("id", task.id).select("id"));
    await systemMessage(task.id, `${p.role === "agent" ? "The user" : p.name} cancelled this task.`);
    await audit(p, "task.cancel", "task", task.id);
    return { ok: true };
  },

  async setTaskEta(ctx, args): Promise<Task> {
    const p = staff(ctx);
    const task = await loadTask(p, args.task_id);
    if (!["received", "in_progress", "waiting"].includes(task.status)) throw new RpcError("An ETA can only be set on open tasks.");
    const eta = str(args.eta, "ETA", 40);
    if (Number.isNaN(Date.parse(eta))) throw new RpcError("Enter a valid date and time.");
    const patch: Record<string, unknown> = { eta: new Date(eta).toISOString() };
    if (task.status === "received") patch.status = "in_progress";
    const rows = q(await db().from("tasks").update(patch).eq("id", task.id).eq("status", task.status).select("*")) as Task[];
    if (rows.length === 0) throw new RpcError("This ticket just changed. Reload it and try again.", 409);
    const row = rows[0];
    await systemMessage(task.id, task.eta ? "The delivery time was updated." : "A delivery time was set.");
    return (await decorateTasks([row]))[0];
  },

  async taskTimer(ctx, args): Promise<Task> {
    const p = staff(ctx);
    const task = await loadTask(p, args.task_id);
    let patch: Record<string, unknown>;
    if (args.action === "start") {
      if (!["in_progress", "waiting"].includes(task.status)) throw new RpcError(task.status === "received" ? "Set an ETA before you start the timer." : "The timer only runs while a task is in progress.");
      patch = task.timer_started_at ? {} : { timer_started_at: new Date().toISOString() };
      if (task.status === "waiting") patch.status = "in_progress";
    } else {
      patch = pauseTimerPatch(task);
    }
    if (Object.keys(patch).length === 0) return (await decorateTasks([task]))[0];
    const row = q(await db().from("tasks").update(patch).eq("id", task.id).select("*").single()) as Task;
    return (await decorateTasks([row]))[0];
  },

  async sendTaskMessage(ctx, args): Promise<TaskDetail["messages"][number]> {
    const p = me(ctx);
    const task = await loadTask(p, args.task_id);
    if (["cancelled", "dismissed", "suggested"].includes(task.status)) throw new RpcError("Messages can only be sent on active tasks.");
    const body = str(args.body, "Message", 4000);
    const staffUser = isStaff(p);
    const onBehalf = staffUser && args.as_agent === true;
    const channel = onBehalf ? str(args.channel, "Channel", 10) : staffUser && typeof args.channel === "string" ? args.channel : "in_app";
    if (!["in_app", "text", "email", "call"].includes(channel)) throw new RpcError("Choose a channel.");
    if (onBehalf && channel === "in_app") throw new RpcError("Choose where the user replied: text, email, or call.");
    const senderRole = !staffUser || onBehalf ? "agent" : "va";
    const row = q(
      await db().from("task_messages").insert({ task_id: task.id, sender_id: onBehalf ? null : p.id, sender_role: senderRole, channel, body }).select("*").single(),
    ) as any;

    if (senderRole === "va" && args.ask === true && task.status === "in_progress") {
      q(await db().from("tasks").update({ status: "waiting", ...pauseTimerPatch(task) }).eq("id", task.id).eq("status", "in_progress").select("id"));
    } else if (senderRole === "agent" && task.status === "waiting") {
      q(await db().from("tasks").update({ status: "in_progress" }).eq("id", task.id).eq("status", "waiting").select("id"));
    }
    return { ...row, sender_name: onBehalf ? undefined : p.name };
  },

  async deliverTask(ctx, args): Promise<Task> {
    const p = staff(ctx);
    const task = await loadTask(p, args.task_id);
    if (!["in_progress", "waiting"].includes(task.status)) throw new RpcError(task.status === "received" ? "Set an ETA before delivering." : "This task cannot be delivered in its current state.");
    const files = q(await db().from("files").select("id").eq("task_id", task.id).eq("kind", "deliverable")) as any[];
    if (files.length === 0) throw new RpcError("Add at least one deliverable before marking this delivered.");
    q(await db().from("files").update({ status: "delivered" }).eq("task_id", task.id).eq("kind", "deliverable").select("id"));
    const row = q(
      await db().from("tasks").update({ status: "delivered", delivered_at: new Date().toISOString(), agent_feedback: null, ...pauseTimerPatch(task) }).eq("id", task.id).select("*").single(),
    ) as Task;
    await systemMessage(task.id, `${p.name} delivered ${files.length} ${files.length === 1 ? "file" : "files"}.`);
    await audit(p, "task.deliver", "task", task.id, { files: files.length });
    return (await decorateTasks([row]))[0];
  },

  async setTaskFeedback(ctx, args): Promise<Task> {
    const p = me(ctx);
    const task = await loadTask(p, args.task_id);
    if (task.status !== "delivered") throw new RpcError("Feedback can be recorded after delivery.");
    const feedback = str(args.feedback, "Feedback", 30);
    if (!["used_as_is", "edited", "not_used", "revision_requested"].includes(feedback)) throw new RpcError("Unknown feedback option.");
    const patch: Record<string, unknown> = { agent_feedback: feedback };
    if (feedback === "revision_requested") {
      patch.status = "in_progress";
      patch.delivered_at = null;
    }
    const rows = q(await db().from("tasks").update(patch).eq("id", task.id).eq("status", "delivered").select("*")) as Task[];
    if (rows.length === 0) throw new RpcError("This request just changed. Reload it and try again.", 409);
    const row = rows[0];
    if (feedback === "revision_requested") {
      await systemMessage(task.id, "The user asked for a revision.");
      const note = optStr(args.note, 2000);
      if (note) {
        await db().from("task_messages").insert({ task_id: task.id, sender_id: p.role === "agent" ? p.id : null, sender_role: "agent", channel: p.role === "agent" ? "in_app" : "text", body: note });
      }
    }
    return (await decorateTasks([row]))[0];
  },

  async vaTasks(ctx, args): Promise<Task[]> {
    const p = staff(ctx);
    const agentId = str(args.agent_id, "Agent");
    await assertAgentAccess(p, agentId);
    const rows = q(await db().from("tasks").select("*").eq("agent_id", agentId).neq("status", "dismissed").order("created_at", { ascending: false }).limit(200)) as Task[];
    return decorateTasks(rows);
  },

  async vaCounts(ctx, args) {
    const p = staff(ctx);
    const agentId = str(args.agent_id, "Agent");
    await assertAgentAccess(p, agentId);
    const ev = await db().from("events").select("id", { count: "exact", head: true }).eq("agent_id", agentId).in("status", ["ready", "in_review"]);
    const tk = await db().from("tasks").select("id", { count: "exact", head: true }).eq("agent_id", agentId).in("status", ["received", "in_progress", "waiting"]);
    const checkin = await buildCheckin(p, agentId).catch(() => null);
    return { queue: ev.count ?? 0, tasks: tk.count ?? 0, checkin: checkin && !checkin.doneToday ? checkin.items.length : 0 };
  },

  /* ---------- Daily check-in ---------- */

  async vaCheckin(ctx, args): Promise<CheckinResult> {
    const p = staff(ctx);
    const agentId = str(args.agent_id, "User");
    await assertAgentAccess(p, agentId);
    return buildCheckin(p, agentId);
  },

  /** Records that the VA checked in with the user today, and by which channel. */
  async logCheckin(ctx, args): Promise<CheckinResult> {
    const p = staff(ctx);
    const agentId = str(args.agent_id, "User");
    await assertAgentAccess(p, agentId);
    const channel = ["text", "email", "call"].includes(args.channel) ? args.channel : "text";
    const current = await buildCheckin(p, agentId);
    const logged = await db().from("audit_log").insert({ actor_id: p.id, action: "checkin.sent", object_type: "agent", object_id: agentId, detail: { channel, count: current.items.length, note: optStr(args.note, 300) } });
    if (logged.error) throw new RpcError("The check-in could not be logged. Try again.", 500);
    return buildCheckin(p, agentId);
  },

  /* ---------- Watches ---------- */

  async createWatch(ctx, args): Promise<Watch> {
    const p = staff(ctx);
    const project = await loadProject(p, args.project_id);
    const res = await db()
      .from("watches")
      .insert({ project_id: project.id, agent_id: project.agent_id, condition: str(args.condition, "What to watch for", 300), note: optStr(args.note, 500), created_by: p.id })
      .select("*")
      .single();
    if (res.error) throw watchesMissing();
    await audit(p, "watch.create", "watch", (res.data as Watch).id);
    return res.data as Watch;
  },

  async updateWatch(ctx, args): Promise<Watch> {
    const p = staff(ctx);
    const watch = await loadWatch(p, args.watch_id);
    const patch: Record<string, unknown> = {};
    if (typeof args.condition === "string") patch.condition = str(args.condition, "What to watch for", 300);
    if ("note" in args) patch.note = optStr(args.note, 500);
    if (["active", "paused", "closed"].includes(args.status)) {
      patch.status = args.status;
      // Watching again starts fresh, so the next hit opens a new ticket.
      if (args.status === "active" && watch.status === "met") Object.assign(patch, { met_at: null, task_id: null });
    }
    if (Object.keys(patch).length === 0) return watch;
    return q(await db().from("watches").update(patch).eq("id", watch.id).select("*").single()) as Watch;
  },

  /** Runs the check now instead of waiting for the daily run. */
  async checkWatch(ctx, args): Promise<Watch> {
    const p = staff(ctx);
    const watch = await loadWatch(p, args.watch_id);
    if (watch.status !== "active") throw new RpcError("Only an active watch can be checked. Resume it first.");
    return runWatch(watch, p);
  },

  async vaQc(ctx, args): Promise<QcResult> {
    const p = staff(ctx);
    const agentId = str(args.agent_id, "Agent");
    await assertAgentAccess(p, agentId);
    const since = args.range === "all" ? "1970-01-01T00:00:00Z" : startOfWeekUtc(new Date()).toISOString();
    const events = q(await db().from("events").select("id,review_ms").eq("agent_id", agentId).eq("status", "submitted").gte("submitted_at", since)) as any[];
    const ids = events.map((e) => e.id);
    const facts = ids.length ? (q(await db().from("facts").select("verdict,origin").in("event_id", ids)) as any[]) : [];
    const tasks = q(await db().from("tasks").select("logged_ms,eta,delivered_at,agent_feedback,status").eq("agent_id", agentId).eq("status", "delivered").gte("delivered_at", since)) as any[];
    const verdicts = { pending: 0, approved: 0, edited: 0, declined: 0, insufficient: 0 } as Record<Verdict, number>;
    for (const f of facts) if (f.origin === "ai") verdicts[f.verdict as Verdict] += 1;
    const feedback = { used_as_is: 0, edited: 0, not_used: 0, revision_requested: 0, none: 0 } as QcResult["feedback"];
    for (const t of tasks) feedback[(t.agent_feedback ?? "none") as keyof QcResult["feedback"]] += 1;
    const reviewMs = events.reduce((sum, e) => sum + Number(e.review_ms), 0);
    const taskMs = tasks.reduce((sum, t) => sum + Number(t.logged_ms), 0);
    const withEta = tasks.filter((t) => t.eta && t.delivered_at);
    return {
      eventsVerified: events.length,
      avgReviewMinutes: events.length ? Math.round((reviewMs / events.length / 60000) * 10) / 10 : null,
      verdicts,
      tasksDelivered: tasks.length,
      avgTaskMinutes: tasks.length ? Math.round((taskMs / tasks.length / 60000) * 10) / 10 : null,
      onTimeRate: withEta.length ? Math.round((withEta.filter((t) => new Date(t.delivered_at) <= new Date(t.eta)).length / withEta.length) * 100) : null,
      feedback,
      totalMinutes: Math.round((reviewMs + taskMs) / 60000),
    };
  },

  /* ---------- share links ---------- */

  async createShareLink(ctx, args) {
    const p = staff(ctx);
    const project = await loadProject(p, args.project_id);
    q(await db().from("share_links").update({ revoked_at: new Date().toISOString() }).eq("project_id", project.id).is("revoked_at", null).select("id"));
    const token = randomBytes(24).toString("hex");
    const row = q(
      await db()
        .from("share_links")
        .insert({ project_id: project.id, token, created_by: p.id, expires_at: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString() })
        .select("id,token,expires_at,revoked_at")
        .single(),
    );
    await audit(p, "share.create", "project", project.id);
    return row;
  },

  async revokeShareLink(ctx, args) {
    const p = staff(ctx);
    const project = await loadProject(p, args.project_id);
    q(await db().from("share_links").update({ revoked_at: new Date().toISOString() }).eq("project_id", project.id).is("revoked_at", null).select("id"));
    await audit(p, "share.revoke", "project", project.id);
    return { ok: true };
  },

  async shareView(_ctx, args): Promise<ShareView> {
    const token = str(args.token, "Link", 100);
    const link = q(await db().from("share_links").select("*").eq("token", token).maybeSingle()) as any;
    if (!link || link.revoked_at || new Date(link.expires_at).getTime() < Date.now()) {
      throw new RpcError("This link has expired or was turned off. Ask your assistant for a new one.", 404);
    }
    const project = q(await db().from("projects").select("*").eq("id", link.project_id).single()) as Project;
    const detail = await buildProject(project, true);
    // Public page: send only the fields it renders.
    return {
      project: { client_name: project.client_name, deal_type: project.deal_type, area: project.area, budget: project.budget } as Project,
      agentName: detail.agent.name,
      vaName: detail.va?.name ?? null,
      facts: detail.facts.map(
        (f) =>
          ({
            id: f.id,
            event_id: f.event_id,
            section: f.section,
            statement: f.statement,
            verdict: f.verdict,
            change_type: f.change_type,
            changed_from: f.changed_from,
            follow_up_date: f.follow_up_date,
            follow_up_condition: f.follow_up_condition,
            evidence: f.evidence.map((e) => ({ line_id: "", idx: e.idx, start_ms: e.start_ms, speaker: e.speaker, quote: e.quote })),
            event_title: f.event_title,
            event_occurred_at: f.event_occurred_at,
            verified_by_name: f.verified_by_name ? f.verified_by_name.split(" ")[0] : null,
          }) as Fact,
      ),
      events: detail.events.map((e) => ({ id: e.id, title: e.title, source: e.source, occurred_at: e.occurred_at }) as EventRow),
      lastVerified: detail.lastVerified ? { at: detail.lastVerified.at, by: detail.lastVerified.by.split(" ")[0] } : null,
      expires_at: link.expires_at,
    };
  },
};
