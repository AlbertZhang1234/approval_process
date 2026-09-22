import type { BusinessReference } from "../contracts/workflow.js";
import { cancelRuntime, resubmitRuntime, withdrawRuntime, type WithdrawPolicy } from "../domain/instance-lifecycle.js";
import { actOnRuntimeTask, startRuntime, type RuntimeDependencies, type RuntimeResult } from "../domain/approval-runtime.js";
import { ApprovalError } from "../domain/errors.js";
import type { ApprovalActionType, ApprovalInstance, ApprovalTask } from "../domain/model.js";
import type {
  ApprovalStore,
  InstanceBusinessStatusFilter,
  TaskListQuery,
  TaskListResult,
} from "../ports/store.js";
import { validateWorkflow } from "../domain/workflow-validator.js";
import { commandFingerprint } from "./command-fingerprint.js";

export interface StartApprovalCommand {
  readonly idempotencyKey: string;
  readonly definitionKey: string;
  readonly business: BusinessReference;
  readonly applicantId: string;
  readonly context: Readonly<Record<string, unknown>>;
}

export interface ActOnTaskCommand {
  readonly idempotencyKey: string;
  readonly taskId: string;
  readonly operatorId: string;
  readonly action: ApprovalActionType;
  readonly comment?: string;
  readonly targetNodeId?: string;
}

export interface UpdateContextCommand {
  readonly idempotencyKey: string;
  readonly instanceId: string;
  readonly operatorId: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly comment?: string;
}

export interface WithdrawCommand {
  readonly idempotencyKey: string;
  readonly instanceId: string;
  readonly operatorId: string;
  readonly reason?: string;
}

export type CancelCommand = WithdrawCommand;

export interface ApprovalFacadeOptions {
  readonly versionConflictRetries?: number;
  readonly withdrawalPolicy?: WithdrawPolicy;
}

interface PendingPersistence {
  readonly expectedVersion: number;
  readonly result: RuntimeResult;
}

export class ApprovalFacade {
  private readonly versionConflictRetries: number;
  private readonly withdrawalPolicy: WithdrawPolicy;

  public constructor(
    private readonly store: ApprovalStore,
    private readonly runtime: RuntimeDependencies,
    options: ApprovalFacadeOptions = {},
  ) {
    this.versionConflictRetries = options.versionConflictRetries ?? 3;
    this.withdrawalPolicy = options.withdrawalPolicy ?? { allowAfterTaskCompleted: false };
  }

  public async start(command: StartApprovalCommand): Promise<ApprovalInstance> {
    this.assertStartCommand(command);
    const fingerprint = commandFingerprint(command);
    const existing = await this.store.findIdempotentResult(command.idempotencyKey);
    if (existing !== undefined) return this.assertIdempotentMatch(existing.fingerprint, fingerprint, existing.instance);

    const definition = await this.store.getPublishedWorkflow(command.definitionKey);
    if (definition === undefined) {
      throw new ApprovalError("WORKFLOW_NOT_FOUND", `Published workflow '${command.definitionKey}' was not found`);
    }
    validateWorkflow(definition);
    const now = this.runtime.clock.now().toISOString();
    const instance: ApprovalInstance = {
      id: this.runtime.ids.nextId("instance"),
      definitionKey: definition.key,
      definitionVersion: definition.version,
      definition: structuredClone(definition),
      business: structuredClone(command.business),
      applicantId: command.applicantId,
      context: structuredClone(command.context),
      contextRevision: 1,
      status: "RUNNING",
      executions: [],
      tasks: [],
      transitions: [],
      createdAt: now,
      updatedAt: now,
      version: 0,
    };
    const result = await startRuntime(instance, this.runtime);
    return this.store.saveNew(result.instance, command.idempotencyKey, fingerprint, result.events);
  }

  public async act(command: ActOnTaskCommand): Promise<ApprovalInstance> {
    this.assertActCommand(command);
    const fingerprint = commandFingerprint(command);
    return this.persistWithRetry("ACT", command.idempotencyKey, fingerprint, async () => {
      const task = await this.store.getTask(command.taskId);
      if (task === undefined) throw new ApprovalError("TASK_NOT_FOUND", `Task '${command.taskId}' was not found`);
      const instance = await this.store.getInstance(task.instanceId);
      if (instance === undefined) throw new ApprovalError("INSTANCE_NOT_FOUND", `Instance '${task.instanceId}' was not found`);
      const expectedVersion = instance.version;
      const result = await actOnRuntimeTask(
        instance,
        command.taskId,
        command.operatorId,
        command.action,
        command.comment,
        this.runtime,
        command.targetNodeId,
      );
      return { expectedVersion, result };
    });
  }

  public async updateContext(command: UpdateContextCommand): Promise<ApprovalInstance> {
    this.assertInstanceCommand(command);
    commandFingerprint(command.context);
    const fingerprint = commandFingerprint(command);
    return this.persistWithRetry("UPDATE_CONTEXT", command.idempotencyKey, fingerprint, async () => {
      const instance = await this.loadInstance(command.instanceId);
      const expectedVersion = instance.version;
      const result = await resubmitRuntime(
        instance,
        command.operatorId,
        command.context,
        command.comment,
        this.runtime,
      );
      return { expectedVersion, result };
    });
  }

  public async withdraw(command: WithdrawCommand): Promise<ApprovalInstance> {
    this.assertInstanceCommand(command);
    const fingerprint = commandFingerprint(command);
    return this.persistWithRetry("WITHDRAW", command.idempotencyKey, fingerprint, async () => {
      const instance = await this.loadInstance(command.instanceId);
      const expectedVersion = instance.version;
      const result = withdrawRuntime(instance, command.operatorId, command.reason, this.runtime, this.withdrawalPolicy);
      return { expectedVersion, result };
    });
  }

