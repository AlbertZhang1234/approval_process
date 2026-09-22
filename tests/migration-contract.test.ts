import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("initial migration contains the private tables and every adapter RPC", async () => {
  const sql = await readFile(
    resolve(process.cwd(), "supabase/migrations/20260910000100_initial_approval_schema.sql"),
    "utf8",
  );
  for (const table of [
    "workflow_definitions",
    "workflow_drafts",
    "workflow_versions",
    "workflow_instances",
    "node_executions",
    "approval_tasks",
    "transition_history",
    "approval_actions",
    "idempotency_records",
    "outbox_events",
  ]) {
    assert.match(sql, new RegExp(`create table approval\\.${table}\\b`));
  }
  for (const rpc of [
    "create_workflow_definition",
    "save_workflow_draft",
    "publish_workflow_draft",
    "persist_new_instance",
    "persist_instance_change",
    "claim_outbox_events",
    "mark_outbox_event_processed",
    "mark_outbox_event_failed",
  ]) {
    assert.match(sql, new RegExp(`function approval_api\\.${rpc}\\b`));
  }
  assert.match(sql, /security definer/);
  assert.match(sql, /revoke all on all tables in schema approval from public, anon, authenticated/);
  assert.match(sql, /grant execute on all functions in schema approval_api to service_role/);
  assert.match(sql, /^begin;[\s\S]*commit;\s*$/);
});

test("return lifecycle migration adds new RPCs and widens audit constraints", async () => {
  const sql = await readFile(
    resolve(process.cwd(), "supabase/migrations/20260921000100_return_lifecycle_and_outbox_hardening.sql"),
    "utf8",
  );
  for (const rpc of [
    "get_instance_by_business",
    "list_tasks",
    "persist_instance_change",
    "mark_outbox_event_dead",
    "list_dead_outbox_events",
    "reset_dead_outbox_event",
  ]) {
    assert.match(sql, new RegExp(`function approval_api\\.${rpc}\\b`));
  }
  assert.match(sql, /check \(transition_type in \('FORWARD', 'RETURN', 'RESUBMIT'\)\)/);
  assert.match(sql, /check \(action_type in \('APPROVE', 'REJECT', 'REJECT_TO_APPLICANT', 'RETURN_TO_NODE'\)\)/);
  assert.match(sql, /check \(status in \('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD'\)\)/);
  assert.match(sql, /add column if not exists dead_lettered_at timestamptz/);
  assert.match(sql, /revoke all on all functions in schema approval_api from public, anon, authenticated/);
  assert.match(sql, /grant execute on all functions in schema approval_api to service_role/);
  assert.match(sql, /^begin;[\s\S]*commit;\s*$/);
});
