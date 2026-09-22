import { ApprovalError } from "./errors.js";
import type { ApprovalInstance, DomainEvent, NodeExecution } from "./model.js";
import {
  advance,
  cancelExecution,
  cancelPendingTasks,
  completeExecution,
  event,
  nextEdge,
  nodeById,
  timestamp,
  type RuntimeDependencies,
  type RuntimeResult,
} from "./runtime-support.js";

export interface WithdrawPolicy {
  readonly allowAfterTaskCompleted: boolean;
}

function requireRunningInstance(instance: ApprovalInstance): void {
  if (instance.status !== "RUNNING") {
    throw new ApprovalError("INVALID_INSTANCE_STATE", `Instance '${instance.id}' is not running`);
  }
}

function requireActiveExecution(instance: ApprovalInstance): NodeExecution {
  const executionId = instance.currentExecutionId;
  if (executionId === undefined) {
    throw new ApprovalError("INVALID_INSTANCE_STATE", `Instance '${instance.id}' has no active execution`);
  }
  const execution = instance.executions.find((candidate) => candidate.id === executionId);
  if (execution === undefined || execution.status !== "ACTIVE") {
    throw new ApprovalError("INVALID_INSTANCE_STATE", `Instance '${instance.id}' has no active execution`);
  }
  return execution;
}

function terminate(
  instance: ApprovalInstance,
  status: "WITHDRAWN" | "CANCELED",
  operatorId: string,
  reason: string | undefined,
  dependencies: RuntimeDependencies,
): RuntimeResult {
  requireRunningInstance(instance);
  const execution = requireActiveExecution(instance);
  cancelPendingTasks(instance, execution.id, dependencies);
  cancelExecution(execution, dependencies);
  delete instance.currentExecutionId;
  instance.status = status;
  instance.updatedAt = timestamp(dependencies.clock);
  const data: Record<string, unknown> = { operatorId, ...(reason === undefined ? {} : { reason }) };
  return {
    instance,
    events: [
      event(instance, status === "WITHDRAWN" ? "approval.instance.withdrawn" : "approval.instance.canceled", data, dependencies),
    ],
  };
}

export function withdrawRuntime(
  instance: ApprovalInstance,
  operatorId: string,
  reason: string | undefined,
  dependencies: RuntimeDependencies,
  policy: WithdrawPolicy,
): RuntimeResult {
  requireRunningInstance(instance);
  if (operatorId !== instance.applicantId) {
    throw new ApprovalError("FORBIDDEN_INSTANCE_ACTION", "Only the applicant can withdraw an instance");
  }
  const taskCompleted = instance.tasks.some((task) => task.status === "APPROVED");
  if (taskCompleted && !policy.allowAfterTaskCompleted) {
    throw new ApprovalError("WITHDRAW_NOT_ALLOWED", "Instance already has processed tasks and cannot be withdrawn");
  }
  return terminate(instance, "WITHDRAWN", operatorId, reason, dependencies);
}

export function cancelRuntime(
  instance: ApprovalInstance,
  operatorId: string,
  reason: string | undefined,
  dependencies: RuntimeDependencies,
): RuntimeResult {
  return terminate(instance, "CANCELED", operatorId, reason, dependencies);
}

export async function resubmitRuntime(
  instance: ApprovalInstance,
  operatorId: string,
  context: Readonly<Record<string, unknown>>,
  comment: string | undefined,
  dependencies: RuntimeDependencies,
): Promise<RuntimeResult> {
  requireRunningInstance(instance);
  if (operatorId !== instance.applicantId) {
    throw new ApprovalError("FORBIDDEN_INSTANCE_ACTION", "Only the applicant can update the business context");
  }
  const execution = requireActiveExecution(instance);
  const node = nodeById(instance, execution.nodeId);
  if (node.type !== "START" || execution.round < 2) {
    throw new ApprovalError("INVALID_INSTANCE_STATE", `Instance '${instance.id}' was not returned to the applicant`);
  }

  const events: DomainEvent[] = [
    event(
      instance,
      "approval.instance.resubmitted",
      { operatorId, contextRevision: instance.contextRevision + 1, ...(comment === undefined ? {} : { comment }) },
      dependencies,
    ),
  ];
  instance.context = structuredClone(context);
  instance.contextRevision += 1;
  completeExecution(execution, "PASSED", dependencies);
  const edge = nextEdge(instance, node);
  await advance(instance, edge.target, execution.id, dependencies, events, "RESUBMIT");
  instance.updatedAt = timestamp(dependencies.clock);
  return { instance, events };
}
