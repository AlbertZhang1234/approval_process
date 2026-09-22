import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  ApprovalError,
  createApprovalModule,
  createWorkflowManager,
  type IdGenerator,
  type WorkflowDefinition,
} from "../src/index.js";
import { InMemoryApprovalStore, StaticOrganizationProvider } from "../src/adapters/in-memory/index.js";

class ManagedIds implements IdGenerator {
  private sequence = 0;

  public nextId(scope: Parameters<IdGenerator["nextId"]>[0]): string {
    this.sequence += 1;
    return `${scope}-${this.sequence}`;
  }
}

async function example(): Promise<WorkflowDefinition> {
  const source = await readFile(resolve(process.cwd(), "examples/reimbursement.workflow.json"), "utf8");
  return JSON.parse(source) as WorkflowDefinition;
}

test("workflow drafts are validated, published immutably, and used by new instances only", async () => {
  const store = new InMemoryApprovalStore();
  const ids = new ManagedIds();
  const clock = { now: () => new Date("2026-09-10T08:00:00.000Z") };
  const workflows = createWorkflowManager({ store, idGenerator: ids, clock });
  const source = await example();

  const definition = await workflows.createDefinition({
    key: source.key,
    name: source.name,
    ...(source.description === undefined ? {} : { description: source.description }),
    operatorId: "admin-1",
  });
  const invalid = await workflows.validateDraft(definition.id);
  assert.deepEqual(invalid.valid, false);

  const draft = await workflows.saveDraft({
    definitionId: definition.id,
    expectedRevision: 0,
    content: { nodes: source.nodes, edges: source.edges },
    operatorId: "admin-1",
  });
  assert.equal(draft.revision, 1);
  assert.deepEqual(await workflows.validateDraft(definition.id), { valid: true, errors: [] });

  const version1 = await workflows.publishDraft({
    definitionId: definition.id,
    expectedRevision: draft.revision,
    operatorId: "admin-1",
  });
  assert.equal(version1.version, 1);
  assert.match(version1.contentHash, /^[0-9a-f]{64}$/);
  assert.equal((await workflows.getDraft(definition.id)).publishedRevision, 1);
  await assert.rejects(
    workflows.publishDraft({ definitionId: definition.id, expectedRevision: 1, operatorId: "admin-1" }),
    (error: unknown) => error instanceof ApprovalError && error.code === "DRAFT_ALREADY_PUBLISHED",
  );

  const approval = createApprovalModule({
    store,
    organizationProvider: new StaticOrganizationProvider(() => ["manager-1"]),
    idGenerator: ids,
    clock,
  });
  const existing = await approval.start({
    idempotencyKey: "expense:v1:start",
    definitionKey: source.key,
    business: { type: "expense", id: "EXP-V1" },
    applicantId: "employee-1",
    context: { amount: 100 },
  });

  const changedNodes = source.nodes.map((node) =>
    node.type === "APPROVAL" && node.id === "manager_review"
      ? { ...node, name: "新版直属上级审批" }
      : node,
  );
  const changedDraft = await workflows.saveDraft({
    definitionId: definition.id,
    expectedRevision: 1,
    content: { nodes: changedNodes, edges: source.edges },
    operatorId: "admin-2",
  });
  const version2 = await workflows.publishDraft({
    definitionId: definition.id,
    expectedRevision: changedDraft.revision,
    operatorId: "admin-2",
  });
  const newer = await approval.start({
    idempotencyKey: "expense:v2:start",
    definitionKey: source.key,
    business: { type: "expense", id: "EXP-V2" },
    applicantId: "employee-1",
    context: { amount: 100 },
  });

  assert.equal(existing.definitionVersion, 1);
  assert.equal(existing.definition.nodes.find((node) => node.id === "manager_review")?.name, "直属上级审批");
  assert.equal(version2.version, 2);
  assert.equal(newer.definitionVersion, 2);
  assert.equal(newer.definition.nodes.find((node) => node.id === "manager_review")?.name, "新版直属上级审批");
  assert.deepEqual((await workflows.listVersions(definition.id)).map((item) => item.version), [1, 2]);
});

test("draft writes use optimistic revision checks", async () => {
  const store = new InMemoryApprovalStore();
  const workflows = createWorkflowManager({ store, idGenerator: new ManagedIds() });
  const definition = await workflows.createDefinition({
    key: "leave-approval",
    name: "请假审批",
    operatorId: "admin-1",
  });

  await assert.rejects(
    workflows.saveDraft({
      definitionId: definition.id,
      expectedRevision: 1,
      content: { nodes: [], edges: [] },
      operatorId: "admin-1",
    }),
    (error: unknown) => error instanceof ApprovalError && error.code === "VERSION_CONFLICT",
  );
});
