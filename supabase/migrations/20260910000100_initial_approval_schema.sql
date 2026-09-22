begin;

create schema if not exists approval;
create schema if not exists approval_api;

revoke all on schema approval from public, anon, authenticated;
revoke all on schema approval_api from public, anon, authenticated;

create table approval.workflow_definitions (
  id text primary key,
  definition_key varchar(64) not null unique,
  name varchar(100) not null,
  description varchar(500),
  status varchar(16) not null default 'ACTIVE'
    check (status in ('ACTIVE', 'DISABLED')),
  current_version_id text,
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (definition_key ~ '^[a-z][a-z0-9-]{2,63}$')
);

create table approval.workflow_drafts (
  definition_id text primary key
    references approval.workflow_definitions(id) on delete cascade,
  content jsonb not null default '{"nodes":[],"edges":[]}'::jsonb,
  revision bigint not null default 0 check (revision >= 0),
  published_revision bigint check (published_revision is null or published_revision >= 0),
  updated_by text not null,
  updated_at timestamptz not null,
  check (jsonb_typeof(content) = 'object'),
  check (jsonb_typeof(content -> 'nodes') = 'array'),
  check (jsonb_typeof(content -> 'edges') = 'array')
);

create table approval.workflow_versions (
  id text primary key,
  definition_id text not null
    references approval.workflow_definitions(id) on delete restrict,
  version integer not null check (version > 0),
  schema_version integer not null default 1 check (schema_version > 0),
  content jsonb not null,
  content_hash varchar(64) not null,
  published_by text not null,
  published_at timestamptz not null,
  unique (definition_id, version),
  check (jsonb_typeof(content) = 'object'),
  check (content_hash ~ '^[0-9a-f]{64}$')
);

alter table approval.workflow_definitions
  add constraint workflow_definitions_current_version_fk
  foreign key (current_version_id)
  references approval.workflow_versions(id)
  on delete restrict
  deferrable initially deferred;

create table approval.workflow_instances (
  id text primary key,
  workflow_version_id text not null
    references approval.workflow_versions(id) on delete restrict,
  definition_key varchar(64) not null,
  definition_version integer not null check (definition_version > 0),
  definition_snapshot jsonb not null,
  business_type varchar(100) not null,
  business_id varchar(200) not null,
  business_url varchar(2000),
  applicant_id text not null,
  context jsonb not null,
  context_revision integer not null default 1 check (context_revision > 0),
  status varchar(16) not null
    check (status in ('RUNNING', 'APPROVED', 'REJECTED', 'CANCELED', 'WITHDRAWN')),
  current_execution_id text,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (jsonb_typeof(definition_snapshot) = 'object'),
  check (jsonb_typeof(context) = 'object')
);

create index workflow_instances_business_idx
  on approval.workflow_instances (business_type, business_id, created_at desc);
create index workflow_instances_applicant_idx
  on approval.workflow_instances (applicant_id, created_at desc);
create index workflow_instances_status_idx
  on approval.workflow_instances (status, updated_at desc);

create table approval.node_executions (
  id text primary key,
  instance_id text not null
    references approval.workflow_instances(id) on delete cascade,
  node_id varchar(64) not null,
  round integer not null check (round > 0),
  previous_execution_id text
    references approval.node_executions(id) on delete restrict,
  status varchar(16) not null
    check (status in ('ACTIVE', 'COMPLETED', 'CANCELED')),
  result varchar(16)
    check (result is null or result in ('PASSED', 'REJECTED', 'SKIPPED')),
  entered_at timestamptz not null,
  left_at timestamptz,
  unique (instance_id, node_id, round),
  check ((status = 'ACTIVE' and left_at is null) or status <> 'ACTIVE')
);

alter table approval.workflow_instances
  add constraint workflow_instances_current_execution_fk
  foreign key (current_execution_id)
  references approval.node_executions(id)
  on delete restrict
  deferrable initially deferred;

create index node_executions_instance_idx
  on approval.node_executions (instance_id, entered_at, id);

