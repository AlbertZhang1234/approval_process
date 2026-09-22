import type { Sql } from "postgres";
import type { ApprovalRpcClient, ApprovalRpcFunction } from "../rpc/rpc-client.js";

const ALLOWED_FUNCTIONS: ReadonlySet<ApprovalRpcFunction> = new Set([
  "claim_outbox_events",
  "create_workflow_definition",
  "find_idempotent_result",
  "get_instance",
  "get_published_workflow",
  "get_task",
  "get_workflow_definition",
  "get_workflow_definition_by_key",
  "get_workflow_draft",
  "list_tasks",
  "list_workflow_versions",
  "mark_outbox_event_failed",
  "mark_outbox_event_processed",
  "persist_instance_change",
  "persist_new_instance",
  "publish_workflow_draft",
  "save_workflow_draft",
  "set_workflow_definition_status",
]);

export class PostgresRpcClient implements ApprovalRpcClient {
  public constructor(private readonly sql: Sql) {}

  public async call(
    functionName: ApprovalRpcFunction,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    if (!ALLOWED_FUNCTIONS.has(functionName)) throw new Error("Unsupported approval database function");
    const rows = await this.sql.unsafe(
      `select approval_api.${functionName}($1::jsonb) as result`,
      [JSON.stringify(input)],
    );
    return rows[0]?.["result"] ?? null;
  }
}
