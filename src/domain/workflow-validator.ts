import type {
  WorkflowCondition,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from "../contracts/workflow.js";
import { ApprovalError } from "./errors.js";

const NODE_TYPES = new Set(["START", "APPROVAL", "CONDITION", "END"]);
const APPROVAL_MODES = new Set(["ANY", "ALL"]);
const EMPTY_POLICIES = new Set(["ERROR", "SKIP", "AUTO_APPROVE"]);
const SELF_POLICIES = new Set(["ALLOW", "SKIP", "REQUIRE_OTHER"]);
const ASSIGNEE_TYPES = new Set(["USER", "ROLE", "DEPARTMENT_ROLE", "MANAGER", "REQUEST_FIELD", "PROVIDER"]);
const CONDITION_OPERATORS = new Set(["EQ", "NE", "GT", "GTE", "LT", "LTE", "IN", "NOT_IN", "EXISTS"]);
const ID_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
const KEY_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;
const FIELD_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.]{0,127}$/;

function fail(message: string): never {
  throw new ApprovalError("INVALID_WORKFLOW", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail(`${path} must be an object`);
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  const unknownKey = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknownKey !== undefined) fail(`${path} contains unsupported property '${unknownKey}'`);
}

function assertString(value: unknown, path: string, maximumLength = 100): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    fail(`${path} must be a non-empty string of at most ${maximumLength} characters`);
  }
}

function assertCondition(value: unknown, path: string, depth = 0): asserts value is WorkflowCondition {
  if (depth > 20) fail(`${path} exceeds the maximum nesting depth`);
  assertRecord(value, path);

  if ("all" in value || "any" in value || "not" in value) {
    const groupKeys = ["all", "any", "not"].filter((key) => key in value);
    if (groupKeys.length !== 1) fail(`${path} must contain exactly one boolean operator`);
    const key = groupKeys[0]!;
    assertAllowedKeys(value, [key], path);
    if (key === "not") {
      assertCondition(value[key], `${path}.not`, depth + 1);
      return;
    }
    const children = value[key];
    if (!Array.isArray(children) || children.length === 0) fail(`${path}.${key} must be a non-empty array`);
    children.forEach((child, index) => assertCondition(child, `${path}.${key}[${index}]`, depth + 1));
    return;
  }

  assertAllowedKeys(value, ["field", "operator", "value"], path);
  assertString(value["field"], `${path}.field`, 128);
  if (!FIELD_PATTERN.test(value["field"])) fail(`${path}.field has an invalid path`);
  if (typeof value["operator"] !== "string" || !CONDITION_OPERATORS.has(value["operator"])) {
    fail(`${path}.operator is not supported`);
  }
  if (value["operator"] !== "EXISTS" && !("value" in value)) fail(`${path}.value is required`);
}

function assertNode(value: unknown, index: number): asserts value is WorkflowNode {
  const path = `nodes[${index}]`;
  assertRecord(value, path);
  assertString(value["id"], `${path}.id`, 64);
  if (!ID_PATTERN.test(value["id"])) fail(`${path}.id has an invalid format`);
  assertString(value["name"], `${path}.name`);
  if (typeof value["type"] !== "string" || !NODE_TYPES.has(value["type"])) fail(`${path}.type is not supported`);

  if (value["type"] !== "APPROVAL") {
    assertAllowedKeys(value, ["id", "name", "type"], path);
    return;
  }

  assertAllowedKeys(value, ["id", "name", "type", "config"], path);
  assertRecord(value["config"], `${path}.config`);
  const config = value["config"];
  assertAllowedKeys(config, ["mode", "assignees", "emptyAssigneePolicy", "selfApprovalPolicy"], `${path}.config`);
  if (typeof config["mode"] !== "string" || !APPROVAL_MODES.has(config["mode"])) fail(`${path}.config.mode is not supported`);
  if (typeof config["emptyAssigneePolicy"] !== "string" || !EMPTY_POLICIES.has(config["emptyAssigneePolicy"])) {
    fail(`${path}.config.emptyAssigneePolicy is not supported`);
  }
  if (typeof config["selfApprovalPolicy"] !== "string" || !SELF_POLICIES.has(config["selfApprovalPolicy"])) {
    fail(`${path}.config.selfApprovalPolicy is not supported`);
  }
  const assignees = config["assignees"];
  if (!Array.isArray(assignees) || assignees.length === 0) fail(`${path}.config.assignees must be a non-empty array`);
  assignees.forEach((assignee, assigneeIndex) => {
    const assigneePath = `${path}.config.assignees[${assigneeIndex}]`;
    assertRecord(assignee, assigneePath);
    assertAllowedKeys(assignee, ["type", "value"], assigneePath);
    if (typeof assignee["type"] !== "string" || !ASSIGNEE_TYPES.has(assignee["type"])) {
      fail(`${assigneePath}.type is not supported`);
    }
    assertString(assignee["value"], `${assigneePath}.value`, 128);
  });
}

