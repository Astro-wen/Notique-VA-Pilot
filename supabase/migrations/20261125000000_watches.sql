-- Watches: a market condition a VA asks Notique to check once a day for a project.
-- When it becomes true, a ticket is opened so the VA can prepare the follow-up for the user.
create table if not exists public.watches (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  agent_id uuid not null references public.profiles (id) on delete cascade,
  condition text not null,
  note text,
  status text not null default 'active' check (status in ('active', 'met', 'paused', 'closed')),
  last_checked_at timestamptz,
  last_result jsonb,
  met_at timestamptz,
  task_id uuid references public.tasks (id) on delete set null,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
create index if not exists watches_project_idx on public.watches (project_id);
create index if not exists watches_status_idx on public.watches (status, last_checked_at);

alter table public.watches enable row level security;
grant all on public.watches to service_role;
revoke all on public.watches from anon, authenticated;