  public async cancel(command: CancelCommand): Promise<ApprovalInstance> {
    this.assertInstanceCommand(command);
    const fingerprint = commandFingerprint(command);
    return this.persistWithRetry("CANCEL", command.idempotencyKey, fingerprint, async () => {
      const instance = await this.loadInstance(command.instanceId);
      const expectedVersion = instance.version;
      const result = cancelRuntime(instance, command.operatorId, command.reason, this.runtime);
      return { expectedVersion, result };
    });
  }

  public async getInstance(instanceId: string): Promise<ApprovalInstance> {
    return this.loadInstance(instanceId);
  }

  public async getInstanceByBusiness(
    businessType: string,
    businessId: string,
    status?: InstanceBusinessStatusFilter,
  ): Promise<ApprovalInstance> {
    if (!businessType || !businessId) {
      throw new ApprovalError("INVALID_COMMAND", "businessType and businessId are required");
    }
    const instance = await this.store.getInstanceByBusiness(businessType, businessId, status);
    if (instance === undefined) {
      throw new ApprovalError("INSTANCE_NOT_FOUND", `Instance for ${businessType}/${businessId} was not found`);
    }
    return instance;
  }

  public async queryTasks(query: TaskListQuery): Promise<TaskListResult> {
    this.assertTaskListQuery(query);
    return this.store.listTasks(query);
  }

  public async listTasks(assigneeId: string, status: ApprovalTask["status"] = "PENDING"): Promise<readonly ApprovalTask[]> {
    if (!assigneeId) throw new ApprovalError("INVALID_COMMAND", "assigneeId is required");
    const result = await this.store.listTasks({ assigneeId, status });
    return result.tasks;
  }

  private async loadInstance(instanceId: string): Promise<ApprovalInstance> {
    const instance = await this.store.getInstance(instanceId);
    if (instance === undefined) throw new ApprovalError("INSTANCE_NOT_FOUND", `Instance '${instanceId}' was not found`);
    return instance;
  }

  private async persistWithRetry(
    operationType: string,
    idempotencyKey: string,
    fingerprint: string,
    load: () => Promise<PendingPersistence>,
  ): Promise<ApprovalInstance> {
    for (let attempt = 0; ; attempt += 1) {
      const idempotentResult = await this.store.findIdempotentResult(idempotencyKey);
      if (idempotentResult !== undefined) {
        return this.assertIdempotentMatch(idempotentResult.fingerprint, fingerprint, idempotentResult.instance);
      }
      const pending = await load();
      try {
        return await this.store.save(
          pending.result.instance,
          pending.expectedVersion,
          idempotencyKey,
          fingerprint,
          pending.result.events,
          operationType,
        );
      } catch (error) {
        if (
          attempt >= this.versionConflictRetries
          || !(error instanceof ApprovalError)
          || error.code !== "VERSION_CONFLICT"
        ) {
          throw error;
        }
      }
    }
  }

  private assertStartCommand(command: StartApprovalCommand): void {
    if (!command.idempotencyKey || !command.definitionKey || !command.applicantId) {
      throw new ApprovalError("INVALID_COMMAND", "idempotencyKey, definitionKey and applicantId are required");
    }
    if (!command.business.type || !command.business.id) {
      throw new ApprovalError("INVALID_COMMAND", "business.type and business.id are required");
    }
    commandFingerprint(command.context);
  }

  private assertActCommand(command: ActOnTaskCommand): void {
    if (!command.idempotencyKey || !command.taskId || !command.operatorId) {
      throw new ApprovalError("INVALID_COMMAND", "idempotencyKey, taskId and operatorId are required");
    }
    if (
      command.action !== "APPROVE"
      && command.action !== "REJECT"
      && command.action !== "REJECT_TO_APPLICANT"
      && command.action !== "RETURN_TO_NODE"
    ) {
      throw new ApprovalError("INVALID_COMMAND", "action must be APPROVE, REJECT, REJECT_TO_APPLICANT or RETURN_TO_NODE");
    }
    if (command.action === "RETURN_TO_NODE" && !command.targetNodeId) {
      throw new ApprovalError("INVALID_COMMAND", "targetNodeId is required for RETURN_TO_NODE");
    }
  }

  private assertInstanceCommand(command: WithdrawCommand | UpdateContextCommand): void {
    if (!command.idempotencyKey || !command.instanceId || !command.operatorId) {
      throw new ApprovalError("INVALID_COMMAND", "idempotencyKey, instanceId and operatorId are required");
    }
  }

  private assertTaskListQuery(query: TaskListQuery): void {
    if (!query.assigneeId) throw new ApprovalError("INVALID_COMMAND", "assigneeId is required");
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)) {
      throw new ApprovalError("INVALID_COMMAND", "limit must be an integer between 1 and 100");
    }
    if (query.cursor !== undefined && (!query.cursor.createdAt || !query.cursor.id)) {
      throw new ApprovalError("INVALID_COMMAND", "cursor.createdAt and cursor.id are required");
    }
    if (query.orderBy !== undefined && query.orderBy !== "CREATED_DESC" && query.orderBy !== "CREATED_ASC") {
      throw new ApprovalError("INVALID_COMMAND", "orderBy must be CREATED_DESC or CREATED_ASC");
    }
  }

  private assertIdempotentMatch(
    existingFingerprint: string,
    requestedFingerprint: string,
    instance: ApprovalInstance,
  ): ApprovalInstance {
    if (existingFingerprint !== requestedFingerprint) {
      throw new ApprovalError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different command");
    }
    return instance;
  }
}
