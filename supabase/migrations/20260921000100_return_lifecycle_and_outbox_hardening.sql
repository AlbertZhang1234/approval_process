begin;

-- Extended transition audit for return / resubmit chains.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'approval.transition_history'::regclass
      and c.contype = 'c'
      and c.conkey = (
        select array[a.attnum]
        from pg_attribute a
        where a.attrelid = 'approval.transition_history'::regclass
          and a.attname = 'transition_type'
      )
  loop
    execute format('alter table approval.transition_history drop constraint %I', constraint_name);
  end loop;
end $$;

alter table approval.transition_history
  add constraint transition_history_transition_type_check
  check (transition_type in ('FORWARD', 'RETURN', 'RESUBMIT'));

-- Return actions are recorded in the approval audit trail.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'approval.approval_actions'::regclass
      and c.contype = 'c'
      and c.conkey = (
        select array[a.attnum]
        from pg_attribute a
        where a.attrelid = 'approval.approval_actions'::regclass
          and a.attname = 'action_type'
      )
  loop
    execute format('alter table approval.approval_actions drop constraint %I', constraint_name);
  end loop;
end $$;

alter table approval.approval_actions
  add constraint approval_actions_action_type_check
  check (action_type in ('APPROVE', 'REJECT', 'REJECT_TO_APPLICANT', 'RETURN_TO_NODE'));

-- Outbox dead-letter state and bookkeeping.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'approval.outbox_events'::regclass
      and c.contype = 'c'
      and c.conkey = (
        select array[a.attnum]
        from pg_attribute a
        where a.attrelid = 'approval.outbox_events'::regclass
          and a.attname = 'status'
      )
  loop
    execute format('alter table approval.outbox_events drop constraint %I', constraint_name);
  end loop;
end $$;

