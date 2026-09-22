import type { WorkflowDefinition } from "../../contracts/workflow.js";
import { ApprovalError } from "../../domain/errors.js";
import type { ApprovalInstance, ApprovalTask, DomainEvent } from "../../domain/model.js";
import type { ApprovalStore, IdempotentApprovalResult } from "../../ports/store.js";
import type {
  DeadLetterOutboxEventInput,
  DeadOutboxEvent,
  ClaimedOutboxEvent,
  ClaimOutboxEventsInput,
  CompleteOutboxEventInput,
  FailOutboxEventInput,
  OutboxStore,
  ResetDeadOutboxEventInput,
} from "../../ports/outbox-store.js";
import type { InstanceBusinessStatusFilter, TaskListQuery, TaskListResult } from "../../ports/store.js";
import type {
  CreateWorkflowDefinitionRecord,
  PublishWorkflowDraftRecord,
  SaveWorkflowDraftRecord,
  WorkflowManagementStore,
} from "../../ports/workflow-management-store.js";
import type {
  WorkflowDefinitionRecord,
  WorkflowDefinitionStatus,
  WorkflowDraftRecord,
  WorkflowVersionRecord,
} from "../../workflow-management/model.js";
import {
  parseApprovalInstance,
  parseApprovalTask,
  parseDeadOutboxEvents,
  parseDomainEvent,
  parseTaskListResult,
} from "./approval-codec.js";
import { readArray, readInteger, readRecord, readString } from "./json-reader.js";
import type { ApprovalRpcClient, ApprovalRpcFunction } from "./rpc-client.js";
import { mapRpcError } from "./rpc-client.js";
import {
  parseWorkflowDraft,
  parseWorkflowRecord,
  parseWorkflowVersion,
  parseWorkflowVersions,
} from "./workflow-codec.js";

function requireText(value: string, field: string): void {
  if (value.trim().length === 0) throw new ApprovalError("INVALID_COMMAND", `${field} is required`);
}

function requireTimestamp(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value))) throw new ApprovalError("INVALID_COMMAND", `${field} must be an ISO timestamp`);
}

export class RpcApprovalStore implements ApprovalStore, WorkflowManagementStore, OutboxStore {
  public constructor(private readonly client: ApprovalRpcClient) {}

  public async getPublishedWorkflow(key: string): Promise<WorkflowDefinition | undefined> {
    const value = await this.call("get_published_workflow", { key });
    if (value === null) return undefined;
    return parseWorkflowVersion(value).content;
  }

  public async getInstance(instanceId: string): Promise<ApprovalInstance | undefined> {
    const value = await this.call("get_instance", { instanceId });
    return value === null ? undefined : parseApprovalInstance(value);
  }

  public async getInstanceByBusiness(
    businessType: string,
    businessId: string,
    status?: InstanceBusinessStatusFilter,
  ): Promise<ApprovalInstance | undefined> {
    const value = await this.call("get_instance_by_business", {
      businessType,
      businessId,
      status: status === undefined ? null : Array.isArray(status) ? [...status] : [status],
    });
    return value === null ? undefined : parseApprovalInstance(value);
  }

  public async getTask(taskId: string): Promise<ApprovalTask | undefined> {
    const value = await this.call("get_task", { taskId });
    return value === null ? undefined : parseApprovalTask(value);
  }

  public async findIdempotentResult(idempotencyKey: string): Promise<IdempotentApprovalResult | undefined> {
    const value = await this.call("find_idempotent_result", { idempotencyKey });
    if (value === null) return undefined;
    const record = readRecord(value, "idempotentResult");
    return {
      fingerprint: readString(record["fingerprint"], "idempotentResult.fingerprint"),
      instance: parseApprovalInstance(record["instance"], "idempotentResult.instance"),
    };
  }

  public async listTasks(query: TaskListQuery): Promise<TaskListResult> {
    const value = await this.call("list_tasks", {
      assigneeId: query.assigneeId,
      status: query.status ?? null,
      businessType: query.businessType ?? null,
      limit: query.limit ?? 50,
      cursor: query.cursor === undefined ? null : { ...query.cursor },
      orderBy: query.orderBy ?? "CREATED_DESC",
    });
    return parseTaskListResult(value);
  }

  public async saveNew(
    instance: ApprovalInstance,
    idempotencyKey: string,
    fingerprint: string,
    events: readonly DomainEvent[],
  ): Promise<ApprovalInstance> {
    const value = await this.call("persist_new_instance", { instance, idempotencyKey, fingerprint, events });
    return parseApprovalInstance(value);
  }