create table approval.approval_tasks (
  id text primary key,
  instance_id text not null
    references approval.workflow_instances(id) on delete cascade,
  execution_id text not null
    references approval.node_executions(id) on delete cascade,
  node_id varchar(64) not null,
  assignee_id text not null,
  status varchar(16) not null
    check (status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELED')),
  created_at timestamptz not null,
  completed_at timestamptz,
  comment text,
  check ((status = 'PENDING' and completed_at is null) or status <> 'PENDING')
);

create index approval_tasks_assignee_status_idx
  on approval.approval_tasks (assignee_id, status, created_at desc);
create index approval_tasks_instance_idx
  on approval.approval_tasks (instance_id, created_at, id);
create index approval_tasks_execution_idx
  on approval.approval_tasks (execution_id);

create table approval.transition_history (
  id text primary key,
  instance_id text not null
    references approval.workflow_instances(id) on delete cascade,
  from_execution_id text
    references approval.node_executions(id) on delete restrict,
  to_execution_id text not null
    references approval.node_executions(id) on delete restrict,
  transition_type varchar(24) not null
    check (transition_type in ('FORWARD')),
  occurred_at timestamptz not null
);

create index transition_history_instance_idx
  on approval.transition_history (instance_id, occurred_at, id);

create table approval.approval_actions (
  id text primary key,
  instance_id text not null
    references approval.workflow_instances(id) on delete cascade,
  execution_id text not null
    references approval.node_executions(id) on delete restrict,
  task_id text not null
    references approval.approval_tasks(id) on delete restrict,
  node_id varchar(64) not null,
  operator_id text not null,
  action_type varchar(24) not null
    check (action_type in ('APPROVE', 'REJECT')),
  comment text,
  occurred_at timestamptz not null
);

create index approval_actions_instance_idx
  on approval.approval_actions (instance_id, occurred_at, id);

create table approval.idempotency_records (
  idempotency_key varchar(300) primary key,
  fingerprint varchar(64) not null,
  operation_type varchar(32) not null,
  instance_id text not null
    references approval.workflow_instances(id) on delete cascade,
  created_at timestamptz not null,
  check (fingerprint ~ '^[0-9a-f]{64}$')
);

create table approval.outbox_events (
  id text primary key,
  event_type varchar(100) not null,
  instance_id text not null
    references approval.workflow_instances(id) on delete cascade,
  payload jsonb not null,
  status varchar(16) not null default 'PENDING'
    check (status in ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null,
  locked_at timestamptz,
  locked_by text,
  processed_at timestamptz,
  last_error text,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(payload) = 'object')
);

create index outbox_events_pending_idx
  on approval.outbox_events (available_at, occurred_at, id)
  where status in ('PENDING', 'FAILED');

create or replace function approval.workflow_definition_json(p_definition approval.workflow_definitions)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', p_definition.id,
    'key', p_definition.definition_key,
    'name', p_definition.name,
    'description', p_definition.description,
    'status', p_definition.status,
    'currentVersion', (
      select v.version
      from approval.workflow_versions v
      where v.id = p_definition.current_version_id
    ),
    'createdBy', p_definition.created_by,
    'createdAt', p_definition.created_at,
    'updatedAt', p_definition.updated_at
  ));
$$;

create or replace function approval.workflow_draft_json(p_draft approval.workflow_drafts)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'definitionId', p_draft.definition_id,
    'content', p_draft.content,
    'revision', p_draft.revision,
    'publishedRevision', p_draft.published_revision,
    'updatedBy', p_draft.updated_by,
    'updatedAt', p_draft.updated_at
  );
$$;

create or replace function approval.workflow_version_json(p_version approval.workflow_versions)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_version.id,
    'definitionId', p_version.definition_id,
    'version', p_version.version,
    'schemaVersion', p_version.schema_version,
    'content', p_version.content,
    'contentHash', p_version.content_hash,
    'publishedBy', p_version.published_by,
    'publishedAt', p_version.published_at
  );
$$;

