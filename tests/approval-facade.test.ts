import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  ApprovalError,
  ApprovalFacade,
  createApprovalModule,
  type IdGenerator,
  type WorkflowDefinition,
} from "../src/index.js";
import type { ApprovalInstance, DomainEvent } from "../src/domain/model.js";
import { InMemoryApprovalStore, StaticOrganizationProvider } from "../src/adapters/in-memory/index.js";

class FlakyConflictStore extends InMemoryApprovalStore {
  public conflictsRemaining = 0;

  public override async save(
    instance: ApprovalInstance,
    expectedVersion: number,
    idempotencyKey: string,
    fingerprint: string,
    events: readonly DomainEvent[],
    operationType?: string,
  ): Promise<ApprovalInstance> {
    if (this.conflictsRemaining > 0) {
      this.conflictsRemaining -= 1;
      throw new ApprovalError("VERSION_CONFLICT", "simulated concurrent write");
    }
    return super.save(instance, expectedVersion, idempotencyKey, fingerprint, events, operationType);
  }
}

class SequentialIds implements IdGenerator {
  private sequence = 0;
  public nextId(
    scope:
      | "instance"
      | "execution"
      | "task"
      | "transition"
      | "event"
      | "workflow-definition"
      | "workflow-version",
  ): string {
    this.sequence += 1;
    return `${scope}-${this.sequence}`;
  }
}

async function loadWorkflow(name: string): Promise<WorkflowDefinition> {
  const raw = await readFile(resolve(process.cwd(), "examples", name), "utf8");
  return JSON.parse(raw) as WorkflowDefinition;
}

function createFixture(): {
  readonly facade: ApprovalFacade;
  readonly store: InMemoryApprovalStore;
} {
  const store = new InMemoryApprovalStore();
  const organization = new StaticOrganizationProvider((policy) => {
    if (policy.type === "MANAGER") return ["manager-1"];
    if (policy.type === "ROLE" && policy.value === "finance-approver") return ["finance-1", "finance-2"];
    return [];
  });
  const facade = new ApprovalFacade(store, {
    organizationProvider: organization,
    clock: { now: () => new Date("2026-09-09T08:00:00.000Z") },
    ids: new SequentialIds(),
  });
  return { facade, store };
}

test("low-value expense finishes after manager approval", async () => {
  const { facade, store } = createFixture();
  store.publish(await loadWorkflow("reimbursement.workflow.json"));

  const started = await facade.start({
    idempotencyKey: "expense:low:start",
    definitionKey: "expense-approval",
    business: { type: "expense", id: "EXP-LOW" },
    applicantId: "employee-1",
    context: { amount: 200 },
  });
  assert.equal(started.status, "RUNNING");
  assert.equal(started.version, 1);
  assert.equal(started.tasks[0]?.assigneeId, "manager-1");

  const completed = await facade.act({
    idempotencyKey: "expense:low:approve",
    taskId: started.tasks[0]!.id,
    operatorId: "manager-1",
    action: "APPROVE",
  });
  assert.equal(completed.status, "APPROVED");
  assert.equal(completed.version, 2);
});

test("ALL mode waits until every approver has approved", async () => {
  const { facade, store } = createFixture();
  const definition = await loadWorkflow("reimbursement.workflow.json");
  const nodes = definition.nodes.map((node) =>
    node.type === "APPROVAL" && node.id === "finance_review"
      ? { ...node, config: { ...node.config, mode: "ALL" as const } }
      : node,
  );
  store.publish({ ...definition, nodes });

  const started = await facade.start({
    idempotencyKey: "expense:all:start",
    definitionKey: "expense-approval",
    business: { type: "expense", id: "EXP-ALL" },
    applicantId: "employee-1",
    context: { amount: 6800 },
  });
  const afterManager = await facade.act({
    idempotencyKey: "expense:all:manager",
    taskId: started.tasks[0]!.id,
    operatorId: "manager-1",
    action: "APPROVE",
  });
  const financeTasks = afterManager.tasks.filter((task) => task.nodeId === "finance_review");
  const afterFirst = await facade.act({
    idempotencyKey: "expense:all:finance-1",
    taskId: financeTasks[0]!.id,
    operatorId: financeTasks[0]!.assigneeId,
    action: "APPROVE",
  });
  assert.equal(afterFirst.status, "RUNNING");

  const completed = await facade.act({
    idempotencyKey: "expense:all:finance-2",
    taskId: financeTasks[1]!.id,
    operatorId: financeTasks[1]!.assigneeId,
    action: "APPROVE",
  });
  assert.equal(completed.status, "APPROVED");
});

test("high-value expense creates finance ANY tasks and one approval completes it", async () => {
  const { facade, store } = createFixture();
  store.publish(await loadWorkflow("reimbursement.workflow.json"));
  const started = await facade.start({
    idempotencyKey: "expense:high:start",
    definitionKey: "expense-approval",
    business: { type: "expense", id: "EXP-HIGH" },
    applicantId: "employee-1",
    context: { amount: 6800 },
  });

  const afterManager = await facade.act({
    idempotencyKey: "expense:high:manager",
    taskId: started.tasks[0]!.id,
    operatorId: "manager-1",
    action: "APPROVE",
  });
  const financeTasks = afterManager.tasks.filter((task) => task.nodeId === "finance_review");
  assert.equal(financeTasks.length, 2);

  const completed = await facade.act({
    idempotencyKey: "expense:high:finance",
    taskId: financeTasks[0]!.id,
    operatorId: financeTasks[0]!.assigneeId,
    action: "APPROVE",
  });
  assert.equal(completed.status, "APPROVED");
  assert.equal(completed.tasks.find((task) => task.id === financeTasks[1]!.id)?.status, "CANCELED");
});

