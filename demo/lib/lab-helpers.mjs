import { ApprovalError, createApprovalModule } from "../../dist/esm/index.js";
import { InMemoryApprovalStore } from "../../dist/esm/adapters/in-memory/index.js";
import { createDemoOrganizationProvider } from "./demo-runtime.mjs";

export function approvalWorkflow({
  key,
  name = key,
  mode = "ANY",
  assignees = [{ type: "USER", value: "manager-1" }],
  emptyAssigneePolicy = "ERROR",
  selfApprovalPolicy = "REQUIRE_OTHER",
  version = 1,
}) {
  return {
    key,
    name,
    version,
    nodes: [
      { id: "start", type: "START", name: "开始" },
      {
        id: "review",
        type: "APPROVAL",
        name: "审批",
        config: { mode, assignees, emptyAssigneePolicy, selfApprovalPolicy },
      },
      { id: "approved_end", type: "END", name: "通过" },
    ],
    edges: [
      { id: "e_start_review", source: "start", target: "review" },
      { id: "e_review_end", source: "review", target: "approved_end" },
    ],
  };
}

export function createFixture(definitions, organizationProvider = createDemoOrganizationProvider()) {
  const store = new InMemoryApprovalStore();
  for (const definition of definitions) store.publish(definition);
  return {
    store,
    approval: createApprovalModule({ store, organizationProvider }),
  };
}

export function command(definitionKey, suffix = definitionKey, context = {}) {
  return {
    idempotencyKey: `lab:${suffix}`,
    definitionKey,
    business: { type: "lab", id: `LAB-${suffix.toUpperCase()}` },
    applicantId: "employee-1",
    context,
  };
}

export function errorCode(error) {
  return error instanceof ApprovalError ? error.code : "UNEXPECTED_ERROR";
}

export async function expectError(action) {
  try {
    await action();
    return "NO_ERROR";
  } catch (error) {
    return errorCode(error);
  }
}
export function step(label, passed, detail) {
  return { label, passed, detail };
}

export function evidence(label, value) {
  return { label, value };
}

export function result(id, title, passed, summary, steps, evidenceItems) {
  return { id, title, passed, summary, steps, evidence: evidenceItems };
}