create or replace function approval.task_json(p_task approval.approval_tasks)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', p_task.id,
    'instanceId', p_task.instance_id,
    'executionId', p_task.execution_id,
    'nodeId', p_task.node_id,
    'assigneeId', p_task.assignee_id,
    'status', p_task.status,
    'createdAt', p_task.created_at,
    'completedAt', p_task.completed_at,
    'comment', p_task.comment
  ));
$$;

create or replace function approval.instance_json(p_instance_id text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', i.id,
    'definitionKey', i.definition_key,
    'definitionVersion', i.definition_version,
    'definition', i.definition_snapshot,
    'business', jsonb_strip_nulls(jsonb_build_object(
      'type', i.business_type,
      'id', i.business_id,
      'url', i.business_url
    )),
    'applicantId', i.applicant_id,
    'context', i.context,
    'contextRevision', i.context_revision,
    'status', i.status,
    'currentExecutionId', i.current_execution_id,
    'executions', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id', e.id,
        'nodeId', e.node_id,
        'round', e.round,
        'previousExecutionId', e.previous_execution_id,
        'status', e.status,
        'result', e.result,
        'enteredAt', e.entered_at,
        'leftAt', e.left_at
      )) order by e.entered_at, e.id)
      from approval.node_executions e
      where e.instance_id = i.id
    ), '[]'::jsonb),
    'tasks', coalesce((
      select jsonb_agg(approval.task_json(t) order by t.created_at, t.id)
      from approval.approval_tasks t
      where t.instance_id = i.id
    ), '[]'::jsonb),
    'transitions', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id', h.id,
        'fromExecutionId', h.from_execution_id,
        'toExecutionId', h.to_execution_id,
        'type', h.transition_type,
        'occurredAt', h.occurred_at
      )) order by h.occurred_at, h.id)
      from approval.transition_history h
      where h.instance_id = i.id
    ), '[]'::jsonb),
    'createdAt', i.created_at,
    'updatedAt', i.updated_at,
    'version', i.version
  ))
  from approval.workflow_instances i
  where i.id = p_instance_id;
$$;

create or replace function approval.persist_instance_children(p_instance jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  item jsonb;
begin
  for item in select value from jsonb_array_elements(coalesce(p_instance -> 'executions', '[]'::jsonb))
  loop
    insert into approval.node_executions (
      id, instance_id, node_id, round, previous_execution_id,
      status, result, entered_at, left_at
    ) values (
      item ->> 'id', p_instance ->> 'id', item ->> 'nodeId',
      (item ->> 'round')::integer, item ->> 'previousExecutionId',
      item ->> 'status', item ->> 'result',
      (item ->> 'enteredAt')::timestamptz,
      nullif(item ->> 'leftAt', '')::timestamptz
    )
    on conflict (id) do update set
      status = excluded.status,
      result = excluded.result,
      left_at = excluded.left_at;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_instance -> 'tasks', '[]'::jsonb))
  loop
    insert into approval.approval_tasks (
      id, instance_id, execution_id, node_id, assignee_id,
      status, created_at, completed_at, comment
    ) values (
      item ->> 'id', p_instance ->> 'id', item ->> 'executionId',
      item ->> 'nodeId', item ->> 'assigneeId', item ->> 'status',
      (item ->> 'createdAt')::timestamptz,
      nullif(item ->> 'completedAt', '')::timestamptz,
      item ->> 'comment'
    )
    on conflict (id) do update set
      status = excluded.status,
      completed_at = excluded.completed_at,
      comment = excluded.comment;
  end loop;

  for item in select value from jsonb_array_elements(coalesce(p_instance -> 'transitions', '[]'::jsonb))
  loop
    insert into approval.transition_history (
      id, instance_id, from_execution_id, to_execution_id,
      transition_type, occurred_at
    ) values (
      item ->> 'id', p_instance ->> 'id', item ->> 'fromExecutionId',
      item ->> 'toExecutionId', item ->> 'type',
      (item ->> 'occurredAt')::timestamptz
    )
    on conflict (id) do nothing;
  end loop;
end;
$$;

