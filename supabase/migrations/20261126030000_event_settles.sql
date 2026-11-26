-- Earlier open items (questions, risks, next steps) that this conversation answers or makes no longer true.
-- The AI proposes them, the VA confirms in Verify, and Submit marks them resolved.
alter table public.events add column if not exists settles uuid[] not null default '{}';
