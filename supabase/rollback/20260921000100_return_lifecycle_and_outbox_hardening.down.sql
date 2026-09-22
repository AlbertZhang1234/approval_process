begin;

drop function if exists approval_api.reset_dead_outbox_event(jsonb);
drop function if exists approval_api.list_dead_outbox_events(jsonb);
drop function if exists approval_api.mark_outbox_event_dead(jsonb);
drop function if exists approval_api.get_instance_by_business(jsonb);

-- This rollback keeps the replaced list_tasks / persist_instance_change
-- signatures and the widened check constraints, because reverting them would
-- discard return and resubmit audit rows. To fully reset a disposable
-- environment, drop both schemas with the initial rollback and replay all
-- migrations.

drop index if exists approval.outbox_events_dead_idx;
drop index if exists approval.approval_tasks_assignee_status_id_idx;
create index if not exists approval_tasks_assignee_status_idx
  on approval.approval_tasks (assignee_id, status, created_at desc);

alter table approval.outbox_events
  drop column if exists dead_lettered_at;

commit;
