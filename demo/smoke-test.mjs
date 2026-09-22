import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createDemoRuntime } from "./lib/demo-runtime.mjs";
import { LAB_SCENARIOS, runLabScenario } from "./lib/lab-scenarios.mjs";

const projectDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtime = await createDemoRuntime(projectDirectory);
const sleep = (ms) => new Promise((wait) => setTimeout(wait, ms));

async function drainOutbox() {
  let processed = 0;
  for (let round = 0; round < 10; round += 1) {
    const count = await runtime.processOutbox();
    processed += count;
    if (count === 0) break;
  }
  return processed;
}

// 1. 基础流转：发起 → 经理同意 → 财务驳回（终止语义）
const expense = await runtime.approval.start({
  idempotencyKey: "smoke:expense:start",
  definitionKey: "expense-approval",
  business: { type: "expense", id: "EXP-SMOKE", url: "/expenses/EXP-SMOKE" },
  applicantId: "employee-1",
  context: { amount: 6800 },
});
runtime.instanceIds.push(expense.id);
await drainOutbox();
assert.equal(expense.tasks[0]?.assigneeId, "manager-1");

const afterManager = await runtime.approval.act({
  idempotencyKey: "smoke:expense:manager",
  taskId: expense.tasks[0].id,
  operatorId: "manager-1",
  action: "APPROVE",
});
await drainOutbox();
const financeTasks = afterManager.tasks.filter((task) => task.nodeId === "finance_review");
assert.equal(financeTasks.length, 2);

const rejected = await runtime.approval.act({
  idempotencyKey: "smoke:expense:finance",
  taskId: financeTasks[0].id,
  operatorId: financeTasks[0].assigneeId,
  action: "REJECT",
  comment: "冒烟测试驳回",
});
await drainOutbox();
assert.equal(rejected.status, "REJECTED");
assert.equal(rejected.tasks.find((task) => task.id === financeTasks[1].id)?.status, "CANCELED");

const state = await runtime.readState();
assert.equal(state.inbox.length, 0);
assert.equal(state.events.length, 7);
assert.equal(state.emails.length, 4);
assert.ok(state.outbox.every((record) => record.status === "PROCESSED"));

// 2. 退回申请人 → 修改上下文重新提交 → 通过
const returned = await runtime.approval.start({
  idempotencyKey: "smoke:return:start",
  definitionKey: "expense-approval",
  business: { type: "expense", id: "EXP-RETURN-SMOKE" },
  applicantId: "employee-1",
  context: { amount: 6800 },
});
runtime.instanceIds.push(returned.id);
await runtime.approval.act({
  idempotencyKey: "smoke:return:manager",
  taskId: returned.tasks[0].id,
  operatorId: "manager-1",
  action: "APPROVE",
});
const afterManager2 = await runtime.approval.getInstance(returned.id);
const sentBack = await runtime.approval.act({
  idempotencyKey: "smoke:return:finance-back",
  taskId: afterManager2.tasks.find((task) => task.status === "PENDING").id,
  operatorId: "finance-1",
  action: "REJECT_TO_APPLICANT",
  comment: "发票有误",
});
assert.equal(sentBack.status, "RUNNING");
assert.equal(sentBack.transitions.at(-1)?.type, "RETURN");
const resubmitted = await runtime.approval.updateContext({
  idempotencyKey: "smoke:return:resubmit",
  instanceId: returned.id,
  operatorId: "employee-1",
  context: { amount: 200 },
  comment: "已更换发票",
});
assert.equal(resubmitted.contextRevision, 2);
assert.equal(resubmitted.transitions.at(-1)?.type, "RESUBMIT");
const completed = await runtime.approval.act({
  idempotencyKey: "smoke:return:manager-2",
  taskId: resubmitted.tasks.find((task) => task.status === "PENDING").id,
  operatorId: "manager-1",
  action: "APPROVE",
});
assert.equal(completed.status, "APPROVED");

// 3. 退回指定节点
const nodeFlow = await runtime.approval.start({
  idempotencyKey: "smoke:node:start",
  definitionKey: "expense-approval",
  business: { type: "expense", id: "EXP-NODE-SMOKE" },
  applicantId: "employee-1",
  context: { amount: 6800 },
});
runtime.instanceIds.push(nodeFlow.id);
await runtime.approval.act({
  idempotencyKey: "smoke:node:manager",
  taskId: nodeFlow.tasks[0].id,
  operatorId: "manager-1",
  action: "APPROVE",
});
const nodeFlowAfterManager = await runtime.approval.getInstance(nodeFlow.id);
const backToNode = await runtime.approval.act({
  idempotencyKey: "smoke:node:back",
  taskId: nodeFlowAfterManager.tasks.find((task) => task.status === "PENDING").id,
  operatorId: "finance-1",
  action: "RETURN_TO_NODE",
  targetNodeId: "manager_review",
});
assert.equal(backToNode.executions.filter((execution) => execution.nodeId === "manager_review").length, 2);

