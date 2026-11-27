-- The user answers items the VA left for them to confirm.
-- After a conversation is submitted its items stay locked, with one exception: an item marked
-- "Waiting for the user" may be confirmed, corrected or rejected by the user, and that answer may be undone.
-- Only the decision, its wording, who made it and when may change.
create or replace function public.guard_fact_change() returns trigger
language plpgsql as $$
declare
  eid uuid;
  st text;
  answer_cols text[] := array['verdict', 'statement', 'verified_by', 'verified_at', 'resolved_at'];
begin
  if tg_op = 'DELETE' then eid := old.event_id; else eid := new.event_id; end if;
  select status into st from public.events where id = eid for share;
  if st is null then
    -- The conversation itself is being deleted.
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if st not in ('submitted', 'escalated') then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if tg_op = 'UPDATE' and (to_jsonb(new) - 'resolved_at') = (to_jsonb(old) - 'resolved_at') then
    return new;
  end if;
  if tg_op = 'UPDATE' and st = 'submitted'
     and (to_jsonb(new) - answer_cols) = (to_jsonb(old) - answer_cols)
     and (
       (old.verdict = 'insufficient' and new.verdict in ('approved', 'edited', 'declined'))
       or (old.verdict in ('approved', 'edited', 'declined') and new.verdict = 'insufficient')
     ) then
    return new;
  end if;
  raise exception 'EVENT_LOCKED';
end $$;
