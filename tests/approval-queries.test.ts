import assert from "node:assert/strict";
import test from "node:test";
import { createFixture, loadWorkflow } from "./helpers/approval-fixture.js";

test("business lookup returns the latest instance and supports status filters", async () => {
  const { facade, store } = createFixture();
  store.publish(await loadWorkflow());
  const command = {
    definitionKey: "expense-approval",
    business: { type: "expense", id: "EXP-BUSINESS" },
    applicantId: "employee-1",
    context: { amount: 6800 },
  };
  const first = await facade.start({ ...command, idempotencyKey: "expense:EXP-BUSINESS:start:1" });
  const second = await facade.start({ ...command, idempotencyKey: "expense:EXP-BUSINESS:start:2" });

  assert.notEqual(first.id, second.id);
  assert.equal((await facade.getInstanceByBusiness("expense", "EXP-BUSINESS")).id, second.id);
  assert.equal((await facade.getInstanceByBusiness("expense", "EXP-BUSINESS", "RUNNING")).id, second.id);
  assert.equal(await store.getInstanceByBusiness("expense", "EXP-BUSINESS", ["APPROVED"]), undefined);
});

test("task queries filter by business type and paginate with a stable cursor", async () => {
  const { facade, store } = createFixture();
  store.publish(await loadWorkflow());
  for (const id of ["EXP-TODO-1", "EXP-TODO-2", "EXP-TODO-3", "LEAVE-TODO-1"]) {
    await facade.start({
      idempotencyKey: `todo:${id}:start`,
      definitionKey: "expense-approval",
      business: { type: id.startsWith("EXP") ? "expense" : "leave", id },
      applicantId: "employee-1",
      context: { amount: 100 },
    });
  }

  const all = await facade.queryTasks({ assigneeId: "manager-1", limit: 2, orderBy: "CREATED_ASC" });
  assert.equal(all.tasks.length, 2);
  assert.ok(all.nextCursor);
  const rest = await facade.queryTasks({
    assigneeId: "manager-1",
    limit: 2,
    orderBy: "CREATED_ASC",
    cursor: all.nextCursor,
  });
  assert.equal(rest.tasks.length, 2);
  assert.equal(rest.nextCursor, undefined);
  assert.deepEqual(
    [...all.tasks, ...rest.tasks].map((task) => task.nodeId),
    ["manager_review", "manager_review", "manager_review", "manager_review"],
  );

  const expenses = await facade.queryTasks({ assigneeId: "manager-1", businessType: "expense" });
  assert.equal(expenses.tasks.length, 3);
  const legacy = await facade.listTasks("manager-1");
  assert.equal(legacy.length, 4);
});
