import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalError } from "../src/index.js";
import { createFixture, loadWorkflow, startHighValueExpense } from "./helpers/approval-fixture.js";

test("applicant withdraws a running instance before any task is approved", async () => {
  const { facade, store } = createFixture();
  store.publish(await loadWorkflow());
  const instanceId = await startHighValueExpense(facade, "EXP-WITHDRAW");

  const withdrawn = await facade.withdraw({
    idempotencyKey: "expense:EXP-WITHDRAW:withdraw",
    instanceId,
    operatorId: "employee-1",
    reason: "误提交",
  });
  assert.equal(withdrawn.status, "WITHDRAWN");
  assert.equal(withdrawn.currentExecutionId, undefined);
  assert.ok(withdrawn.tasks.every((task) => task.status === "CANCELED"));
  assert.ok(store.readOutbox().some((item) => item.type === "approval.instance.withdrawn"));

  await assert.rejects(
    facade.withdraw({
      idempotencyKey: "expense:EXP-WITHDRAW:withdraw-twice",
      instanceId,
      operatorId: "employee-1",
    }),
    (error: unknown) => error instanceof ApprovalError && error.code === "INVALID_INSTANCE_STATE",
  );
});

test("withdraw is restricted to the applicant and to instances without approved tasks", async () => {
  const { facade, store } = createFixture();
  store.publish(await loadWorkflow());
  const instanceId = await startHighValueExpense(facade, "EXP-WITHDRAW-POLICY");
  const managerTask = (await facade.getInstance(instanceId)).tasks[0]!;

  await assert.rejects(
    facade.withdraw({
      idempotencyKey: "expense:EXP-WITHDRAW-POLICY:not-applicant",
      instanceId,
      operatorId: "manager-1",
    }),
    (error: unknown) => error instanceof ApprovalError && error.code === "FORBIDDEN_INSTANCE_ACTION",
  );

  await facade.act({
    idempotencyKey: "expense:EXP-WITHDRAW-POLICY:approve",
    taskId: managerTask.id,
    operatorId: "manager-1",
    action: "APPROVE",
  });
  await assert.rejects(
    facade.withdraw({
      idempotencyKey: "expense:EXP-WITHDRAW-POLICY:after-approval",
      instanceId,
      operatorId: "employee-1",
    }),
    (error: unknown) => error instanceof ApprovalError && error.code === "WITHDRAW_NOT_ALLOWED",
  );

  const permissive = createFixture({ allowWithdrawAfterTaskCompleted: true });
  permissive.store.publish(await loadWorkflow());
  const otherId = await startHighValueExpense(permissive.facade, "EXP-WITHDRAW-ALLOWED");
  const otherTask = (await permissive.facade.getInstance(otherId)).tasks[0]!;
  await permissive.facade.act({
    idempotencyKey: "expense:EXP-WITHDRAW-ALLOWED:approve",
    taskId: otherTask.id,
    operatorId: "manager-1",
    action: "APPROVE",
  });
  const allowed = await permissive.facade.withdraw({
    idempotencyKey: "expense:EXP-WITHDRAW-ALLOWED:withdraw",
    instanceId: otherId,
    operatorId: "employee-1",
  });
  assert.equal(allowed.status, "WITHDRAWN");
});

test("applicant can withdraw after the flow was returned without an approval", async () => {
  const { facade, store } = createFixture();
  store.publish(await loadWorkflow());
  const instanceId = await startHighValueExpense(facade, "EXP-WITHDRAW-RETURNED");
  const managerTask = (await facade.getInstance(instanceId)).tasks[0]!;
  await facade.act({
    idempotencyKey: "expense:EXP-WITHDRAW-RETURNED:return",
    taskId: managerTask.id,
    operatorId: "manager-1",
    action: "REJECT_TO_APPLICANT",
  });

  const withdrawn = await facade.withdraw({
    idempotencyKey: "expense:EXP-WITHDRAW-RETURNED:withdraw",
    instanceId,
    operatorId: "employee-1",
  });
  assert.equal(withdrawn.status, "WITHDRAWN");
});

test("operator cancels a running instance with an audit event", async () => {
  const { facade, store } = createFixture();
  store.publish(await loadWorkflow());
  const instanceId = await startHighValueExpense(facade, "EXP-CANCEL");

  const canceled = await facade.cancel({
    idempotencyKey: "expense:EXP-CANCEL:cancel",
    instanceId,
    operatorId: "admin-1",
    reason: "重复单据",
  });
  assert.equal(canceled.status, "CANCELED");
  assert.ok(canceled.tasks.every((task) => task.status === "CANCELED"));
  const cancelEvent = store.readOutbox().find((item) => item.type === "approval.instance.canceled");
  assert.ok(cancelEvent);
  assert.deepEqual(cancelEvent!.data, { operatorId: "admin-1", reason: "重复单据" });
});
