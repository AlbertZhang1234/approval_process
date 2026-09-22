import type { WorkflowDefinition } from "../../contracts/workflow.js";
import { commandFingerprint } from "../../application/command-fingerprint.js";
import { ApprovalError } from "../../domain/errors.js";
import { parseWorkflowDefinition } from "../../domain/workflow-validator.js";
import type { ApprovalInstance, ApprovalTask, DomainEvent } from "../../domain/model.js";
import type {
  ApprovalStore,
  IdempotentApprovalResult,
  InstanceBusinessStatusFilter,
  TaskListOrderBy,
  TaskListQuery,
  TaskListResult,
} from "../../ports/store.js";
import type {
  ClaimedOutboxEvent,
  ClaimOutboxEventsInput,
  CompleteOutboxEventInput,
  DeadLetterOutboxEventInput,
  DeadOutboxEvent,
  FailOutboxEventInput,
  OutboxStore,
  ResetDeadOutboxEventInput,
} from "../../ports/outbox-store.js";
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
import { InMemoryOutboxStore } from "./in-memory-outbox-store.js";

function copy<T>(value: T): T {
  return structuredClone(value);
}

function compareTasks(orderBy: TaskListOrderBy): (left: ApprovalTask, right: ApprovalTask) => number {
  const direction = orderBy === "CREATED_ASC" ? 1 : -1;
  return (left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt.localeCompare(right.createdAt) * direction;
    return left.id.localeCompare(right.id) * direction;
  };
}

export class InMemoryApprovalStore implements ApprovalStore, WorkflowManagementStore, OutboxStore {
  private readonly definitions = new Map<string, WorkflowDefinition>();
  private readonly definitionRecords = new Map<string, WorkflowDefinitionRecord>();
  private readonly drafts = new Map<string, WorkflowDraftRecord>();
  private readonly versions = new Map<string, WorkflowVersionRecord[]>();
  private readonly instances = new Map<string, ApprovalInstance>();
  private readonly idempotency = new Map<string, { readonly instanceId: string; readonly fingerprint: string }>();
  private readonly outbox = new InMemoryOutboxStore();

  public publish(definition: WorkflowDefinition): void {
    this.definitions.set(definition.key, copy(definition));
  }

  public async getPublishedWorkflow(key: string): Promise<WorkflowDefinition | undefined> {
    const managed = [...this.definitionRecords.values()].find((item) => item.key === key);
    if (managed?.status === "DISABLED") return undefined;
    const definition = this.definitions.get(key);
    return definition === undefined ? undefined : copy(definition);
  }

  public async getInstance(instanceId: string): Promise<ApprovalInstance | undefined> {
    const instance = this.instances.get(instanceId);
    return instance === undefined ? undefined : copy(instance);
  }