alter table approval.outbox_events
  add constraint outbox_events_status_check
  check (status in ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD'));

alter table approval.outbox_events
  add column if not exists dead_lettered_at timestamptz;

create index if not exists outbox_events_dead_idx
  on approval.outbox_events (dead_lettered_at desc, id)
  where status = 'DEAD';

-- Keyset-friendly task index including the deterministic id tie breaker.
drop index if exists approval.approval_tasks_assignee_status_idx;

create index approval_tasks_assignee_status_id_idx
  on approval.approval_tasks (assignee_id, status, created_at desc, id desc);

-- persist_instance_change now records the command operation type for audit.
create or replace function approval_api.persist_instance_change(p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  instance jsonb := p_input -> 'instance';
  existing approval.idempotency_records;
  changed_id text;
begin
  select * into existing
  from approval.idempotency_records
  where idempotency_key = p_input ->> 'idempotencyKey';
  if found then
    if existing.fingerprint <> p_input ->> 'fingerprint' then
      raise exception 'APPROVAL:IDEMPOTENCY_CONFLICT';
    end if;
    return approval.instance_json(existing.instance_id);
  end if;

  update approval.workflow_instances
  set context = instance -> 'context',
      context_revision = (instance ->> 'contextRevision')::integer,
      status = instance ->> 'status',
      current_execution_id = null,
      version = version + 1,
      updated_at = (instance ->> 'updatedAt')::timestamptz
  where id = instance ->> 'id'
    and version = (p_input ->> 'expectedVersion')::bigint
  returning id into changed_id;
  if not found then
    if not exists (
      select 1 from approval.workflow_instances i where i.id = instance ->> 'id'
    ) then
      raise exception 'APPROVAL:INSTANCE_NOT_FOUND';
    end if;
    raise exception 'APPROVAL:VERSION_CONFLICT';
  end if;

  perform approval.persist_instance_children(instance);
  update approval.workflow_instances
  set current_execution_id = instance ->> 'currentExecutionId'
  where id = changed_id;
  perform approval.persist_events(changed_id, p_input -> 'events');

  insert into approval.idempotency_records (
    idempotency_key, fingerprint, operation_type, instance_id, created_at
  ) values (
    p_input ->> 'idempotencyKey', p_input ->> 'fingerprint',
    coalesce(nullif(p_input ->> 'operationType', ''), 'ACT'), changed_id, now()
  );
  return approval.instance_json(changed_id);
exception
  when unique_violation then
    select * into existing
    from approval.idempotency_records
    where idempotency_key = p_input ->> 'idempotencyKey';
    if found then
      if existing.fingerprint <> p_input ->> 'fingerprint' then
        raise exception 'APPROVAL:IDEMPOTENCY_CONFLICT';
      end if;
      return approval.instance_json(existing.instance_id);
    end if;
    raise;
end;
$$;

-- Business documents locate their latest approval instance.
create or replace function approval_api.get_instance_by_business(p_input jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select approval.instance_json(i.id)
  from approval.workflow_instances i
  where i.business_type = p_input ->> 'businessType'
    and i.business_id = p_input ->> 'businessId'
    and (
      p_input -> 'status' is null
      or i.status in (select jsonb_array_elements_text(p_input -> 'status'))
    )
  order by i.created_at desc, i.id desc
  limit 1;
$$;

-- Unified todo queries: business type filter, keyset pagination, ordering.
create or replace function approval_api.list_tasks(p_input jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := coalesce((p_input ->> 'limit')::integer, 50);
  v_order text := coalesce(p_input ->> 'orderBy', 'CREATED_DESC');
  v_cursor timestamptz;
  v_cursor_id text;
  v_result jsonb;
begin
  if v_limit not between 1 and 100 then
    raise exception 'APPROVAL:INVALID_COMMAND';
  end if;
  if v_order not in ('CREATED_DESC', 'CREATED_ASC') then
    raise exception 'APPROVAL:INVALID_COMMAND';
  end if;
  if p_input -> 'cursor' is not null then
    v_cursor := (p_input -> 'cursor' ->> 'createdAt')::timestamptz;
    v_cursor_id := p_input -> 'cursor' ->> 'id';
  end if;

  with page as (
    select t.id, t.created_at
    from approval.approval_tasks t
    join approval.workflow_instances i on i.id = t.instance_id
    where t.assignee_id = p_input ->> 'assigneeId'
      and ((p_input ->> 'status') is null or t.status = p_input ->> 'status')
      and ((p_input ->> 'businessType') is null or i.business_type = p_input ->> 'businessType')
      and (
        v_cursor is null
        or (v_order = 'CREATED_ASC' and (t.created_at, t.id) > (v_cursor, v_cursor_id))
        or (v_order = 'CREATED_DESC' and (t.created_at, t.id) < (v_cursor, v_cursor_id))
      )
    order by
      case when v_order = 'CREATED_ASC' then t.created_at end asc,
      case when v_order = 'CREATED_DESC' then t.created_at end desc,
      case when v_order = 'CREATED_ASC' then t.id end asc,
      case when v_order = 'CREATED_DESC' then t.id end desc
    limit v_limit + 1
  )
  select jsonb_build_object(
    'tasks', coalesce((
      select jsonb_agg(
        approval.task_json(t)
        order by
          case when v_order = 'CREATED_ASC' then t.created_at end asc,
          case when v_order = 'CREATED_DESC' then t.created_at end desc,
          case when v_order = 'CREATED_ASC' then t.id end asc,
          case when v_order = 'CREATED_DESC' then t.id end desc
      )
      from approval.approval_tasks t
      where t.id in (select id from page limit v_limit)
    ), '[]'::jsonb),
    'nextCursor', (
      select jsonb_build_object('createdAt', created_at, 'id', id)
      from page
      offset v_limit
      limit 1
    )
  ) into v_result;

  return v_result;
end;
$$;

-- Dead-letter policy: mark, inspect and requeue poisoned events.
create or replace function approval_api.mark_outbox_event_dead(p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  update approval.outbox_events
  set status = 'DEAD',
      dead_lettered_at = (p_input ->> 'occurredAt')::timestamptz,
      locked_at = null,
      locked_by = null,
      last_error = left(p_input ->> 'error', 2000)
  where id = p_input ->> 'eventId'
    and status = 'PROCESSING'
    and locked_by = p_input ->> 'workerId';
  if not found then raise exception 'APPROVAL:OUTBOX_LOCK_CONFLICT'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function approval_api.list_dead_outbox_events(p_input jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'event', e.payload,
        'attempts', e.attempts,
        'lastError', e.last_error,
        'deadLetteredAt', e.dead_lettered_at
      )
      order by e.dead_lettered_at desc nulls last, e.id
    ),
    '[]'::jsonb
  )
  from (
    select *
    from approval.outbox_events
    where status = 'DEAD'
    order by dead_lettered_at desc nulls last, id
    limit least(coalesce((p_input ->> 'limit')::integer, 50), 100)
  ) e;
$$;

create or replace function approval_api.reset_dead_outbox_event(p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  update approval.outbox_events
  set status = 'PENDING',
      attempts = 0,
      available_at = (p_input ->> 'retryAt')::timestamptz,
      dead_lettered_at = null,
      last_error = null
  where id = p_input ->> 'eventId'
    and status = 'DEAD';
  if not found then raise exception 'APPROVAL:OUTBOX_EVENT_NOT_FOUND'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on all functions in schema approval_api from public, anon, authenticated;
grant execute on all functions in schema approval_api to service_role;

commit;
