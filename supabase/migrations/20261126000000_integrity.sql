-- Data integrity under concurrent use.

-- 1. Facts can only change while their conversation is being prepared or reviewed.
--    Once it is submitted or escalated, only the resolved marker may change.
--    The row lock on the event makes a late edit and a submit run one after the other, never interleaved.
create or replace function public.guard_fact_change() returns trigger
language plpgsql as $$
declare
  eid uuid;
  st text;
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
  raise exception 'EVENT_LOCKED';
end $$;

drop trigger if exists facts_guard on public.facts;
create trigger facts_guard before insert or update or delete on public.facts
for each row execute function public.guard_fact_change();

-- 2. One open suggestion per fact, so two submits can never suggest the same follow-up twice.
do $$
begin
  create unique index if not exists tasks_one_suggestion_per_fact on public.tasks (origin_fact_id) where origin_fact_id is not null and status = 'suggested';
exception when others then
  raise notice 'tasks_one_suggestion_per_fact was not created: %', sqlerrm;
end $$;

-- 3. Faster daily check-in history.
create index if not exists audit_log_action_object_idx on public.audit_log (action, object_id, at desc);
