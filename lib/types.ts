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
  { key: "budget", label: "Budget changes" },
  { key: "needs", label: "Needs changes" },
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
  stats: { dueSoon: number; dueToday: number; verifiedThisWeek: number };
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
}

export interface ProjectDetail {
  project: Project;
  agent: { id: string; name: string; timezone: string };
  va: { id: string; name: string } | null;
  events: EventRow[];
  /** Approved or edited facts only. */
  facts: Fact[];
  /** Insufficient facts. Empty in user views. */
  needsInput: Fact[];
  tasks: Task[];
  files: FileRow[];
  shareLink: ShareLink | null;
  pendingEvents: number;
  /** Uploads still being transcribed or read. */
  processingEvents: number;
  lastVerified: { at: string; by: string } | null;
}

export interface ProjectListItem extends Project {
  event_count: number;
  open_tasks: number;
  /** Delivered work the user has not reviewed yet. */
  to_review?: number;
  /** Requests where the VA is waiting on the user. */
  needs_answer?: number;
  pending_events: number;
  last_activity: string | null;
}

export interface TaskDetail {
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
}
