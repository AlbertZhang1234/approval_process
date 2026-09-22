import type { ApprovalWorkflowNode, WorkflowEdge, WorkflowNode } from "../contracts/workflow.js";
import type { Clock, IdGenerator } from "../ports/platform.js";
import type { OrganizationProvider } from "../ports/organization.js";
import { evaluateCondition } from "./condition-evaluator.js";
import { ApprovalError } from "./errors.js";
import type {
  ApprovalInstance,
  ApprovalTask,
  DomainEvent,
  NodeExecution,
  TransitionType,
} from "./model.js";

export interface RuntimeDependencies {
  readonly organizationProvider: OrganizationProvider;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface RuntimeResult {
  readonly instance: ApprovalInstance;
  readonly events: readonly DomainEvent[];
}

export function timestamp(clock: Clock): string {
  return clock.now().toISOString();
}

export function event(
  instance: ApprovalInstance,
  type: DomainEvent["type"],
  data: Readonly<Record<string, unknown>>,
  dependencies: RuntimeDependencies,
): DomainEvent {
  return {
    id: dependencies.ids.nextId("event"),
    type,
    instanceId: instance.id,
    business: instance.business,
    occurredAt: timestamp(dependencies.clock),
    data,
  };
}

export function nodeById(instance: ApprovalInstance, nodeId: string): WorkflowNode {
  const node = instance.definition.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) throw new ApprovalError("INVALID_WORKFLOW", `Node '${nodeId}' does not exist`);
  return node;
}

export function startNode(instance: ApprovalInstance): WorkflowNode {
  const node = instance.definition.nodes.find((candidate) => candidate.type === "START");
  if (node === undefined) throw new ApprovalError("INVALID_WORKFLOW", "START node is missing");
  return node;
}

function outgoingEdges(instance: ApprovalInstance, nodeId: string): readonly WorkflowEdge[] {
  return instance.definition.edges.filter((edge) => edge.source === nodeId);
}

export function nextEdge(instance: ApprovalInstance, node: WorkflowNode): WorkflowEdge {
  const outgoing = outgoingEdges(instance, node.id);
  if (node.type !== "CONDITION") {
    const edge = outgoing[0];
    if (edge === undefined) throw new ApprovalError("INVALID_WORKFLOW", `Node '${node.id}' cannot advance`);
    return edge;
  }

  const matched = outgoing
    .filter((edge) => edge.default !== true && edge.condition !== undefined)
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))
    .find((edge) => evaluateCondition(edge.condition!, instance.context));
  const selected = matched ?? outgoing.find((edge) => edge.default === true);
  if (selected === undefined) {
    throw new ApprovalError("INVALID_WORKFLOW", `Condition node '${node.id}' has no matching route`);
  }
  return selected;
}

export function enterNode(
  instance: ApprovalInstance,
  nodeId: string,
  previousExecutionId: string | undefined,
  dependencies: RuntimeDependencies,
  type: TransitionType = "FORWARD",
): NodeExecution {
  const execution: NodeExecution = {
    id: dependencies.ids.nextId("execution"),
    nodeId,
    round: instance.executions.filter((item) => item.nodeId === nodeId).length + 1,
    ...(previousExecutionId === undefined ? {} : { previousExecutionId }),
    status: "ACTIVE",
    enteredAt: timestamp(dependencies.clock),
  };
  instance.executions.push(execution);
  instance.currentExecutionId = execution.id;
  instance.transitions.push({
    id: dependencies.ids.nextId("transition"),
    ...(previousExecutionId === undefined ? {} : { fromExecutionId: previousExecutionId }),
    toExecutionId: execution.id,
    type,
    occurredAt: timestamp(dependencies.clock),
  });
  return execution;
}

export function completeExecution(
  execution: NodeExecution,
  result: NonNullable<NodeExecution["result"]>,
  dependencies: RuntimeDependencies,
): void {
  execution.status = "COMPLETED";
  execution.result = result;
  execution.leftAt = timestamp(dependencies.clock);
}

export function cancelExecution(execution: NodeExecution, dependencies: RuntimeDependencies): void {
  execution.status = "CANCELED";
  execution.leftAt = timestamp(dependencies.clock);
}

export function cancelPendingTasks(
  instance: ApprovalInstance,
  executionId: string,
  dependencies: RuntimeDependencies,
): void {
  for (const task of instance.tasks) {
    if (task.executionId === executionId && task.status === "PENDING") {
      task.status = "CANCELED";
      task.completedAt = timestamp(dependencies.clock);
    }
  }
}

export async function resolveAssignees(
  node: ApprovalWorkflowNode,
  instance: ApprovalInstance,
  dependencies: RuntimeDependencies,
): Promise<readonly string[]> {
  const resolved = await Promise.all(
    node.config.assignees.map((policy) =>
      dependencies.organizationProvider.resolveAssignees(policy, {
        applicantId: instance.applicantId,
        business: instance.business,
        context: instance.context,
      }),
    ),
  );
  const originalAssignees = [...new Set(resolved.flat())];
  let assignees = originalAssignees;
  if (node.config.selfApprovalPolicy !== "ALLOW") {
    assignees = assignees.filter((userId) => userId !== instance.applicantId);
  }
  if (
    node.config.selfApprovalPolicy === "REQUIRE_OTHER" &&
    originalAssignees.includes(instance.applicantId) &&
    assignees.length === 0
  ) {
    throw new ApprovalError("ASSIGNEE_NOT_FOUND", `Node '${node.id}' requires an approver other than the applicant`);
  }
  return assignees;
}

export async function advance(
  instance: ApprovalInstance,
  targetNodeId: string,
  previousExecutionId: string | undefined,
  dependencies: RuntimeDependencies,
  events: DomainEvent[],
  transitionType: TransitionType = "FORWARD",
): Promise<void> {
  const node = nodeById(instance, targetNodeId);
  const execution = enterNode(instance, node.id, previousExecutionId, dependencies, transitionType);

  if (node.type === "END") {
    completeExecution(execution, "PASSED", dependencies);
    instance.status = "APPROVED";
    delete instance.currentExecutionId;
    events.push(event(instance, "approval.instance.approved", {}, dependencies));
    return;
  }

  if (node.type === "APPROVAL") {
    const assignees = await resolveAssignees(node, instance, dependencies);
    if (assignees.length === 0 && node.config.emptyAssigneePolicy === "ERROR") {
      throw new ApprovalError("ASSIGNEE_NOT_FOUND", `No assignee resolved for node '${node.id}'`);
    }
    if (assignees.length === 0) {
      const result = node.config.emptyAssigneePolicy === "AUTO_APPROVE" ? "PASSED" : "SKIPPED";
      completeExecution(execution, result, dependencies);
      const edge = nextEdge(instance, node);
      await advance(instance, edge.target, execution.id, dependencies, events);
      return;
    }

    for (const assigneeId of assignees) {
      const task: ApprovalTask = {
        id: dependencies.ids.nextId("task"),
        instanceId: instance.id,
        executionId: execution.id,
        nodeId: node.id,
        assigneeId,
        status: "PENDING",
        createdAt: timestamp(dependencies.clock),
      };
      instance.tasks.push(task);
      events.push(event(instance, "approval.task.created", { taskId: task.id, assigneeId, nodeId: node.id }, dependencies));
    }
    return;
  }

  completeExecution(execution, "PASSED", dependencies);
  const edge = nextEdge(instance, node);
  await advance(instance, edge.target, execution.id, dependencies, events);
}
