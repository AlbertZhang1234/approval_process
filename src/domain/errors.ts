export type ApprovalErrorCode =
  | "INVALID_COMMAND"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_WORKFLOW"
  | "WORKFLOW_NOT_FOUND"
  | "INSTANCE_NOT_FOUND"
  | "TASK_NOT_FOUND"
  | "TASK_NOT_PENDING"
  | "FORBIDDEN_TASK_ACTION"
  | "FORBIDDEN_INSTANCE_ACTION"
  | "INVALID_INSTANCE_STATE"
  | "INVALID_RETURN_TARGET"
  | "WITHDRAW_NOT_ALLOWED"
  | "ASSIGNEE_NOT_FOUND"
  | "PERSISTENCE_ERROR"
  | "DRAFT_ALREADY_PUBLISHED"
  | "OUTBOX_LOCK_CONFLICT"
  | "OUTBOX_EVENT_NOT_FOUND"
  | "VERSION_CONFLICT";

export class ApprovalError extends Error {
  public constructor(
    public readonly code: ApprovalErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ApprovalError";
  }
}
