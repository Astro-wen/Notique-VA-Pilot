export type Role = "admin" | "va" | "agent";

export interface Profile {
  id: string;
  email: string;
  name: string;
  role: Role;
  company: string | null;
  timezone: string;
  onboarded_at: string | null;
  created_at: string;
}

export interface Project {
  id: string;
  agent_id: string;
  client_name: string;
  deal_type: "buyer" | "seller" | "other";
  area: string | null;
  budget: string | null;
  created_at: string;
  archived_at: string | null;
}

export type EventStatus =
  | "processing"
  | "extracting"
  | "ready"
  | "in_review"
  | "submitted"
  | "escalated"
  | "failed";

export type EventSource =
  | "recording"
  | "transcript_upload"
  | "text_upload"
  | "crm"
  | "voice_memo"
  | "note";

export interface EventChecks {
  consent?: boolean;
  pii?: boolean;
  fair_housing?: boolean;
  type_match?: boolean;
}

export interface EventRow {
  id: string;
  project_id: string;
  agent_id: string;
  title: string;
  event_type: string;
  source: EventSource;
  occurred_at: string;
  duration_sec: number | null;
  status: EventStatus;
  status_changed_at: string;
  error: string | null;
  due_at: string | null;
  audio_path: string | null;
  source_name: string | null;
  summary: string | null;
  checks: EventChecks;
  speaker_map: Record<string, string>;
  /** Earlier open items this conversation settles; resolved on submit. */
  settles?: string[];
  review_ms: number;
  escalation_note: string | null;
  submitted_at: string | null;
  created_at: string;
}

export interface TranscriptLine {
  id: string;
  event_id: string;
  idx: number;
  start_ms: number | null;
  speaker: string;
  text: string;
}

export type Section =
  | "decisions"
  | "budget"
  | "needs"
  | "questions"
  | "risks"
  | "next_steps";

export const SECTIONS: { key: Section; label: string }[] = [
  { key: "decisions", label: "Decisions" },
  { key: "budget", label: "Budget" },
  { key: "needs", label: "Client needs" },
  { key: "questions", label: "Open questions" },
  { key: "risks", label: "Concerns and risks" },
  { key: "next_steps", label: "Next steps" },
];

export type Verdict = "pending" | "approved" | "edited" | "declined" | "insufficient";

export interface Evidence {
  line_id: string;
  idx: number;
  start_ms: number | null;
  speaker: string;
  quote: string;
}

export interface SuggestedTask {
  title: string;
  description: string;
  category: string;
  est_minutes: number | null;
}

export interface Fact {
  id: string;
  event_id: string;
  project_id: string;
  section: Section;
  statement: string;
  ai_statement: string | null;
  confidence: number | null;
  verdict: Verdict;
  change_type: "new" | "changed";
  changed_from: string | null;
  supersedes_id: string | null;
  follow_up_date: string | null;
  follow_up_condition: string | null;
  evidence: Evidence[];
  suggested_task: SuggestedTask | null;
  origin: "ai" | "va";
  resolved_at: string | null;
  verified_at: string | null;
  position: number;
  created_at: string;
  /** Joined in project views. */
  event_title?: string;
  event_occurred_at?: string;
  verified_by_name?: string | null;
  /** The user answered this item themselves. */
  confirmed_by_user?: boolean;
}

export type TaskStatus =
  | "suggested"
  | "received"
  | "in_progress"
  | "waiting"
  | "delivered"
  | "cancelled"
  | "dismissed";

export type AgentFeedback = "used_as_is" | "edited" | "not_used" | "revision_requested";

export const TASK_CATEGORIES = [
  "Research",
  "Listing shortlist",
  "Comparison table",
  "Follow-up draft",
  "Meeting brief",
  "Document prep",
  "Other",
] as const;

export interface Task {
  id: string;
  number: number;
  project_id: string;
  agent_id: string;
  title: string;
  description: string;
  category: string;
  status: TaskStatus;
  origin_fact_id: string | null;
  origin_event_id: string | null;
  requested_via: string | null;
  eta: string | null;
  est_minutes: number | null;
  logged_ms: number;
  timer_started_at: string | null;
  assigned_at: string | null;
  delivered_at: string | null;
  agent_feedback: AgentFeedback | null;
  created_at: string;
  /** Joined fields. */
  project_name?: string;
  origin_event_title?: string | null;
  message_count?: number;
}

export interface TaskMessage {
  id: string;
  task_id: string;
  sender_id: string | null;
  sender_role: "va" | "agent" | "system";
  sender_name?: string;
  channel: "in_app" | "text" | "email" | "call";
  body: string;
  created_at: string;
}

export interface FileRow {
  id: string;
  project_id: string;
  event_id: string | null;
  task_id: string | null;
  kind: "project" | "attachment" | "deliverable" | "source";
  status: "draft" | "delivered";
  name: string;
  path: string | null;
  url: string | null;
  size: number | null;
  mime: string | null;
  note: string | null;
  uploaded_role: string | null;
  uploaded_by_name?: string | null;
  created_at: string;
}

export interface ShareLink {
  id: string;
  token: string;
  expires_at: string;
  revoked_at: string | null;
}

/* ---------- RPC result shapes ---------- */

export interface AgentSummary {
  id: string;
  name: string;
  company: string | null;
  timezone: string;
  pending_events: number;
}

export interface MeResult {
  profile: Profile;
  /** For VAs and admins: users they can serve. Empty for users. */
  agents: AgentSummary[];
  /** For users: the name of the VA assigned to them, if any. */
  assistant?: string | null;
}