test("rejection closes the instance and writes an outbox event", async () => {
  const { facade, store } = createFixture();
  store.publish(await loadWorkflow("reimbursement.workflow.json"));
  const started = await facade.start({
    idempotencyKey: "expense:reject:start",
    definitionKey: "expense-approval",
    business: { type: "expense", id: "EXP-REJECT" },
    applicantId: "employee-1",
    context: { amount: 100 },
  });
  const rejected = await facade.act({
    idempotencyKey: "expense:reject:action",
    taskId: started.tasks[0]!.id,
    operatorId: "manager-1",
    action: "REJECT",
    comment: "资料不完整",
  });

  assert.equal(rejected.status, "REJECTED");
  assert.ok(store.readOutbox().some((item) => item.type === "approval.instance.rejected"));
});

test("same idempotency key repeats the result but rejects a different command", async () => {
  const { facade, store } = createFixture();
  store.publish(await loadWorkflow("reimbursement.workflow.json"));
  const command = {
    idempotencyKey: "expense:idempotent:start",
    definitionKey: "expense-approval",
    business: { type: "expense", id: "EXP-IDEMPOTENT" },
    applicantId: "employee-1",
    context: { amount: 200 },
  } as const;

  const first = await facade.start(command);
  const repeated = await facade.start(command);
  assert.equal(repeated.id, first.id);

  await assert.rejects(
    facade.start({ ...command, context: { amount: 300 } }),
    (error: unknown) => error instanceof ApprovalError && error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("public factory creates a framework-independent approval facade", async () => {
  const store = new InMemoryApprovalStore();
  store.publish(await loadWorkflow("reimbursement.workflow.json"));
  const approval = createApprovalModule({
    store,
    organizationProvider: new StaticOrganizationProvider(() => ["manager-1"]),
    clock: { now: () => new Date("2026-09-09T08:00:00.000Z") },
    idGenerator: new SequentialIds(),
  });

  const instance = await approval.start({
    idempotencyKey: "expense:factory:start",
    definitionKey: "expense-approval",
    business: { type: "expense", id: "EXP-FACTORY" },
    applicantId: "employee-1",
    context: { amount: 100 },
  });
  assert.equal(instance.status, "RUNNING");
});

test("REQUIRE_OTHER does not silently skip when the applicant is the only approver", async () => {
  const store = new InMemoryApprovalStore();
  store.publish(await loadWorkflow("reimbursement.workflow.json"));
  const approval = createApprovalModule({
    store,
    organizationProvider: new StaticOrganizationProvider(() => ["employee-1"]),
    clock: { now: () => new Date("2026-09-09T08:00:00.000Z") },
    idGenerator: new SequentialIds(),
  });

  await assert.rejects(
    approval.start({
      idempotencyKey: "expense:self:start",
      definitionKey: "expense-approval",
      business: { type: "expense", id: "EXP-SELF" },
      applicantId: "employee-1",
      context: { amount: 100 },
    }),
    (error: unknown) => error instanceof ApprovalError && error.code === "ASSIGNEE_NOT_FOUND",
  );
});

test("act replays the domain command after transient optimistic-lock conflicts", async () => {
  const store = new FlakyConflictStore();
  store.publish(await loadWorkflow("reimbursement.workflow.json"));
  store.conflictsRemaining = 2;
  const approval = createApprovalModule({
    store,
    organizationProvider: new StaticOrganizationProvider(() => ["manager-1"]),
    clock: { now: () => new Date("2026-09-09T08:00:00.000Z") },
    idGenerator: new SequentialIds(),
  });

  const started = await approval.start({
    idempotencyKey: "expense:conflict:start",
    definitionKey: "expense-approval",
    business: { type: "expense", id: "EXP-CONFLICT" },
    applicantId: "employee-1",
    context: { amount: 100 },
  });
  const completed = await approval.act({
    idempotencyKey: "expense:conflict:approve",
    taskId: started.tasks[0]!.id,
    operatorId: "manager-1",
    action: "APPROVE",
  });
  assert.equal(completed.status, "APPROVED");
  assert.equal(store.conflictsRemaining, 0);
});

test("act surfaces the conflict after exhausting the configured retries", async () => {
  const store = new FlakyConflictStore();
  store.publish(await loadWorkflow("reimbursement.workflow.json"));
  store.conflictsRemaining = 99;
  const approval = createApprovalModule({
    store,
    organizationProvider: new StaticOrganizationProvider(() => ["manager-1"]),
    clock: { now: () => new Date("2026-09-09T08:00:00.000Z") },
    idGenerator: new SequentialIds(),
    policies: { versionConflictRetries: 2 },
  });

  const started = await approval.start({
    idempotencyKey: "expense:conflict-exhausted:start",
    definitionKey: "expense-approval",
    business: { type: "expense", id: "EXP-CONFLICT-EXHAUSTED" },
    applicantId: "employee-1",
    context: { amount: 100 },
  });
  await assert.rejects(
    approval.act({
      idempotencyKey: "expense:conflict-exhausted:approve",
      taskId: started.tasks[0]!.id,
      operatorId: "manager-1",
      action: "APPROVE",
    }),
    (error: unknown) => error instanceof ApprovalError && error.code === "VERSION_CONFLICT",
  );
  assert.equal(store.conflictsRemaining, 96);
});
