-- AI first drafts for tickets. Staff only: kept out of the tasks table so they can never ride along to the user.
create table if not exists public.task_drafts (
  task_id uuid primary key references public.tasks (id) on delete cascade,
  status text not null default 'working' check (status in ('working', 'ready', 'failed')),
  body text,
  gaps jsonb not null default '[]'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  model text,
  error text,
  updated_at timestamptz not null default now()
);

-- How each user wants to be reached. Off unless an admin turns it on after the user agreed.
create table if not exists public.contact_prefs (
  agent_id uuid primary key references public.profiles (id) on delete cascade,
  phone text,
  notify text not null default 'off' check (notify in ('off', 'email', 'sms', 'both')),
  brief text not null default 'off' check (brief in ('off', 'email', 'sms', 'both')),
  updated_at timestamptz not null default now()
);

-- Every message the system sent, or tried to send, to a user.
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,
  channel text not null check (channel in ('email', 'sms')),
  recipient text not null,
  subject text,
  body text not null,
  status text not null check (status in ('sent', 'failed')),
  error text,
  sent_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists notifications_agent_idx on public.notifications (agent_id, kind, created_at desc);

alter table public.task_drafts enable row level security;
alter table public.contact_prefs enable row level security;
alter table public.notifications enable row level security;
grant all on public.task_drafts, public.contact_prefs, public.notifications to service_role;
revoke all on public.task_drafts, public.contact_prefs, public.notifications from anon, authenticated;
