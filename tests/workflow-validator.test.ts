import assert from "node:assert/strict";
import test from "node:test";
import {
  ApprovalError,
  evaluateCondition,
  parseWorkflowDefinition,
  validateWorkflow,
  type WorkflowDefinition,
} from "../src/index.js";

test("structured conditions support nested fields and boolean groups", () => {
  assert.equal(
    evaluateCondition(
      {
        all: [
          { field: "amount", operator: "GTE", value: 5000 },
          { field: "applicant.department", operator: "EQ", value: "sales" },
        ],
      },
      { amount: 6800, applicant: { department: "sales" } },
    ),
    true,
  );
});

test("workflow validator rejects cycles reserved for future return flows", () => {
  const workflow: WorkflowDefinition = {
    key: "invalid-cycle",
    name: "Invalid cycle",
    version: 1,
    nodes: [
      { id: "start", type: "START", name: "Start" },
      {
        id: "review",
        type: "APPROVAL",
        name: "Review",
        config: {
          mode: "ANY",
          assignees: [{ type: "USER", value: "u1" }],
          emptyAssigneePolicy: "ERROR",
          selfApprovalPolicy: "ALLOW",
        },
      },
      { id: "end", type: "END", name: "End" },
    ],
    edges: [
      { id: "e1", source: "start", target: "review" },
      { id: "e2", source: "review", target: "start" },
    ],
  };

  assert.throws(() => validateWorkflow(workflow), (error: unknown) => {
    return error instanceof ApprovalError && error.code === "INVALID_WORKFLOW";
  });
});

test("runtime parser rejects malformed definitions from external storage", () => {
  assert.throws(
    () =>
      parseWorkflowDefinition({
        key: "expense-approval",
        name: "Expense approval",
        version: "1",
        nodes: [],
        edges: [],
      }),
    (error: unknown) => error instanceof ApprovalError && error.code === "INVALID_WORKFLOW",
  );
});

test("condition evaluation never traverses prototype properties", () => {
  const inherited = Object.create({ secret: "exposed" }) as Record<string, unknown>;
  assert.equal(evaluateCondition({ field: "secret", operator: "EXISTS" }, inherited), false);
  assert.equal(evaluateCondition({ field: "constructor", operator: "EXISTS" }, {}), false);
});
