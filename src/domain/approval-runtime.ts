import { ApprovalError } from "./errors.js";
import type { ApprovalActionType, ApprovalInstance, DomainEvent } from "./model.js";
import {
  advance,
  cancelPendingTasks,
  completeExecution,
  enterNode,
  event,
  nextEdge,
  nodeById,
  startNode,
  timestamp,
  type RuntimeDependencies,
  type RuntimeResult,
} from "./runtime-support.js";

export type { RuntimeDependencies, RuntimeResult } from "./runtime-support.js";

export async function startRuntime(
  instance: ApprovalInstance,
  dependencies: RuntimeDependencies,
): Promise<RuntimeResult> {
  const events: DomainEvent[] = [event(instance, "approval.instance.started", {}, dependencies)];
  await advance(instance, startNode(instance).id, undefined, dependencies, events);
  instance.updatedAt = timestamp(dependencies.clock);
  return { instance, events };
}

function returnTargetNodeId(instance: ApprovalInstance, action: ApprovalActionType, requested?: string): string {
  if (action === "REJECT_TO_APPLICANT") return startNode(instance).id;
  if (!requested) {
    throw new ApprovalError("INVALID_COMMAND", "targetNodeId is required for RETURN_TO_NODE");
  }
  const node = nodeById(instance, requested);
  if (node.type !== "APPROVAL") {
    throw new ApprovalError("INVALID_RETURN_TARGET", `Return target '${requested}' must be an approval node`);
  }
  if (!instance.executions.some((candidate) => candidate.nodeId === requested)) {
    throw new ApprovalError("INVALID_RETURN_TARGET", `Return target '${requested}' has not been visited yet`);
  }
  return requested;
}

export async function actOnRuntimeTask(
  instance: ApprovalInstance,
  taskId: string,
  operatorId: string,
  action: ApprovalActionType,
  comment: string | undefined,
  dependencies: RuntimeDependencies,
  targetNodeId?: string,
): Promise<RuntimeResult> {
  const task = instance.tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined) throw new ApprovalError("TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
  if (task.status !== "PENDING") throw new ApprovalError("TASK_NOT_PENDING", `Task '${taskId}' is already completed`);
  if (task.assigneeId !== operatorId) throw new ApprovalError("FORBIDDEN_TASK_ACTION", "Operator is not the task assignee");

  const execution = instance.executions.find((candidate) => candidate.id === task.executionId);
  const node = nodeById(instance, task.nodeId);
  if (execution === undefined || node.type !== "APPROVAL") {
    throw new ApprovalError("INVALID_WORKFLOW", "Task points to an invalid approval execution");
  }

  const events: DomainEvent[] = [];
  task.status = action === "APPROVE" ? "APPROVED" : "REJECTED";
  task.completedAt = timestamp(dependencies.clock);
  if (comment !== undefined) task.comment = comment;
  events.push(
    event(
      instance,
      "approval.task.completed",
      { taskId, operatorId, action, ...(comment === undefined ? {} : { comment }) },
      dependencies,
    ),
  );

  if (action === "REJECT_TO_APPLICANT" || action === "RETURN_TO_NODE") {
    const resolvedTarget = returnTargetNodeId(instance, action, targetNodeId);
    cancelPendingTasks(instance, execution.id, dependencies);
    completeExecution(execution, "REJECTED", dependencies);
    if (action === "REJECT_TO_APPLICANT") {
      enterNode(instance, resolvedTarget, execution.id, dependencies, "RETURN");
    } else {
      await advance(instance, resolvedTarget, execution.id, dependencies, events, "RETURN");
    }
    events.push(
      event(
        instance,
        "approval.instance.returned",
        { taskId, operatorId, action, targetNodeId: resolvedTarget },
        dependencies,
      ),
    );
  } else if (action === "REJECT") {
    cancelPendingTasks(instance, execution.id, dependencies);
    completeExecution(execution, "REJECTED", dependencies);
    instance.status = "REJECTED";
    delete instance.currentExecutionId;
    events.push(event(instance, "approval.instance.rejected", { taskId, operatorId }, dependencies));
  } else {
    const siblingTasks = instance.tasks.filter((candidate) => candidate.executionId === execution.id);
    const nodePassed = node.config.mode === "ANY" || siblingTasks.every((candidate) => candidate.status === "APPROVED");
    if (nodePassed) {
      cancelPendingTasks(instance, execution.id, dependencies);
      completeExecution(execution, "PASSED", dependencies);
      const edge = nextEdge(instance, node);
      await advance(instance, edge.target, execution.id, dependencies, events);
    }
  }

  instance.updatedAt = timestamp(dependencies.clock);
  return { instance, events };
}