  public async getInstanceByBusiness(
    businessType: string,
    businessId: string,
    status?: InstanceBusinessStatusFilter,
  ): Promise<ApprovalInstance | undefined> {
    const statuses = status === undefined ? undefined : Array.isArray(status) ? [...status] : [status];
    const candidates = [...this.instances.values()]
      .filter(
        (instance) =>
          instance.business.type === businessType
          && instance.business.id === businessId
          && (statuses === undefined || statuses.includes(instance.status)),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    return candidates[0] === undefined ? undefined : copy(candidates[0]);
  }

  public async getTask(taskId: string): Promise<ApprovalTask | undefined> {
    const task = [...this.instances.values()]
      .flatMap((instance) => instance.tasks)
      .find((candidate) => candidate.id === taskId);
    return task === undefined ? undefined : copy(task);
  }

  public async findIdempotentResult(idempotencyKey: string): Promise<IdempotentApprovalResult | undefined> {
    const record = this.idempotency.get(idempotencyKey);
    if (record === undefined) return undefined;
    const instance = this.instances.get(record.instanceId);
    if (instance === undefined) return undefined;
    return { fingerprint: record.fingerprint, instance: copy(instance) };
  }

  public async listTasks(query: TaskListQuery): Promise<TaskListResult> {
    const limit = query.limit ?? 50;
    const orderBy = query.orderBy ?? "CREATED_DESC";
    const comparator = compareTasks(orderBy);
    let entries = [...this.instances.values()].flatMap((instance) =>
      instance.tasks.map((task) => ({ task, businessType: instance.business.type })),
    );
    entries = entries.filter(
      ({ task, businessType }) =>
        task.assigneeId === query.assigneeId
        && (query.status === undefined || task.status === query.status)
        && (query.businessType === undefined || businessType === query.businessType),
    );
    if (query.cursor !== undefined) {
      const cursor = query.cursor;
      entries = entries.filter(({ task }) => {
        const afterCursor =
          task.createdAt > cursor.createdAt || (task.createdAt === cursor.createdAt && task.id > cursor.id);
        const beforeCursor =
          task.createdAt < cursor.createdAt || (task.createdAt === cursor.createdAt && task.id < cursor.id);
        return orderBy === "CREATED_ASC" ? afterCursor : beforeCursor;
      });
    }
    entries.sort((left, right) => comparator(left.task, right.task));
    const page = entries.slice(0, limit).map(({ task }) => copy(task));
    const last = page[page.length - 1];
    return {
      tasks: page,
      ...(entries.length > limit && last !== undefined ? { nextCursor: { createdAt: last.createdAt, id: last.id } } : {}),
    };
  }

  public async saveNew(
    instance: ApprovalInstance,
    idempotencyKey: string,
    fingerprint: string,
    events: readonly DomainEvent[],
  ): Promise<ApprovalInstance> {
    const existing = this.idempotency.get(idempotencyKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new ApprovalError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different command");
      }
      return copy(this.instances.get(existing.instanceId)!);
    }
    const stored = copy(instance);
    stored.version = 1;
    this.instances.set(stored.id, stored);
    this.idempotency.set(idempotencyKey, { instanceId: stored.id, fingerprint });
    this.outbox.append(events);
    return copy(stored);
  }

  public async save(
    instance: ApprovalInstance,
    expectedVersion: number,
    idempotencyKey: string,
    fingerprint: string,
    events: readonly DomainEvent[],
    _operationType?: string,
  ): Promise<ApprovalInstance> {
    const existingAction = this.idempotency.get(idempotencyKey);
    if (existingAction !== undefined) {
      if (existingAction.fingerprint !== fingerprint) {
        throw new ApprovalError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different command");
      }
      return copy(this.instances.get(existingAction.instanceId)!);
    }
    const stored = this.instances.get(instance.id);
    if (stored === undefined) throw new ApprovalError("INSTANCE_NOT_FOUND", `Instance '${instance.id}' was not found`);
    if (stored.version !== expectedVersion) {
      throw new ApprovalError("VERSION_CONFLICT", "Approval instance was modified concurrently");
    }
    const next = copy(instance);
    next.version = expectedVersion + 1;
    this.instances.set(next.id, next);
    this.idempotency.set(idempotencyKey, { instanceId: next.id, fingerprint });
    this.outbox.append(events);
    return copy(next);
  }

  public readOutbox(): readonly DomainEvent[] {
    return this.outbox.readOutbox();
  }

  public readOutboxRecords() {
    return this.outbox.readOutboxRecords();
  }

  public async claimOutboxEvents(input: ClaimOutboxEventsInput): Promise<readonly ClaimedOutboxEvent[]> {
    return this.outbox.claimOutboxEvents(input);
  }

  public async markOutboxEventProcessed(input: CompleteOutboxEventInput): Promise<void> {
    await this.outbox.markOutboxEventProcessed(input);
  }

  public async markOutboxEventFailed(input: FailOutboxEventInput): Promise<void> {
    await this.outbox.markOutboxEventFailed(input);
  }

  public async markOutboxEventDead(input: DeadLetterOutboxEventInput): Promise<void> {
    await this.outbox.markOutboxEventDead(input);
  }

  public async listDeadOutboxEvents(limit: number): Promise<readonly DeadOutboxEvent[]> {
    return this.outbox.listDeadOutboxEvents(limit);
  }

  public async resetDeadOutboxEvent(input: ResetDeadOutboxEventInput): Promise<void> {
    await this.outbox.resetDeadOutboxEvent(input);
  }

