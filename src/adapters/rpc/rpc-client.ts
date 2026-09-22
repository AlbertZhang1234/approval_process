import { ApprovalError } from "../../domain/errors.js";

export type ApprovalRpcFunction =
  | "create_workflow_definition"
  | "claim_outbox_events"
  | "find_idempotent_result"
  | "get_instance"
  | "get_instance_by_business"
  | "get_published_workflow"
  | "get_task"
  | "get_workflow_definition"
  | "get_workflow_definition_by_key"
  | "get_workflow_draft"
  | "list_tasks"
  | "list_dead_outbox_events"
  | "list_workflow_versions"
  | "persist_instance_change"
  | "persist_new_instance"
  | "publish_workflow_draft"
  | "save_workflow_draft"
  | "mark_outbox_event_failed"
  | "mark_outbox_event_dead"
  | "mark_outbox_event_processed"
  | "reset_dead_outbox_event"
  | "set_workflow_definition_status";

export interface ApprovalRpcClient {
  call(functionName: ApprovalRpcFunction, input: Readonly<Record<string, unknown>>): Promise<unknown>;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "";
}

export function mapRpcError(error: unknown): ApprovalError {
  if (error instanceof ApprovalError) return error;
  const message = errorMessage(error);
  if (message.includes("APPROVAL:IDEMPOTENCY_CONFLICT")) {
    return new ApprovalError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different command", error);
  }
  if (message.includes("APPROVAL:INVALID_COMMAND")) {
    return new ApprovalError("INVALID_COMMAND", "Approval persistence input is invalid", error);
  }
  if (message.includes("APPROVAL:VERSION_CONFLICT")) {
    return new ApprovalError("VERSION_CONFLICT", "Approval data was modified concurrently", error);
  }
  if (message.includes("APPROVAL:WORKFLOW_NOT_FOUND")) {
    return new ApprovalError("WORKFLOW_NOT_FOUND", "Workflow definition was not found", error);
  }
  if (message.includes("APPROVAL:INSTANCE_NOT_FOUND")) {
    return new ApprovalError("INSTANCE_NOT_FOUND", "Approval instance was not found", error);
  }
  if (message.includes("APPROVAL:DRAFT_ALREADY_PUBLISHED")) {
    return new ApprovalError("DRAFT_ALREADY_PUBLISHED", "Workflow draft has already been published", error);
  }
  if (message.includes("APPROVAL:OUTBOX_LOCK_CONFLICT")) {
    return new ApprovalError("OUTBOX_LOCK_CONFLICT", "Outbox event is not owned by this worker", error);
  }
  if (message.includes("APPROVAL:OUTBOX_EVENT_NOT_FOUND")) {
    return new ApprovalError("OUTBOX_EVENT_NOT_FOUND", "Outbox event was not found", error);
  }
  throw new ApprovalError("PERSISTENCE_ERROR", "Approval persistence operation failed", error);
}