  public async save(
    instance: ApprovalInstance,
    expectedVersion: number,
    idempotencyKey: string,
    fingerprint: string,
    events: readonly DomainEvent[],
    operationType?: string,
  ): Promise<ApprovalInstance> {
    const value = await this.call("persist_instance_change", {
      instance,
      expectedVersion,
      idempotencyKey,
      fingerprint,
      events,
      operationType: operationType ?? "ACT",
    });
    return parseApprovalInstance(value);
  }

  public async createDefinition(input: CreateWorkflowDefinitionRecord): Promise<WorkflowDefinitionRecord> {
    return parseWorkflowRecord(await this.call("create_workflow_definition", { ...input }));
  }

  public async getDefinition(definitionId: string): Promise<WorkflowDefinitionRecord | undefined> {
    const value = await this.call("get_workflow_definition", { definitionId });
    return value === null ? undefined : parseWorkflowRecord(value);
  }

  public async getDefinitionByKey(key: string): Promise<WorkflowDefinitionRecord | undefined> {
    const value = await this.call("get_workflow_definition_by_key", { key });
    return value === null ? undefined : parseWorkflowRecord(value);
  }

  public async getDraft(definitionId: string): Promise<WorkflowDraftRecord | undefined> {
    const value = await this.call("get_workflow_draft", { definitionId });
    return value === null ? undefined : parseWorkflowDraft(value);
  }

  public async saveDraft(input: SaveWorkflowDraftRecord): Promise<WorkflowDraftRecord> {
    return parseWorkflowDraft(await this.call("save_workflow_draft", { ...input }));
  }

  public async publishDraft(input: PublishWorkflowDraftRecord): Promise<WorkflowVersionRecord> {
    return parseWorkflowVersion(await this.call("publish_workflow_draft", { ...input }));
  }

  public async listVersions(definitionId: string): Promise<readonly WorkflowVersionRecord[]> {
    return parseWorkflowVersions(await this.call("list_workflow_versions", { definitionId }));
  }

  public async setDefinitionStatus(
    definitionId: string,
    status: WorkflowDefinitionStatus,
    updatedBy: string,
    occurredAt: string,
  ): Promise<WorkflowDefinitionRecord> {
    return parseWorkflowRecord(
      await this.call("set_workflow_definition_status", { definitionId, status, updatedBy, occurredAt }),
    );
  }

  public async claimOutboxEvents(input: ClaimOutboxEventsInput): Promise<readonly ClaimedOutboxEvent[]> {
    requireText(input.workerId, "workerId");
    requireTimestamp(input.occurredAt, "occurredAt");
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new ApprovalError("INVALID_COMMAND", "limit must be an integer between 1 and 100");
    }
    if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 1 || input.leaseSeconds > 3600) {
      throw new ApprovalError("INVALID_COMMAND", "leaseSeconds must be an integer between 1 and 3600");
    }
    const value = await this.call("claim_outbox_events", { ...input });
    return readArray(value, "outboxEvents").map((item, index) => {
      const record = readRecord(item, `outboxEvents[${index}]`);
      return {
        event: parseDomainEvent(record["event"], `outboxEvents[${index}].event`),
        attempts: readInteger(record["attempts"], `outboxEvents[${index}].attempts`),
      };
    });
  }

  public async markOutboxEventProcessed(input: CompleteOutboxEventInput): Promise<void> {
    requireText(input.eventId, "eventId");
    requireText(input.workerId, "workerId");
    requireTimestamp(input.occurredAt, "occurredAt");
    await this.call("mark_outbox_event_processed", { ...input });
  }

  public async markOutboxEventFailed(input: FailOutboxEventInput): Promise<void> {
    requireText(input.eventId, "eventId");
    requireText(input.workerId, "workerId");
    requireText(input.error, "error");
    requireTimestamp(input.retryAt, "retryAt");
    await this.call("mark_outbox_event_failed", { ...input });
  }

  public async markOutboxEventDead(input: DeadLetterOutboxEventInput): Promise<void> {
    requireText(input.eventId, "eventId");
    requireText(input.workerId, "workerId");
    requireTimestamp(input.occurredAt, "occurredAt");
    requireText(input.error, "error");
    await this.call("mark_outbox_event_dead", { ...input });
  }

  public async listDeadOutboxEvents(limit: number): Promise<readonly DeadOutboxEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ApprovalError("INVALID_COMMAND", "limit must be an integer between 1 and 100");
    }
    return parseDeadOutboxEvents(await this.call("list_dead_outbox_events", { limit }));
  }

  public async resetDeadOutboxEvent(input: ResetDeadOutboxEventInput): Promise<void> {
    requireText(input.eventId, "eventId");
    requireTimestamp(input.retryAt, "retryAt");
    await this.call("reset_dead_outbox_event", { ...input });
  }

  private async call(
    functionName: ApprovalRpcFunction,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    try {
      return await this.client.call(functionName, input);
    } catch (error) {
      throw mapRpcError(error);
    }
  }
}