export interface QueueEvent extends EventRow {
  project_name: string;
  fact_count: number;
  resolved_count: number;
  line_count: number;
}

export interface QueueResult {
  agent: AgentSummary;
  events: QueueEvent[];
  processing: QueueEvent[];
  ticketsDue: Task[];
  stats: { overdue?: number; dueSoon: number; dueToday: number; verifiedThisWeek: number };
  sources: Record<EventSource, { count_week: number; last_at: string | null }>;
  projects: Project[];
}

export interface EventDetail {
  event: EventRow;
  project: Project;
  lines: TranscriptLine[];
  facts: Fact[];
  audioUrl: string | null;
  position: { index: number; total: number };
  canReopen: boolean;
  /** The client's earlier open questions, risks and next steps, so the VA can mark the ones this conversation settles. */
  openItems?: { id: string; section: Section; statement: string; event_title: string }[];
}

export type WatchStatus = "active" | "met" | "paused" | "closed";

/** A market condition checked once a day for a project. */
export interface Watch {
  id: string;
  project_id: string;
  agent_id: string;
  condition: string;
  note: string | null;
  status: WatchStatus;
  last_checked_at: string | null;
  last_result: { met: boolean; summary: string; sources: { title: string; url: string }[]; error?: string; /** Unreviewed client note drafted when the condition was met. Staff only. */ draft?: string } | null;
  met_at: string | null;
  task_id: string | null;
  created_at: string;
}

export interface CheckinItem {
  kind: "suggested" | "waiting" | "unreviewed" | "question";
  id: string;
  project_id: string;
  project_name: string;
  title: string;
  /** Whole days this has been waiting on the user. */
  days: number;
  task_id: string | null;
  task_number: number | null;
}

export interface CheckinResult {
  items: CheckinItem[];
  /** Ready to paste into a text or email to the user. */
  message: string;
  last: { at: string; by: string; channel: string; count: number } | null;
  history: { at: string; by: string; channel: string; count: number; note: string | null }[];
  doneToday: boolean;
  /** Which channels the system can send on, and whether this user agreed to them. */
  reach: { email: boolean; sms: boolean; emailTo: string | null; smsTo: string | null };
}

export interface ProjectDetail {
  project: Project;
  agent: { id: string; name: string; timezone: string };
  va: { id: string; name: string } | null;
  events: EventRow[];
  /** Approved or edited facts only. */
  facts: Fact[];
  /** Verified facts that are done or were replaced later. Used by the timeline only. */
  historyFacts?: Fact[];
  /** Insufficient facts. Empty in user views. */
  /** Items the VA could not settle from the conversation, for the user to confirm. */
  needsInput: Fact[];
  /** VA view only: items the user said are not right. */
  userDeclined?: Fact[];
  tasks: Task[];
  files: FileRow[];
  shareLink: ShareLink | null;
  pendingEvents: number;
  pendingList?: { id: string; title: string; occurred_at: string; source: string; due_at: string | null }[];
  /** When the last conversation still being verified is due. */
  pendingDue?: string | null;
  /** Uploads still being transcribed or read. */
  processingEvents: number;
  lastVerified: { at: string; by: string } | null;
  /** Null when the watches table has not been created yet. */
  watches: Watch[] | null;
  /** Uploads that could not be read. Shown so they do not silently disappear. */
  failedUploads?: { id: string; title: string }[];
}

export interface ProjectListItem extends Project {
  event_count: number;
  open_tasks: number;
  /** Delivered work the user has not reviewed yet. */
  to_review?: number;
  verify_due?: string | null;
  /** Requests where the VA is waiting on the user. */
  needs_answer?: number;
  /** Suggested follow-ups the user has not sent or dismissed. */
  suggested?: number;
  /** Requests the VA is working on, not waiting on the user. */
  in_progress?: number;
  /** Requests the assistant has, for the list across clients on the home screen. */
  with_assistant?: { id: string; title: string; eta: string | null; status: string; sent_at: string | null }[];
  /** Uploads that could not be read. */
  failed_events?: number;
  to_confirm?: number;
  pending_events: number;
  last_activity: string | null;
}

/** AI first draft of a ticket's deliverable. Staff only. */
export interface TaskDraft {
  task_id: string;
  status: "working" | "ready" | "failed";
  body: string | null;
  gaps: string[];
  model: string | null;
  error: string | null;
  updated_at: string;
  /** Set once the VA has changed the text. */
  edited_at?: string | null;
}

export type ReachChannel = "off" | "email" | "sms" | "both";

export interface ContactPrefs {
  phone: string | null;
  /** Delivery and question notices. */
  notify: ReachChannel;
  /** Daily morning brief. */
  brief: ReachChannel;
}

export interface TaskDetail {
  /** Present for staff when drafting is switched on. Never sent to users. */
  draft?: TaskDraft | null;
  task: Task;
  project: Project;
  messages: TaskMessage[];
  files: FileRow[];
  contextEvents: { id: string; title: string; occurred_at: string }[];
}

export interface QcResult {
  eventsVerified: number;
  avgReviewMinutes: number | null;
  verdicts: Record<Verdict, number>;
  tasksDelivered: number;
  avgTaskMinutes: number | null;
  onTimeRate: number | null;
  feedback: Record<AgentFeedback | "none", number>;
  totalMinutes: number;
}

export interface ShareView {
  project: Project;
  agentName: string;
  vaName: string | null;
  facts: Fact[];
  events: EventRow[];
  lastVerified: { at: string; by: string } | null;
  expires_at: string;
}

export interface AdminUser extends Profile {
  assigned_agent_ids: string[];
  contact?: ContactPrefs | null;
}