create or replace function approval.persist_events(p_instance_id text, p_events jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  item jsonb;
begin
  for item in select value from jsonb_array_elements(coalesce(p_events, '[]'::jsonb))
  loop
    insert into approval.outbox_events (
      id, event_type, instance_id, payload, available_at, occurred_at
    ) values (
      item ->> 'id', item ->> 'type', p_instance_id, item,
      (item ->> 'occurredAt')::timestamptz,
      (item ->> 'occurredAt')::timestamptz
    )
    on conflict (id) do nothing;

    if item ->> 'type' = 'approval.task.completed' then
      insert into approval.approval_actions (
        id, instance_id, execution_id, task_id, node_id,
        operator_id, action_type, comment, occurred_at
      )
      select
        item ->> 'id', p_instance_id, t.execution_id, t.id, t.node_id,
        item -> 'data' ->> 'operatorId', item -> 'data' ->> 'action',
        item -> 'data' ->> 'comment', (item ->> 'occurredAt')::timestamptz
      from approval.approval_tasks t
      where t.id = item -> 'data' ->> 'taskId'
      on conflict (id) do nothing;
    end if;
  end loop;
end;
$$;

create or replace function approval_api.create_workflow_definition(p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  definition approval.workflow_definitions;
begin
  insert into approval.workflow_definitions (
    id, definition_key, name, description, status,
    created_by, updated_by, created_at, updated_at
  ) values (
    p_input ->> 'id', p_input ->> 'key', p_input ->> 'name',
    p_input ->> 'description', 'ACTIVE', p_input ->> 'createdBy',
    p_input ->> 'createdBy', (p_input ->> 'occurredAt')::timestamptz,
    (p_input ->> 'occurredAt')::timestamptz
  ) returning * into definition;

  insert into approval.workflow_drafts (
    definition_id, content, revision, updated_by, updated_at
  ) values (
    definition.id, '{"nodes":[],"edges":[]}'::jsonb, 0,
    p_input ->> 'createdBy', (p_input ->> 'occurredAt')::timestamptz
  );

  return approval.workflow_definition_json(definition);
end;
$$;

create or replace function approval_api.get_workflow_definition(p_input jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select approval.workflow_definition_json(d)
  from approval.workflow_definitions d
  where d.id = p_input ->> 'definitionId';
$$;

create or replace function approval_api.get_workflow_definition_by_key(p_input jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select approval.workflow_definition_json(d)
  from approval.workflow_definitions d
  where d.definition_key = p_input ->> 'key';
$$;

create or replace function approval_api.get_workflow_draft(p_input jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select approval.workflow_draft_json(d)
  from approval.workflow_drafts d
  where d.definition_id = p_input ->> 'definitionId';
$$;

create or replace function approval_api.save_workflow_draft(p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  draft approval.workflow_drafts;
begin
  update approval.workflow_drafts
  set content = p_input -> 'content',
      revision = revision + 1,
      updated_by = p_input ->> 'updatedBy',
      updated_at = (p_input ->> 'occurredAt')::timestamptz
  where definition_id = p_input ->> 'definitionId'
    and revision = (p_input ->> 'expectedRevision')::bigint
  returning * into draft;

  if not found then
    raise exception 'APPROVAL:VERSION_CONFLICT';
  end if;
  return approval.workflow_draft_json(draft);
end;
$$;

create or replace function approval_api.publish_workflow_draft(p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  definition approval.workflow_definitions;
  draft approval.workflow_drafts;
  published approval.workflow_versions;
  next_version integer;
  version_content jsonb;
begin
  select * into definition
  from approval.workflow_definitions
  where id = p_input ->> 'definitionId'
  for update;
  if not found then raise exception 'APPROVAL:WORKFLOW_NOT_FOUND'; end if;

  select * into draft
  from approval.workflow_drafts
  where definition_id = definition.id
  for update;
  if draft.revision <> (p_input ->> 'expectedRevision')::bigint then
    raise exception 'APPROVAL:VERSION_CONFLICT';
  end if;
  if draft.published_revision = draft.revision then
    raise exception 'APPROVAL:DRAFT_ALREADY_PUBLISHED';
  end if;

  select coalesce(max(v.version), 0) + 1 into next_version
  from approval.workflow_versions v
  where v.definition_id = definition.id;

  version_content := jsonb_strip_nulls(jsonb_build_object(
    'key', definition.definition_key,
    'name', definition.name,
    'version', next_version,
    'description', definition.description,
    'nodes', draft.content -> 'nodes',
    'edges', draft.content -> 'edges'
  ));

  insert into approval.workflow_versions (
    id, definition_id, version, schema_version, content,
    content_hash, published_by, published_at
  ) values (
    p_input ->> 'versionId', definition.id, next_version, 1,
    version_content, encode(sha256(convert_to(version_content::text, 'UTF8')), 'hex'),
    p_input ->> 'publishedBy', (p_input ->> 'occurredAt')::timestamptz
  ) returning * into published;

  update approval.workflow_definitions
  set current_version_id = published.id,
      updated_by = p_input ->> 'publishedBy',
      updated_at = (p_input ->> 'occurredAt')::timestamptz
  where id = definition.id;

  update approval.workflow_drafts
  set published_revision = draft.revision
  where definition_id = definition.id;

  return approval.workflow_version_json(published);
end;
$$;

create or replace function approval_api.list_workflow_versions(p_input jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(approval.workflow_version_json(v) order by v.version desc), '[]'::jsonb)
  from approval.workflow_versions v
  where v.definition_id = p_input ->> 'definitionId';
$$;

create or replace function approval_api.set_workflow_definition_status(p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  definition approval.workflow_definitions;
begin
  update approval.workflow_definitions
  set status = p_input ->> 'status',
      updated_by = p_input ->> 'updatedBy',
      updated_at = (p_input ->> 'occurredAt')::timestamptz
  where id = p_input ->> 'definitionId'
  returning * into definition;
  if not found then raise exception 'APPROVAL:WORKFLOW_NOT_FOUND'; end if;
  return approval.workflow_definition_json(definition);
end;
$$;

create or replace function approval_api.get_published_workflow(p_input jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select approval.workflow_version_json(v)
  from approval.workflow_definitions d
  join approval.workflow_versions v on v.id = d.current_version_id
  where d.definition_key = p_input ->> 'key'
    and d.status = 'ACTIVE';
$$;

create or replace function approval_api.get_instance(p_input jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select approval.instance_json(p_input ->> 'instanceId');
$$;

create or replace function approval_api.get_task(p_input jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select approval.task_json(t)
  from approval.approval_tasks t
  where t.id = p_input ->> 'taskId';
$$;

create or replace function approval_api.list_tasks(p_input jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(approval.task_json(t) order by t.created_at desc, t.id), '[]'::jsonb)
  from approval.approval_tasks t
  where t.assignee_id = p_input ->> 'assigneeId'
    and ((p_input ->> 'status') is null or t.status = p_input ->> 'status');
$$;

create or replace function approval_api.find_idempotent_result(p_input jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'fingerprint', r.fingerprint,
    'instance', approval.instance_json(r.instance_id)
  )
  from approval.idempotency_records r
  where r.idempotency_key = p_input ->> 'idempotencyKey';
$$;

create or replace function approval_api.persist_new_instance(p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  instance jsonb := p_input -> 'instance';
  existing approval.idempotency_records;
  workflow_version approval.workflow_versions;
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

  select v.* into workflow_version
  from approval.workflow_versions v
  join approval.workflow_definitions d on d.id = v.definition_id
  where d.definition_key = instance ->> 'definitionKey'
    and v.version = (instance ->> 'definitionVersion')::integer
    and d.status = 'ACTIVE';
  if not found then raise exception 'APPROVAL:WORKFLOW_NOT_FOUND'; end if;

  insert into approval.workflow_instances (
    id, workflow_version_id, definition_key, definition_version,
    definition_snapshot, business_type, business_id, business_url,
    applicant_id, context, context_revision, status,
    current_execution_id, version, created_at, updated_at
  ) values (
    instance ->> 'id', workflow_version.id, instance ->> 'definitionKey',
    (instance ->> 'definitionVersion')::integer, instance -> 'definition',
    instance -> 'business' ->> 'type', instance -> 'business' ->> 'id',
    instance -> 'business' ->> 'url', instance ->> 'applicantId',
    instance -> 'context', (instance ->> 'contextRevision')::integer,
    instance ->> 'status', null, 1,
    (instance ->> 'createdAt')::timestamptz,
    (instance ->> 'updatedAt')::timestamptz
  );

  perform approval.persist_instance_children(instance);
  update approval.workflow_instances
  set current_execution_id = instance ->> 'currentExecutionId'
  where id = instance ->> 'id';
  perform approval.persist_events(instance ->> 'id', p_input -> 'events');

  insert into approval.idempotency_records (
    idempotency_key, fingerprint, operation_type, instance_id, created_at
  ) values (
    p_input ->> 'idempotencyKey', p_input ->> 'fingerprint', 'START',
    instance ->> 'id', now()
  );
  return approval.instance_json(instance ->> 'id');
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
    p_input ->> 'idempotencyKey', p_input ->> 'fingerprint', 'ACT', changed_id, now()
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

create or replace function approval_api.claim_outbox_events(p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed jsonb;
begin
  if (p_input ->> 'limit')::integer not between 1 and 100 then
    raise exception 'APPROVAL:INVALID_COMMAND';
  end if;
  if (p_input ->> 'leaseSeconds')::integer not between 1 and 3600 then
    raise exception 'APPROVAL:INVALID_COMMAND';
  end if;

  with candidates as (
    select e.id
    from approval.outbox_events e
    where (
      e.status in ('PENDING', 'FAILED')
      and e.available_at <= (p_input ->> 'occurredAt')::timestamptz
    ) or (
      e.status = 'PROCESSING'
      and e.locked_at <= (p_input ->> 'occurredAt')::timestamptz
        - make_interval(secs => (p_input ->> 'leaseSeconds')::integer)
    )
    order by e.available_at, e.occurred_at, e.id
    for update skip locked
    limit (p_input ->> 'limit')::integer
  ), updated as (
    update approval.outbox_events e
    set status = 'PROCESSING',
        attempts = e.attempts + 1,
        locked_at = (p_input ->> 'occurredAt')::timestamptz,
        locked_by = p_input ->> 'workerId',
        last_error = null
    from candidates c
    where e.id = c.id
    returning e.*
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object('event', u.payload, 'attempts', u.attempts)
      order by u.available_at, u.occurred_at, u.id
    ),
    '[]'::jsonb
  ) into claimed
  from updated u;

  return claimed;
end;
$$;

create or replace function approval_api.mark_outbox_event_processed(p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  update approval.outbox_events
  set status = 'PROCESSED',
      processed_at = (p_input ->> 'occurredAt')::timestamptz,
      locked_at = null,
      locked_by = null
  where id = p_input ->> 'eventId'
    and status = 'PROCESSING'
    and locked_by = p_input ->> 'workerId';
  if not found then raise exception 'APPROVAL:OUTBOX_LOCK_CONFLICT'; end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function approval_api.mark_outbox_event_failed(p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  update approval.outbox_events
  set status = 'FAILED',
      available_at = (p_input ->> 'retryAt')::timestamptz,
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

alter table approval.workflow_definitions enable row level security;
alter table approval.workflow_drafts enable row level security;
alter table approval.workflow_versions enable row level security;
alter table approval.workflow_instances enable row level security;
alter table approval.node_executions enable row level security;
alter table approval.approval_tasks enable row level security;
alter table approval.transition_history enable row level security;
alter table approval.approval_actions enable row level security;
alter table approval.idempotency_records enable row level security;
alter table approval.outbox_events enable row level security;

revoke all on all tables in schema approval from public, anon, authenticated;
revoke all on all functions in schema approval from public, anon, authenticated;
revoke all on all functions in schema approval_api from public, anon, authenticated;

grant usage on schema approval_api to service_role;
grant execute on all functions in schema approval_api to service_role;

commit;
