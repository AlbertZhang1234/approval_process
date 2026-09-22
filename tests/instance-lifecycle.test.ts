import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalError } from "../src/index.js";
import { createFixture, loadWorkflow, startHighValueExpense } from "./helpers/approval-fixture.js";

test("REJECT_TO_APPLICANT returns to the applicant and resubmission advances with a new context", async () => {
  const { facade, store } = createFixture();
  store.publish(await loadWorkflow());
  const instanceId = await startHighValueExpense(facade, "EXP-RETURN");

  const managerTask = (await facade.getInstance(instanceId)).tasks[0]!;
  await facade.act({
    idempotencyKey: "expense:EXP-RETURN:manager",
    taskId: managerTask.id,
    operatorId: "manager-1",
    action: "APPROVE",
  });
  const financeTask = (await facade.getInstance(instanceId)).tasks.find((task) => task.status === "PENDING")!;

  const returned = await facade.act({
    idempotencyKey: "expense:EXP-RETURN:return",
    taskId: financeTask.id,
    operatorId: "finance-1",
    action: "REJECT_TO_APPLICANT",
    comment: "发票信息有误，请修改后重新提交",
  });
  assert.equal(returned.status, "RUNNING");
  assert.equal(returned.tasks.find((task) => task.id === financeTask.id)?.status, "REJECTED");
  const startExecution = returned.executions.find((execution) => execution.nodeId === "start" && execution.round === 2)!;
  assert.equal(startExecution.status, "ACTIVE");
  assert.equal(returned.currentExecutionId, startExecution.id);
  assert.equal(returned.transitions.at(-1)?.type, "RETURN");
  assert.ok(store.readOutbox().some((item) => item.type === "approval.instance.returned"));

  const resubmitted = await facade.updateContext({
    idempotencyKey: "expense:EXP-RETURN:resubmit",
    instanceId,
    operatorId: "employee-1",
    context: { amount: 200 },
    comment: "已更换发票",
  });
  assert.equal(resubmitted.contextRevision, 2);
  assert.deepEqual(resubmitted.context, { amount: 200 });
  assert.equal(resubmitted.status, "RUNNING");
  assert.equal(resubmitted.transitions.at(-1)?.type, "RESUBMIT");
  assert.ok(store.readOutbox().some((item) => item.type === "approval.instance.resubmitted"));
  const managerRound2 = resubmitted.tasks.filter(
    (task) => task.nodeId === "manager_review" && task.status === "PENDING",
  );
  assert.equal(managerRound2.length, 1);

  const completed = await facade.act({
    idempotencyKey: "expense:EXP-RETURN:manager-2",
    taskId: managerRound2[0]!.id,
    operatorId: "manager-1",
    action: "APPROVE",
  });
  assert.equal(completed.status, "APPROVED");
});

test("RETURN_TO_NODE restarts an earlier approval node with a fresh round", async () => {
  const { facade, store } = createFixture();
  store.publish(await loadWorkflow());
  const instanceId = await startHighValueExpense(facade, "EXP-BACK");

  const managerTask = (await facade.getInstance(instanceId)).tasks[0]!;
  await facade.act({
    idempotencyKey: "expense:EXP-BACK:manager",
    taskId: managerTask.id,
    operatorId: "manager-1",
    action: "APPROVE",
  });
  const financeTask = (await facade.getInstance(instanceId)).tasks.find((task) => task.status === "PENDING")!;

  const returned = await facade.act({
    idempotencyKey: "expense:EXP-BACK:return-node",
    taskId: financeTask.id,
    operatorId: "finance-1",
    action: "RETURN_TO_NODE",
    targetNodeId: "manager_review",
    comment: "请上级先补充预算信息",
  });
  assert.equal(returned.status, "RUNNING");
  const managerRound2 = returned.tasks.filter(
    (task) => task.nodeId === "manager_review" && task.status === "PENDING",
  );
  assert.equal(managerRound2.length, 1);
  const managerExecutionRound2 = returned.executions.find(
    (execution) => execution.id === managerRound2[0]!.executionId,
  )!;
  assert.equal(managerExecutionRound2.round, 2);
  assert.equal(returned.currentExecutionId, managerExecutionRound2.id);
  assert.equal(returned.transitions.at(-1)?.type, "RETURN");
});

test("RETURN_TO_NODE rejects invalid targets", async () => {
  const { facade, store } = createFixture();
  store.publish(await loadWorkflow());
  const instanceId = await startHighValueExpense(facade, "EXP-BAD-TARGET");
  const managerTask = (await facade.getInstance(instanceId)).tasks[0]!;

  await assert.rejects(
    facade.act({
      idempotencyKey: "expense:EXP-BAD-TARGET:not-visited",
      taskId: managerTask.id,
      operatorId: "manager-1",
      action: "RETURN_TO_NODE",
      targetNodeId: "finance_review",
    }),
    (error: unknown) => error instanceof ApprovalError && error.code === "INVALID_RETURN_TARGET",
  );
  await assert.rejects(
    facade.act({
      idempotencyKey: "expense:EXP-BAD-TARGET:not-approval",
      taskId: managerTask.id,
      operatorId: "manager-1",
      action: "RETURN_TO_NODE",
      targetNodeId: "amount_gate",
    }),
    (error: unknown) => error instanceof ApprovalError && error.code === "INVALID_RETURN_TARGET",
  );
  await assert.rejects(
    facade.act({
      idempotencyKey: "expense:EXP-BAD-TARGET:missing",
      taskId: managerTask.id,
      operatorId: "manager-1",
      action: "RETURN_TO_NODE",
    }),
    (error: unknown) => error instanceof ApprovalError && error.code === "INVALID_COMMAND",
  );
});

test("updateContext is restricted to the applicant in the returned state", async () => {
  const { facade, store } = createFixture();
  store.publish(await loadWorkflow());
  const instanceId = await startHighValueExpense(facade, "EXP-UPDATE-CONTEXT");

  await assert.rejects(
    facade.updateContext({
      idempotencyKey: "expense:EXP-UPDATE-CONTEXT:not-applicant",
      instanceId,
      operatorId: "manager-1",
      context: { amount: 100 },
    }),
    (error: unknown) => error instanceof ApprovalError && error.code === "FORBIDDEN_INSTANCE_ACTION",
  );
  await assert.rejects(
    facade.updateContext({
      idempotencyKey: "expense:EXP-UPDATE-CONTEXT:not-returned",
      instanceId,
      operatorId: "employee-1",
      context: { amount: 100 },
    }),
    (error: unknown) => error instanceof ApprovalError && error.code === "INVALID_INSTANCE_STATE",
  );
});
