-- Notique VA Pilot schema.
-- All application access goes through the server with the secret key.
-- Row Level Security is enabled on every table with no policies, so the
-- publishable key cannot read or write any application data directly.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  name text not null,
  role text not null check (role in ('admin', 'va', 'agent')),
  company text,
  timezone text not null default 'America/Los_Angeles',
  onboarded_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.assignments (
  va_id uuid not null references public.profiles (id) on delete cascade,
  agent_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (va_id, agent_id)
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.profiles (id) on delete cascade,
  client_name text not null,
  deal_type text not null default 'buyer' check (deal_type in ('buyer', 'seller', 'other')),
  area text,
  budget text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists projects_agent_idx on public.projects (agent_id);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  agent_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  event_type text not null default 'meeting',
  source text not null default 'transcript_upload',
  occurred_at timestamptz not null default now(),
  duration_sec integer,
  status text not null default 'processing'
    check (status in ('processing', 'extracting', 'ready', 'in_review', 'submitted', 'escalated', 'failed')),
  status_changed_at timestamptz not null default now(),
  error text,
  due_at timestamptz,
  audio_path text,
  source_path text,
  source_name text,
  raw_text text,
  stt_id text,
  summary text,
  checks jsonb not null default '{}'::jsonb,
  speaker_map jsonb not null default '{}'::jsonb,
  review_ms bigint not null default 0,
  escalation_note text,
  submitted_at timestamptz,
  submitted_by uuid references public.profiles (id),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
create index if not exists events_project_idx on public.events (project_id);
create index if not exists events_agent_status_idx on public.events (agent_id, status);

create table if not exists public.transcript_lines (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  idx integer not null,
  start_ms integer,
  speaker text not null default 'Speaker',
  text text not null
);
create index if not exists transcript_lines_event_idx on public.transcript_lines (event_id, idx);

create table if not exists public.facts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  section text not null
    check (section in ('decisions', 'budget', 'needs', 'questions', 'risks', 'next_steps')),
  statement text not null,
  ai_statement text,
  confidence numeric,
  verdict text not null default 'pending'
    check (verdict in ('pending', 'approved', 'edited', 'declined', 'insufficient')),
  change_type text not null default 'new' check (change_type in ('new', 'changed')),
  changed_from text,
  supersedes_id uuid references public.facts (id) on delete set null,
  follow_up_date date,
  follow_up_condition text,
  evidence jsonb not null default '[]'::jsonb,
  suggested_task jsonb,
  origin text not null default 'ai' check (origin in ('ai', 'va')),
  resolved_at timestamptz,
  verified_by uuid references public.profiles (id),
  verified_at timestamptz,
  position integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists facts_event_idx on public.facts (event_id);
create index if not exists facts_project_idx on public.facts (project_id);

create sequence if not exists public.task_number_seq start 11;

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  number integer not null default nextval('public.task_number_seq'),
  project_id uuid not null references public.projects (id) on delete cascade,
  agent_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  description text not null default '',
  category text not null default 'Research',
  status text not null default 'suggested'
    check (status in ('suggested', 'received', 'in_progress', 'waiting', 'delivered', 'cancelled', 'dismissed')),
  origin_fact_id uuid references public.facts (id) on delete set null,
  origin_event_id uuid references public.events (id) on delete set null,
  requested_via text,
  eta timestamptz,
  est_minutes integer,
  logged_ms bigint not null default 0,
  timer_started_at timestamptz,
  assigned_at timestamptz,
  delivered_at timestamptz,
  agent_feedback text check (agent_feedback in ('used_as_is', 'edited', 'not_used', 'revision_requested')),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
create index if not exists tasks_project_idx on public.tasks (project_id);
create index if not exists tasks_agent_status_idx on public.tasks (agent_id, status);

create table if not exists public.task_messages (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  sender_id uuid references public.profiles (id),
  sender_role text not null check (sender_role in ('va', 'agent', 'system')),
  channel text not null default 'in_app' check (channel in ('in_app', 'text', 'email', 'call')),
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists task_messages_task_idx on public.task_messages (task_id, created_at);

create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  event_id uuid references public.events (id) on delete set null,
  task_id uuid references public.tasks (id) on delete set null,
  kind text not null check (kind in ('project', 'attachment', 'deliverable', 'source')),
  status text not null default 'delivered' check (status in ('draft', 'delivered')),
  name text not null,
  path text,
  url text,
  size bigint,
  mime text,
  note text,
  uploaded_by uuid references public.profiles (id),
  uploaded_role text,
  created_at timestamptz not null default now()
);
create index if not exists files_project_idx on public.files (project_id);

create table if not exists public.share_links (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  token text not null unique,
  created_by uuid references public.profiles (id),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid,
  action text not null,
  object_type text,
  object_id text,
  detail jsonb,
  at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.assignments enable row level security;
alter table public.projects enable row level security;
alter table public.events enable row level security;
alter table public.transcript_lines enable row level security;
alter table public.facts enable row level security;
alter table public.tasks enable row level security;
alter table public.task_messages enable row level security;
alter table public.files enable row level security;
alter table public.share_links enable row level security;
alter table public.audit_log enable row level security;

insert into storage.buckets (id, name, public)
values ('files', 'files', false)
on conflict (id) do nothing;

-- The server uses the secret key (service_role). Make sure it can reach everything,
-- and that the browser roles cannot.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
revoke all on all tables in schema public from anon, authenticated;