  public async createDefinition(input: CreateWorkflowDefinitionRecord): Promise<WorkflowDefinitionRecord> {
    if ([...this.definitionRecords.values()].some((item) => item.key === input.key)) {
      throw new ApprovalError("INVALID_COMMAND", `Workflow key '${input.key}' already exists`);
    }
    const definition: WorkflowDefinitionRecord = {
      id: input.id,
      key: input.key,
      name: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
      status: "ACTIVE",
      createdBy: input.createdBy,
      createdAt: input.occurredAt,
      updatedAt: input.occurredAt,
    };
    this.definitionRecords.set(definition.id, definition);
    this.drafts.set(definition.id, {
      definitionId: definition.id,
      content: { nodes: [], edges: [] },
      revision: 0,
      updatedBy: input.createdBy,
      updatedAt: input.occurredAt,
    });
    return copy(definition);
  }

  public async getDefinition(definitionId: string): Promise<WorkflowDefinitionRecord | undefined> {
    const definition = this.definitionRecords.get(definitionId);
    return definition === undefined ? undefined : copy(definition);
  }

  public async getDefinitionByKey(key: string): Promise<WorkflowDefinitionRecord | undefined> {
    const definition = [...this.definitionRecords.values()].find((item) => item.key === key);
    return definition === undefined ? undefined : copy(definition);
  }

  public async getDraft(definitionId: string): Promise<WorkflowDraftRecord | undefined> {
    const draft = this.drafts.get(definitionId);
    return draft === undefined ? undefined : copy(draft);
  }

  public async saveDraft(input: SaveWorkflowDraftRecord): Promise<WorkflowDraftRecord> {
    const draft = this.drafts.get(input.definitionId);
    if (draft === undefined) throw new ApprovalError("WORKFLOW_NOT_FOUND", `Workflow '${input.definitionId}' was not found`);
    if (draft.revision !== input.expectedRevision) {
      throw new ApprovalError("VERSION_CONFLICT", "Workflow draft was modified concurrently");
    }
    const updated: WorkflowDraftRecord = {
      definitionId: input.definitionId,
      content: copy(input.content),
      revision: draft.revision + 1,
      updatedBy: input.updatedBy,
      updatedAt: input.occurredAt,
    };
    this.drafts.set(input.definitionId, updated);
    return copy(updated);
  }

  public async publishDraft(input: PublishWorkflowDraftRecord): Promise<WorkflowVersionRecord> {
    const definition = this.definitionRecords.get(input.definitionId);
    const draft = this.drafts.get(input.definitionId);
    if (definition === undefined || draft === undefined) {
      throw new ApprovalError("WORKFLOW_NOT_FOUND", `Workflow '${input.definitionId}' was not found`);
    }
    if (draft.revision !== input.expectedRevision) {
      throw new ApprovalError("VERSION_CONFLICT", "Workflow draft was modified concurrently");
    }
    if (draft.publishedRevision === draft.revision) {
      throw new ApprovalError("DRAFT_ALREADY_PUBLISHED", "Workflow draft has already been published");
    }
    const existing = this.versions.get(input.definitionId) ?? [];
    const version = existing.length + 1;
    const content = parseWorkflowDefinition({
      key: definition.key,
      name: definition.name,
      version,
      ...(definition.description === undefined ? {} : { description: definition.description }),
      ...draft.content,
    });
    const published: WorkflowVersionRecord = {
      id: input.versionId,
      definitionId: definition.id,
      version,
      schemaVersion: 1,
      content: copy(content),
      contentHash: commandFingerprint(content),
      publishedBy: input.publishedBy,
      publishedAt: input.occurredAt,
    };
    this.versions.set(definition.id, [...existing, published]);
    this.definitions.set(definition.key, copy(content));
    this.drafts.set(definition.id, { ...draft, publishedRevision: draft.revision });
    this.definitionRecords.set(definition.id, {
      ...definition,
      currentVersion: version,
      updatedAt: input.occurredAt,
    });
    return copy(published);
  }

  public async listVersions(definitionId: string): Promise<readonly WorkflowVersionRecord[]> {
    return copy(this.versions.get(definitionId) ?? []);
  }

  public async setDefinitionStatus(
    definitionId: string,
    status: WorkflowDefinitionStatus,
    _updatedBy: string,
    occurredAt: string,
  ): Promise<WorkflowDefinitionRecord> {
    const definition = this.definitionRecords.get(definitionId);
    if (definition === undefined) throw new ApprovalError("WORKFLOW_NOT_FOUND", `Workflow '${definitionId}' was not found`);
    const updated = { ...definition, status, updatedAt: occurredAt };
    this.definitionRecords.set(definitionId, updated);
    return copy(updated);
  }
}
