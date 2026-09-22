import assert from "node:assert/strict";

const baseUrl = process.env.DEMO_URL ?? "http://127.0.0.1:4173";
const sleep = (ms) => new Promise((wait) => setTimeout(wait, ms));

async function request(path, options) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...options?.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
  return body;
}

await request("/api/reset", { method: "POST", body: "{}" });
const config = await request("/api/config");
assert.equal(config.catalogs.assigneePolicyTypes.length, 6);
assert.equal(Object.keys(config.runtime).length, 8);

const savedConfig = await request("/api/config/host", {
  method: "PUT",
  body: JSON.stringify({ config: config.host }),
});
assert.equal(savedConfig.audit[0]?.type, "host-config.updated");

const definition = {
  key: "configured-api-demo",
  name: "配置 API 演示",
  version: 1,
  description: "配置发布后立即发起业务",
  nodes: [
    { id: "start", name: "开始", type: "START" },
    {
      id: "review",
      name: "动态审批",
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
const published = await request("/api/config/workflows/publish", {
  method: "POST",
  body: JSON.stringify({ definition }),
});
assert.equal(published.workflow.key, definition.key);

const started = await request("/api/instances", {
  method: "POST",
  body: JSON.stringify({
    workflowKey: definition.key,
    businessId: "CFG-E2E-001",
    applicantId: "employee-1",
    businessType: "configured",
    context: { reviewerId: "special-1", amount: 1200 },
  }),
});
assert.equal(started.status, "RUNNING");
assert.equal(started.tasks[0]?.assigneeId, "special-1");

const state = await request("/api/state");
assert.ok(state.workflows.some((workflow) => workflow.key === definition.key));
assert.equal(state.emails.length, 1);
assert.ok(state.outbox.every((record) => record.status === "PROCESSED"));

// 退回申请人 → 修改上下文重新提交
const expense = await request("/api/instances", {
  method: "POST",
  body: JSON.stringify({
    workflowKey: "expense-approval",
    businessId: "EXP-API-RETURN",
    applicantId: "employee-1",
    value: 6800,
  }),
});
await request(`/api/tasks/${expense.tasks[0].id}/actions`, {
  method: "POST",
  body: JSON.stringify({ operatorId: "manager-1", action: "APPROVE" }),
});
const expenseAfterManager = await request(`/api/instances/by-business?businessType=expense&businessId=EXP-API-RETURN`);
assert.equal(expenseAfterManager.found, true);
const financeTask = expenseAfterManager.instance.tasks.find((task) => task.status === "PENDING");
const returned = await request(`/api/tasks/${financeTask.id}/actions`, {
  method: "POST",
  body: JSON.stringify({ operatorId: financeTask.assigneeId, action: "REJECT_TO_APPLICANT", comment: "发票有误" }),
});
assert.equal(returned.status, "RUNNING");
const resubmitted = await request(`/api/instances/${expense.id}/context`, {
  method: "POST",
  body: JSON.stringify({ operatorId: "employee-1", value: 200, comment: "已修改" }),
});
assert.equal(resubmitted.contextRevision, 2);
const managerRound2 = resubmitted.tasks.find((task) => task.status === "PENDING");
const approved = await request(`/api/tasks/${managerRound2.id}/actions`, {
  method: "POST",
  body: JSON.stringify({ operatorId: "manager-1", action: "APPROVE" }),
});
assert.equal(approved.status, "APPROVED");

// 退回指定节点 + 撤回 + 取消
const nodeFlow = await request("/api/instances", {
  method: "POST",
  body: JSON.stringify({
    workflowKey: "expense-approval",
    businessId: "EXP-API-NODE",
    applicantId: "employee-2",
    value: 6800,
  }),
});
await request(`/api/tasks/${nodeFlow.tasks[0].id}/actions`, {
  method: "POST",
  body: JSON.stringify({ operatorId: "manager-1", action: "APPROVE" }),
});
const nodeAfterManager = await request(`/api/instances/${nodeFlow.id}`);
const nodeFinanceTask = nodeAfterManager.tasks.find((task) => task.status === "PENDING");
const backToNode = await request(`/api/tasks/${nodeFinanceTask.id}/actions`, {
  method: "POST",
  body: JSON.stringify({
    operatorId: nodeFinanceTask.assigneeId,
    action: "RETURN_TO_NODE",
    targetNodeId: "manager_review",
  }),
});
assert.equal(backToNode.executions.filter((execution) => execution.nodeId === "manager_review").length, 2);

const toWithdraw = await request("/api/instances", {
  method: "POST",
  body: JSON.stringify({
    workflowKey: "expense-approval",
    businessId: "EXP-API-WITHDRAW",
    applicantId: "employee-1",
    value: 100,
  }),
});
const withdrawn = await request(`/api/instances/${toWithdraw.id}/withdraw`, {
  method: "POST",
  body: JSON.stringify({ operatorId: "employee-1", reason: "误提交" }),
});
assert.equal(withdrawn.status, "WITHDRAWN");
const toCancel = await request("/api/instances", {
  method: "POST",
  body: JSON.stringify({
    workflowKey: "expense-approval",
    businessId: "EXP-API-CANCEL",
    applicantId: "employee-1",
    value: 100,
  }),
});
const canceled = await request(`/api/instances/${toCancel.id}/cancel`, {
  method: "POST",
  body: JSON.stringify({ operatorId: "manager-1", reason: "重复单据" }),
});
assert.equal(canceled.status, "CANCELED");

// 分页待办 + 状态过滤反查
const taskPage = await request(
  "/api/tasks?assigneeId=manager-1&status=PENDING&businessType=expense&limit=2&orderBy=CREATED_DESC",
);
assert.ok(taskPage.tasks.length <= 2);
const runningOnly = await request(
  "/api/instances/by-business?businessType=expense&businessId=EXP-API-RETURN&status=APPROVED",
);
assert.equal(runningOnly.instance?.status, "APPROVED");

// Outbox Worker：毒消息 → 死信 → 重置重投
await request("/api/outbox/poison", { method: "POST", body: JSON.stringify({ enabled: true }) });
const poison = await request("/api/instances", {
  method: "POST",
  body: JSON.stringify({
    workflowKey: "expense-approval",
    businessId: "EXP-API-POISON",
    applicantId: "employee-1",
    value: 100,
  }),
});
for (let round = 0; round < 3; round += 1) {
  await request("/api/outbox/worker/run", { method: "POST", body: "{}" });
  if (round < 2) await sleep(1_150);
}
const deadList = await request("/api/outbox/dead");
assert.equal(deadList.events.length, 1);
assert.equal(deadList.events[0].event.business.id, "EXP-API-POISON");
await request("/api/outbox/poison", { method: "POST", body: JSON.stringify({ enabled: false }) });
await request(`/api/outbox/dead/${deadList.events[0].event.id}/reset`, { method: "POST", body: "{}" });
await request("/api/outbox/worker/run", { method: "POST", body: "{}" });
const finalState = await request("/api/state");
assert.ok(!finalState.outboxDead.some((item) => item.event.id === deadList.events[0].event.id));
assert.equal(poison.status, "RUNNING");

console.log("API smoke test passed: config -> publish -> lifecycle (return/resubmit/withdraw/cancel) -> queries -> outbox dead letter.");
