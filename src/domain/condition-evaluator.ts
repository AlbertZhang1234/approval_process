import type { WorkflowCondition } from "../contracts/workflow.js";
import { ApprovalError } from "./errors.js";

function readPath(context: Readonly<Record<string, unknown>>, path: string): unknown {
  let value: unknown = context;
  for (const segment of path.split(".")) {
    if (
      segment === "__proto__" ||
      segment === "prototype" ||
      segment === "constructor" ||
      typeof value !== "object" ||
      value === null ||
      !Object.hasOwn(value, segment)
    ) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function compareNumbers(left: unknown, right: unknown, operation: (a: number, b: number) => boolean): boolean {
  return (
    typeof left === "number" &&
    typeof right === "number" &&
    Number.isFinite(left) &&
    Number.isFinite(right) &&
    operation(left, right)
  );
}

export function evaluateCondition(
  condition: WorkflowCondition,
  context: Readonly<Record<string, unknown>>,
): boolean {
  if ("all" in condition) {
    return condition.all.every((item) => evaluateCondition(item, context));
  }
  if ("any" in condition) {
    return condition.any.some((item) => evaluateCondition(item, context));
  }
  if ("not" in condition) {
    return !evaluateCondition(condition.not, context);
  }

  const actual = readPath(context, condition.field);
  switch (condition.operator) {
    case "EQ":
      return actual === condition.value;
    case "NE":
      return actual !== condition.value;
    case "GT":
      return compareNumbers(actual, condition.value, (a, b) => a > b);
    case "GTE":
      return compareNumbers(actual, condition.value, (a, b) => a >= b);
    case "LT":
      return compareNumbers(actual, condition.value, (a, b) => a < b);
    case "LTE":
      return compareNumbers(actual, condition.value, (a, b) => a <= b);
    case "IN":
      return Array.isArray(condition.value) && condition.value.includes(actual);
    case "NOT_IN":
      return Array.isArray(condition.value) && !condition.value.includes(actual);
    case "EXISTS":
      return actual !== undefined && actual !== null;
    default:
      throw new ApprovalError("INVALID_WORKFLOW", "Unsupported condition operator");
  }
}
