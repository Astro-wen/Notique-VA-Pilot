/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomBytes, randomUUID } from "node:crypto";
import { BUCKET, db } from "./supabase";
import { nextBusinessDayNine, startOfWeekUtc } from "./time";
import {
  PipelineError,
  docxToText,
  extractFacts,
  getTranscription,
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

function optStr(v: unknown, max = 500): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
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
  const id = str(projectId, "Project");
  const row = q(await db().from("projects").select("*").eq("id", id).maybeSingle()) as Project | null;
  if (!row) throw new RpcError("Project not found.", 404);
  await assertAgentAccess(p, row.agent_id);
  return row;
}

async function loadEvent(p: Profile, eventId: unknown): Promise<EventRow & { raw_text: string | null; stt_id: string | null; source_path: string | null }> {
  const id = str(eventId, "Event");
  const row = q(await db().from("events").select("*").eq("id", id).maybeSingle()) as any;
  if (!row) throw new RpcError("Event not found.", 404);
  await assertAgentAccess(p, row.agent_id);
  return row;
}

async function loadTask(p: Profile, taskId: unknown): Promise<Task> {
  const id = str(taskId, "Task");
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
  return { ...rest, summary: null, checks: {}, review_ms: 0, escalation_note: null, audio_path: null, speaker_map: {}, error: rest.status === "failed" ? rest.error : null } as EventRow;
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
  await setEventStatus(id, "failed", { error: message.slice(0, 500) });
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
      await runExtraction(event.id);
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
  const events = q(await db().from("events").select("project_id,status,occurred_at").in("project_id", ids)) as any[];
  const tasks = q(await db().from("tasks").select("project_id,status").in("project_id", ids)) as any[];
  return projects.map((p) => {
    const ev = events.filter((e) => e.project_id === p.id);
    const last = ev.map((e) => e.occurred_at).sort().pop() ?? null;
    return {
      ...p,
      event_count: ev.filter((e) => e.status === "submitted").length,
      pending_events: ev.filter((e) => ["processing", "extracting", "ready", "in_review"].includes(e.status)).length,
      open_tasks: tasks.filter((t) => t.project_id === p.id && ["suggested", "received", "in_progress", "waiting"].includes(t.status)).length,
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
    lastVerified,
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
    const password = str(args.password, "Password", 200);
    if (password.length < 8) throw new RpcError("Password must be at least 8 characters.");
    const created = await db().auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new RpcError(created.error?.message ?? "Could not create the account.");
    const inserted = await db().from("profiles").insert({ id: created.data.user.id, email, name, role: "admin", timezone: optStr(args.timezone, 60) ?? "America/Los_Angeles" }).select("id");
    if (inserted.error) {
      await db().auth.admin.deleteUser(created.data.user.id);
      throw new RpcError(`Database error: ${inserted.error.message}`, 500);
    }
    return { ok: true };
  },

  async me(ctx): Promise<MeResult> {
    const p = me(ctx);
    return { profile: p, agents: await agentSummaries(p) };
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
    const password = str(args.password, "Temporary password", 200);
    if (password.length < 8) throw new RpcError("Password must be at least 8 characters.");
    const created = await db().auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) {
      const msg = created.error?.message ?? "Could not create the account.";
      throw new RpcError(/already/i.test(msg) ? "An account with this email already exists." : msg);
    }
    const insert = await db()
      .from("profiles")
      .insert({ id: created.data.user.id, email, name, role, company: optStr(args.company, 120), timezone: optStr(args.timezone, 60) ?? "America/Los_Angeles" })
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
    if (typeof args.timezone === "string") patch.timezone = str(args.timezone, "Time zone", 60);
    if (typeof args.role === "string") {
      if (!["admin", "va", "agent"].includes(args.role)) throw new RpcError("Role must be Admin, VA, or User.");
      const current = q(await db().from("profiles").select("role").eq("id", id).maybeSingle()) as { role: string } | null;
      if (!current) throw new RpcError("Account not found.", 404);
      if (current.role !== args.role) {
        if (id === me(ctx).id) throw new RpcError("You cannot change your own role.");
        if (current.role === "agent") {
          const owned = await db().from("projects").select("id", { count: "exact", head: true }).eq("agent_id", id);
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
    const password = str(args.password, "New password", 200);
    if (password.length < 8) throw new RpcError("Password must be at least 8 characters.");
    const res = await db().auth.admin.updateUserById(id, { password });
    if (res.error) throw new RpcError(res.error.message);
    await audit(p, "user.reset_password", "profile", id);
    return { ok: true };
  },

  async adminSetAssignment(ctx, args) {
    const p = admin(ctx);
    const va_id = str(args.va_id, "VA");
    const agent_id = str(args.agent_id, "Agent");
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
    const name = str(args.name, "File name", 200);
    const safe = name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "file";
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
    if (path && !path.startsWith(`${project.agent_id}/${project.id}/`)) throw new RpcError("Invalid file path.");
    if (url && !/^https?:\/\//i.test(url)) throw new RpcError("Links must start with http or https.");
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
      if (path && !path.startsWith(prefix)) throw new RpcError("Invalid file path.");
    }
    if (!audioPath && !filePath && imagePaths.length === 0 && text.trim().length < 20) {
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
    await audit(p, "event.create", "event", event.id, { source });

    try {
      if (audioPath) {
        await startAudio(event.id, audioPath);
      } else {
        let body = text;
        if (imagePaths.length) {
          const urls = await Promise.all(imagePaths.map((path) => signedUrl(path, 1800)));
          body = await transcribeScreenshots(urls);
        } else if (filePath) {
          const dl = await db().storage.from(BUCKET).download(filePath);
          if (dl.error || !dl.data) throw new PipelineError(`Could not read the uploaded file: ${dl.error?.message ?? "unknown error"}`);
          const buffer = Buffer.from(await dl.data.arrayBuffer());
          body = /\.docx$/i.test(filePath) ? await docxToText(buffer) : buffer.toString("utf8");
        }
        q(await db().from("events").update({ raw_text: body.slice(0, 400000) }).eq("id", event.id).select("id"));
        await processText(event.id, body);
      }
    } catch (err) {
      await failEvent(event.id, err);
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
    if (locked && (args.checks || args.speaker_map || typeof args.title === "string")) {
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
    const fact = q(await db().from("facts").select("*").eq("id", str(args.fact_id, "Fact")).maybeSingle()) as any;
    if (!fact) throw new RpcError("This item no longer exists.", 404);
    await loadProject(p, fact.project_id);
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
          description: str(args.description, "Description", 2000),
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
    if (typeof args.description === "string") patch.description = str(args.description, "Description", 2000);
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
    q(await db().from("tasks").update({ status: "dismissed" }).eq("id", task.id).select("id"));
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
    const row = q(await db().from("tasks").update(patch).eq("id", task.id).select("*").single()) as Task;
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
      q(await db().from("tasks").update({ status: "waiting", ...pauseTimerPatch(task) }).eq("id", task.id).select("id"));
    } else if (senderRole === "agent" && task.status === "waiting") {
      q(await db().from("tasks").update({ status: "in_progress" }).eq("id", task.id).select("id"));
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
    const row = q(await db().from("tasks").update(patch).eq("id", task.id).select("*").single()) as Task;
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
    return { queue: ev.count ?? 0, tasks: tk.count ?? 0 };
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
