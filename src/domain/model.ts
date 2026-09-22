import type {
  ApprovalMode,
  BusinessReference,
  WorkflowDefinition,
} from "../contracts/workflow.js";

export type ApprovalInstanceStatus =
  | "RUNNING"
  | "APPROVED"
  | "REJECTED"
  | "CANCELED"
  | "WITHDRAWN";

export type NodeExecutionStatus = "ACTIVE" | "COMPLETED" | "CANCELED";
export type ApprovalTaskStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELED";
export type ApprovalActionType = "APPROVE" | "REJECT" | "REJECT_TO_APPLICANT" | "RETURN_TO_NODE";
export type TransitionType = "FORWARD" | "RETURN" | "RESUBMIT";

export interface NodeExecution {
  readonly id: string;
  readonly nodeId: string;
  readonly round: number;
  readonly previousExecutionId?: string;
  status: NodeExecutionStatus;
  result?: "PASSED" | "REJECTED" | "SKIPPED";
  readonly enteredAt: string;
  leftAt?: string;
}

export interface ApprovalTask {
  readonly id: string;
  readonly instanceId: string;
  readonly executionId: string;
  readonly nodeId: string;
  readonly assigneeId: string;
  status: ApprovalTaskStatus;
  readonly createdAt: string;
  completedAt?: string;
  comment?: string;
}

export interface TransitionRecord {
  readonly id: string;
  readonly fromExecutionId?: string;
  readonly toExecutionId: string;
  readonly type: TransitionType;
  readonly occurredAt: string;
}

export interface ApprovalInstance {
  readonly id: string;
  readonly definitionKey: string;
  readonly definitionVersion: number;
  readonly definition: WorkflowDefinition;
  readonly business: BusinessReference;
  readonly applicantId: string;
  context: Readonly<Record<string, unknown>>;
  contextRevision: number;
  status: ApprovalInstanceStatus;
  currentExecutionId?: string;
  readonly executions: NodeExecution[];
  readonly tasks: ApprovalTask[];
  readonly transitions: TransitionRecord[];
  readonly createdAt: string;
  updatedAt: string;
  version: number;
}

export interface TaskCreatedEventData {
  readonly taskId: string;
  readonly assigneeId: string;
  readonly nodeId: string;
}

export interface DomainEvent {
  readonly id: string;
  readonly type:
    | "approval.instance.started"
    | "approval.task.created"
    | "approval.task.completed"
    | "approval.instance.approved"
    | "approval.instance.rejected"
    | "approval.instance.returned"
    | "approval.instance.resubmitted"
    | "approval.instance.withdrawn"
    | "approval.instance.canceled";
  readonly instanceId: string;
  readonly business: BusinessReference;
  readonly occurredAt: string;
  readonly data: Readonly<Record<string, unknown>> | TaskCreatedEventData;
}

export interface ApprovalNodeRuntime {
  readonly mode: ApprovalMode;
  readonly execution: NodeExecution;
  readonly tasks: readonly ApprovalTask[];
}