function assertEdge(value: unknown, index: number): asserts value is WorkflowEdge {
  const path = `edges[${index}]`;
  assertRecord(value, path);
  assertAllowedKeys(value, ["id", "source", "target", "priority", "default", "condition"], path);
  for (const key of ["id", "source", "target"] as const) {
    assertString(value[key], `${path}.${key}`, 64);
    if (!ID_PATTERN.test(value[key])) fail(`${path}.${key} has an invalid format`);
  }
  if ("priority" in value && (!Number.isInteger(value["priority"]) || (value["priority"] as number) < 0)) {
    fail(`${path}.priority must be a non-negative integer`);
  }
  if ("default" in value && typeof value["default"] !== "boolean") fail(`${path}.default must be a boolean`);
  if ("condition" in value) assertCondition(value["condition"], `${path}.condition`);
}

function assertWorkflowShape(value: unknown): asserts value is WorkflowDefinition {
  assertRecord(value, "workflow");
  assertAllowedKeys(value, ["key", "name", "version", "description", "nodes", "edges"], "workflow");
  assertString(value["key"], "workflow.key", 64);
  if (!KEY_PATTERN.test(value["key"])) fail("workflow.key has an invalid format");
  assertString(value["name"], "workflow.name");
  if (!Number.isInteger(value["version"]) || (value["version"] as number) < 1) {
    fail("workflow.version must be a positive integer");
  }
  if ("description" in value && value["description"] !== undefined) {
    assertString(value["description"], "workflow.description", 500);
  }
  if (!Array.isArray(value["nodes"]) || value["nodes"].length < 2) fail("workflow.nodes must contain at least two nodes");
  if (!Array.isArray(value["edges"]) || value["edges"].length < 1) fail("workflow.edges must contain at least one edge");
  value["nodes"].forEach(assertNode);
  value["edges"].forEach(assertEdge);
}

function assertAcyclic(definition: WorkflowDefinition): void {
  const outgoing = new Map<string, string[]>();
  for (const edge of definition.edges) {
    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) fail(`Workflow contains a cycle at node '${nodeId}'`);
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const target of outgoing.get(nodeId) ?? []) visit(target);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of definition.nodes) visit(node.id);
}

function assertReachable(definition: WorkflowDefinition, startNodeId: string): void {
  const reachable = new Set<string>();
  const visit = (nodeId: string): void => {
    if (reachable.has(nodeId)) return;
    reachable.add(nodeId);
    definition.edges.filter((edge) => edge.source === nodeId).forEach((edge) => visit(edge.target));
  };
  visit(startNodeId);
  const unreachable = definition.nodes.find((node) => !reachable.has(node.id));
  if (unreachable !== undefined) fail(`Node '${unreachable.id}' is not reachable from START`);
}

function validateNodeEdges(definition: WorkflowDefinition, node: WorkflowNode): void {
  const outgoing = definition.edges.filter((edge) => edge.source === node.id);
  if (node.type === "END" && outgoing.length > 0) fail(`END node '${node.id}' cannot have outgoing edges`);
  if (node.type !== "END" && outgoing.length === 0) fail(`Node '${node.id}' has no outgoing edge`);
  if ((node.type === "START" || node.type === "APPROVAL") && outgoing.length !== 1) {
    fail(`Node '${node.id}' must have exactly one outgoing edge`);
  }
  if (node.type !== "CONDITION" && outgoing.some((edge) => edge.condition !== undefined || edge.default === true)) {
    fail(`Only CONDITION node '${node.id}' may use conditional or default edges`);
  }
  if (node.type !== "CONDITION") return;

  if (outgoing.filter((edge) => edge.default === true).length > 1) {
    fail(`Condition node '${node.id}' has multiple default edges`);
  }
  if (outgoing.some((edge) => edge.default === true && edge.condition !== undefined)) {
    fail(`Condition node '${node.id}' has a default edge with a condition`);
  }
  if (outgoing.some((edge) => edge.default !== true && edge.condition === undefined)) {
    fail(`Condition node '${node.id}' has an edge without a condition`);
  }
  const priorities = outgoing.filter((edge) => edge.default !== true).map((edge) => edge.priority ?? 0);
  if (new Set(priorities).size !== priorities.length) {
    fail(`Condition node '${node.id}' has duplicate priorities`);
  }
}

export function validateWorkflow(value: unknown): asserts value is WorkflowDefinition {
  assertWorkflowShape(value);
  const definition = value;
  const nodeById = new Map<string, WorkflowNode>();
  for (const node of definition.nodes) {
    if (nodeById.has(node.id)) fail(`Duplicate node id '${node.id}'`);
    nodeById.set(node.id, node);
  }
  const startNodes = definition.nodes.filter((node) => node.type === "START");
  if (startNodes.length !== 1) fail("Workflow must contain exactly one START node");
  if (!definition.nodes.some((node) => node.type === "END")) fail("Workflow must contain an END node");

  const edgeIds = new Set<string>();
  for (const edge of definition.edges) {
    if (edgeIds.has(edge.id)) fail(`Duplicate edge id '${edge.id}'`);
    edgeIds.add(edge.id);
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) {
      fail(`Edge '${edge.id}' references a missing node`);
    }
  }
  definition.nodes.forEach((node) => validateNodeEdges(definition, node));
  assertAcyclic(definition);
  assertReachable(definition, startNodes[0]!.id);
}

export function parseWorkflowDefinition(value: unknown): WorkflowDefinition {
  validateWorkflow(value);
  return structuredClone(value);
}
