-- Marks an AI first draft the VA has changed, so writing it again asks before replacing those edits.
alter table public.task_drafts add column if not exists edited_at timestamptz;
