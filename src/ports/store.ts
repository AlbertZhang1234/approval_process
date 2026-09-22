import type { WorkflowDefinition } from "../contracts/workflow.js";
import type { ApprovalInstance, ApprovalInstanceStatus, ApprovalTask, DomainEvent } from "../domain/model.js";

export interface IdempotentApprovalResult {
  readonly fingerprint: string;
  readonly instance: ApprovalInstance;
}

export interface TaskListCursor {
  readonly createdAt: string;
  readonly id: string;
}

export type TaskListOrderBy = "CREATED_DESC" | "CREATED_ASC";

export interface TaskListQuery {
  readonly assigneeId: string;
  readonly status?: ApprovalTask["status"];
  readonly businessType?: string;
  readonly limit?: number;
  readonly cursor?: TaskListCursor;
  readonly orderBy?: TaskListOrderBy;
}

export interface TaskListResult {
  readonly tasks: readonly ApprovalTask[];
  readonly nextCursor?: TaskListCursor;
}

export type InstanceBusinessStatusFilter = ApprovalInstanceStatus | readonly ApprovalInstanceStatus[];

export interface ApprovalStore {
  getPublishedWorkflow(key: string): Promise<WorkflowDefinition | undefined>;
  getInstance(instanceId: string): Promise<ApprovalInstance | undefined>;
  getInstanceByBusiness(
    businessType: string,
    businessId: string,
    status?: InstanceBusinessStatusFilter,
  ): Promise<ApprovalInstance | undefined>;
  getTask(taskId: string): Promise<ApprovalTask | undefined>;
  findIdempotentResult(idempotencyKey: string): Promise<IdempotentApprovalResult | undefined>;
  listTasks(query: TaskListQuery): Promise<TaskListResult>;

  saveNew(
    instance: ApprovalInstance,
    idempotencyKey: string,
    fingerprint: string,
    events: readonly DomainEvent[],
  ): Promise<ApprovalInstance>;

  save(
    instance: ApprovalInstance,
    expectedVersion: number,
    idempotencyKey: string,
    fingerprint: string,
    events: readonly DomainEvent[],
    operationType?: string,
  ): Promise<ApprovalInstance>;
}