// 4. 撤回与取消
const withdrawn = await runtime.approval.start({
  idempotencyKey: "smoke:withdraw:start",
  definitionKey: "expense-approval",
  business: { type: "expense", id: "EXP-WITHDRAW-SMOKE" },
  applicantId: "employee-1",
  context: { amount: 100 },
});
runtime.instanceIds.push(withdrawn.id);
const withdrawnInstance = await runtime.approval.withdraw({
  idempotencyKey: "smoke:withdraw:action",
  instanceId: withdrawn.id,
  operatorId: "employee-1",
  reason: "误提交",
});
assert.equal(withdrawnInstance.status, "WITHDRAWN");
const canceled = await runtime.approval.start({
  idempotencyKey: "smoke:cancel:start",
  definitionKey: "expense-approval",
  business: { type: "expense", id: "EXP-CANCEL-SMOKE" },
  applicantId: "employee-1",
  context: { amount: 100 },
});
runtime.instanceIds.push(canceled.id);
const canceledInstance = await runtime.approval.cancel({
  idempotencyKey: "smoke:cancel:action",
  instanceId: canceled.id,
  operatorId: "manager-1",
  reason: "重复单据",
});
assert.equal(canceledInstance.status, "CANCELED");
await drainOutbox();

// 5. 业务反查 + 待办分页
const latest = await runtime.store.getInstanceByBusiness("expense", "EXP-RETURN-SMOKE");
assert.equal(latest?.status, "APPROVED");
const page1 = await runtime.approval.queryTasks({ assigneeId: "manager-1", limit: 2, businessType: "expense" });
assert.ok(page1.tasks.length <= 2);
if (page1.nextCursor !== undefined) {
  const page2 = await runtime.approval.queryTasks({
    assigneeId: "manager-1",
    limit: 2,
    cursor: page1.nextCursor,
  });
  assert.ok(!page2.tasks.some((task) => task.id === page1.tasks[0]?.id));
}

// 6. Outbox Worker 毒消息 → 死信 → 重置重投
runtime.setOutboxPoisonMode(true);
const poison = await runtime.approval.start({
  idempotencyKey: "smoke:poison:start",
  definitionKey: "expense-approval",
  business: { type: "expense", id: "EXP-POISON-SMOKE" },
  applicantId: "employee-1",
  context: { amount: 100 },
});
runtime.instanceIds.push(poison.id);
for (let attempt = 0; attempt < 3; attempt += 1) {
  await drainOutbox();
  if (attempt < 2) await sleep(1_100);
}
const dead = await runtime.store.listDeadOutboxEvents(10);
assert.equal(dead.length, 1);
assert.equal(dead[0].attempts, 3);
runtime.setOutboxPoisonMode(false);
await runtime.resetDeadOutboxEvent(dead[0].event.id, new Date().toISOString());
await drainOutbox();
const finalState = await runtime.readState();
assert.ok(finalState.outboxDead.length === 0 || finalState.outboxDead.every((item) => item.event.id !== dead[0].event.id));
assert.ok(finalState.outboxIncidents.some((incident) => incident.eventId === dead[0].event.id));

// 7. 配置中心与自定义流程
const configuration = runtime.readConfiguration();
assert.deepEqual(configuration.catalogs.approvalModes, ["ANY", "ALL"]);
assert.equal(configuration.catalogs.assigneePolicyTypes.length, 6);

const customWorkflow = {
  key: "smoke-custom-approval",
  name: "冒烟自定义审批",
  version: 1,
  description: "验证配置发布后可立即发起业务",
  nodes: [
    { id: "start", name: "开始", type: "START" },
    {
      id: "review",
      name: "动态审批人",
      type: "APPROVAL",
      config: {
        mode: "ANY",
        assignees: [{ type: "REQUEST_FIELD", value: "reviewerId" }],
        emptyAssigneePolicy: "ERROR",
        selfApprovalPolicy: "REQUIRE_OTHER",
      },
    },
    { id: "approved_end", name: "通过", type: "END" },
  ],
  edges: [
    { id: "e_start_review", source: "start", target: "review" },
    { id: "e_review_end", source: "review", target: "approved_end" },
  ],
};
runtime.publishWorkflow(customWorkflow);
const customInstance = await runtime.approval.start({
  idempotencyKey: "smoke:custom:start",
  definitionKey: customWorkflow.key,
  business: { type: "custom", id: "CUSTOM-SMOKE" },
  applicantId: "employee-1",
  context: { reviewerId: "special-1" },
});
assert.equal(customInstance.tasks[0]?.assigneeId, "special-1");

const updatedConfig = structuredClone(runtime.settings);
updatedConfig.notifications.taskCreated = false;
updatedConfig.notifications.finalResult = false;
runtime.updateHostConfig(updatedConfig);
const beforeEmails = runtime.emails.length;
await drainOutbox();
assert.equal(runtime.emails.length, beforeEmails);
assert.equal(runtime.readConfiguration().audit[0]?.type, "host-config.updated");

// 8. 全部能力实验
for (const scenario of LAB_SCENARIOS) {
  const result = await runLabScenario(scenario.id);
  assert.ok(result?.passed, `${scenario.id} did not pass`);
}

console.log(`Demo smoke test passed: lifecycle flows + outbox dead letter + ${LAB_SCENARIOS.length} capability labs.`);
