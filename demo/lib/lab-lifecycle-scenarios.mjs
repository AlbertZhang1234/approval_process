import { ApprovalError, createApprovalModule, createOutboxWorker } from "../../dist/esm/index.js";
import { InMemoryApprovalStore } from "../../dist/esm/adapters/in-memory/index.js";
import { createDemoOrganizationProvider } from "./demo-runtime.mjs";
import {
  approvalWorkflow,
  command,
  createFixture,
  evidence,
  expectError,
  result,
  step,
} from "./lab-helpers.mjs";

function managerFinanceWorkflow() {
  return {
    key: "lab-manager-finance",
    name: "经理 + 财务",
    version: 1,
    nodes: [
      { id: "start", type: "START", name: "开始" },
      {
        id: "manager_review",
        type: "APPROVAL",
        name: "经理审批",
        config: {
          mode: "ANY",
          assignees: [{ type: "USER", value: "manager-1" }],
          emptyAssigneePolicy: "ERROR",
          selfApprovalPolicy: "REQUIRE_OTHER",
        },
      },
      { id: "amount_gate", type: "CONDITION", name: "金额判断" },
      {
        id: "finance_review",
        type: "APPROVAL",
        name: "财务审批",
        config: {
          mode: "ANY",
          assignees: [{ type: "ROLE", value: "finance-approver" }],
          emptyAssigneePolicy: "ERROR",
          selfApprovalPolicy: "REQUIRE_OTHER",
        },
      },
      { id: "approved_end", type: "END", name: "通过" },
    ],
    edges: [
      { id: "e_start_manager", source: "start", target: "manager_review" },
      { id: "e_manager_gate", source: "manager_review", target: "amount_gate" },
      {
        id: "e_gate_finance",
        source: "amount_gate",
        target: "finance_review",
        priority: 10,
        condition: { field: "amount", operator: "GTE", value: 5000 },
      },
      { id: "e_gate_end", source: "amount_gate", target: "approved_end", default: true },
      { id: "e_finance_end", source: "finance_review", target: "approved_end" },
    ],
  };
}

async function startHighValue(approval, suffix) {
  return approval.start(command("lab-manager-finance", suffix, { amount: 6800 }));
}

export async function returnResubmitScenario() {
  const { approval } = createFixture([managerFinanceWorkflow()]);
  const started = await startHighValue(approval, "return-start");
  await approval.act({
    idempotencyKey: "lab:return:manager",
    taskId: started.tasks[0].id,
    operatorId: "manager-1",
    action: "APPROVE",
  });
  const afterManager = await approval.getInstance(started.id);
  const financeTask = afterManager.tasks.find((task) => task.status === "PENDING");
  const returned = await approval.act({
    idempotencyKey: "lab:return:finance",
    taskId: financeTask.id,
    operatorId: financeTask.assigneeId,
    action: "REJECT_TO_APPLICANT",
    comment: "发票有误",
  });
  const startRound2 = returned.executions.find((execution) => execution.nodeId === "start" && execution.round === 2);
  const resubmitted = await approval.updateContext({
    idempotencyKey: "lab:return:resubmit",
    instanceId: started.id,
    operatorId: "employee-1",
    context: { amount: 200 },
  });
  const managerTask2 = resubmitted.tasks.find((task) => task.status === "PENDING");
  const completed = await approval.act({
    idempotencyKey: "lab:return:manager-2",
    taskId: managerTask2.id,
    operatorId: "manager-1",
    action: "APPROVE",
  });
  const passed = returned.status === "RUNNING"
    && startRound2?.status === "ACTIVE"
    && resubmitted.contextRevision === 2
    && completed.status === "APPROVED";
  return result("return-resubmit", "退回重提", passed, "退回申请人后修改上下文，revision 递增并按新值重新路由。", [
    step("退回后保持 RUNNING", returned.status === "RUNNING", `实例状态 ${returned.status}`),
    step("START 进入第 2 轮", startRound2?.round === 2, `round ${startRound2?.round}`),
    step("重新提交递增修订", resubmitted.contextRevision === 2, `revision ${resubmitted.contextRevision}`),
    step("低额直接通过", completed.status === "APPROVED", `最终状态 ${completed.status}`),
  ], [
    evidence("退回轨迹", returned.transitions.at(-1)?.type ?? "无"),
    evidence("重提轨迹", resubmitted.transitions.at(-1)?.type ?? "无"),
  ]);
}

export async function returnToNodeScenario() {
  const { approval } = createFixture([managerFinanceWorkflow()]);
  const started = await startHighValue(approval, "return-node");
  await approval.act({
    idempotencyKey: "lab:return-node:manager",
    taskId: started.tasks[0].id,
    operatorId: "manager-1",
    action: "APPROVE",
  });
  const afterManager = await approval.getInstance(started.id);
  const financeTask = afterManager.tasks.find((task) => task.status === "PENDING");
  const invalidTarget = await expectError(() => approval.act({
    idempotencyKey: "lab:return-node:invalid",
    taskId: financeTask.id,
    operatorId: financeTask.assigneeId,
    action: "RETURN_TO_NODE",
    targetNodeId: "start",
  }));
  const returned = await approval.act({
    idempotencyKey: "lab:return-node:back",
    taskId: financeTask.id,
    operatorId: financeTask.assigneeId,
    action: "RETURN_TO_NODE",
    targetNodeId: "manager_review",
    comment: "请补充预算",
  });
  const managerTask2 = returned.tasks.find((task) => task.status === "PENDING");
  const completed = await approval.act({
    idempotencyKey: "lab:return-node:manager-2",
    taskId: managerTask2.id,
    operatorId: "manager-1",
    action: "APPROVE",
  });
  const managerRounds = completed.executions.filter((execution) => execution.nodeId === "manager_review").length;
  const passed = invalidTarget === "INVALID_RETURN_TARGET"
    && managerTask2.status === "PENDING"
    && managerRounds === 2
    && completed.status === "RUNNING";
  return result("return-to-node", "退回指定节点", passed, "退回到已到过的审批节点并开启新轮次，非法目标被拒绝。", [
    step("非审批节点目标被拒", invalidTarget === "INVALID_RETURN_TARGET", invalidTarget),
    step("经理节点第 2 轮", managerRounds === 2, `${managerRounds} 轮执行`),
    step("新一轮待办待处理", managerTask2.status === "PENDING", "新轮次任务已生成"),
    step("流程继续运行", completed.status === "RUNNING", `实例状态 ${completed.status}`),
  ], [evidence("退回轨迹", returned.transitions.at(-1)?.type ?? "无")]);
}

export async function terminateScenario() {
  const definition = approvalWorkflow({ key: "lab-terminate" });
  const { approval } = createFixture([definition]);
  const withdrawable = await approval.start(command(definition.key, "withdraw"));
  const notApplicant = await expectError(() => approval.withdraw({
    idempotencyKey: "lab:terminate:not-applicant",
    instanceId: withdrawable.id,
    operatorId: "manager-1",
  }));
  const withdrawn = await approval.withdraw({
    idempotencyKey: "lab:terminate:withdraw",
    instanceId: withdrawable.id,
    operatorId: "employee-1",
    reason: "误提交",
  });
  const withdrawAgain = await expectError(() => approval.withdraw({
    idempotencyKey: "lab:terminate:withdraw-again",
    instanceId: withdrawable.id,
    operatorId: "employee-1",
  }));
  const toCancel = await approval.start(command(definition.key, "cancel"));
  const canceled = await approval.cancel({
    idempotencyKey: "lab:terminate:cancel",
    instanceId: toCancel.id,
    operatorId: "manager-1",
    reason: "测试作废",
  });
  const passed = notApplicant === "FORBIDDEN_INSTANCE_ACTION"
    && withdrawn.status === "WITHDRAWN"
    && withdrawAgain === "INVALID_INSTANCE_STATE"
    && canceled.status === "CANCELED";
  return result("terminate", "撤回与取消", passed, "申请人撤回有身份和状态保护；管理员取消可作废运行中的实例。", [
    step("仅申请人可撤回", notApplicant === "FORBIDDEN_INSTANCE_ACTION", notApplicant),
    step("撤回成功", withdrawn.status === "WITHDRAWN", `状态 ${withdrawn.status}`),
    step("撤回后不可重复", withdrawAgain === "INVALID_INSTANCE_STATE", withdrawAgain),
    step("取消运行实例", canceled.status === "CANCELED", `状态 ${canceled.status}`),
  ], [evidence("终态状态", "WITHDRAWN / CANCELED")]);
}

export async function queriesScenario() {
  const { approval, store } = createFixture([managerFinanceWorkflow()]);
  const business = { type: "expense", id: "EXP-QUERY" };
  const withdrawn = new Set(["q4", "q5"]);
  for (const suffix of ["q1", "q2", "q3", "q4", "q5"]) {
    const instance = await approval.start({
      ...command("lab-manager-finance", suffix, { amount: 100 }),
      business: structuredClone(business),
    });
    if (withdrawn.has(suffix)) {
      await approval.withdraw({
        idempotencyKey: `lab:queries:withdraw:${suffix}`,
        instanceId: instance.id,
        operatorId: "employee-1",
      });
    }
  }
  const latest = await store.getInstanceByBusiness("expense", "EXP-QUERY");
  const running = await store.getInstanceByBusiness("expense", "EXP-QUERY", "RUNNING");
  const page1 = await approval.queryTasks({ assigneeId: "manager-1", status: "PENDING", limit: 2, businessType: "expense" });
  const page2 = await approval.queryTasks({ assigneeId: "manager-1", status: "PENDING", limit: 2, cursor: page1.nextCursor });
  const order = await approval.queryTasks({ assigneeId: "manager-1", status: "PENDING", orderBy: "CREATED_ASC" });
  const passed = latest !== undefined
    && running?.id !== latest?.id
    && page1.tasks.length === 2
    && page1.nextCursor !== undefined
    && page2.tasks.length === 1
    && order.tasks.length === 3;
  return result("queries", "反查与分页待办", passed, "业务单据定位最新实例；待办支持业务类型过滤与稳定游标分页。", [
    step("反查最新实例", latest !== undefined, latest?.id ?? "未找到"),
    step("状态过滤生效", running?.id !== latest?.id, running?.id ?? "无运行实例"),
    step("第一页 2 条", page1.tasks.length === 2, `${page1.tasks.length} 条`),
    step("第二页 1 条", page2.tasks.length === 1, `${page2.tasks.length} 条`),
    step("业务类型 + 状态过滤", order.tasks.length === 3, `${order.tasks.length} 条`),
  ], [
    evidence("游标", page1.nextCursor === undefined ? "无" : "createdAt + id"),
    evidence("分页语义", "keyset"),
  ]);
}

export async function deadLetterScenario() {
  const definition = approvalWorkflow({ key: "lab-dead-letter" });
  const { store, approval } = createFixture([definition]);
  await approval.start(command(definition.key));
  const seen = [];
  const failures = [];
  const worker = createOutboxWorker({
    store,
    workerId: "lab-worker",
    maxAttempts: 2,
    retryDelayMs: () => 0,
    handler: async (event) => {
      seen.push(event.id);
      if (event.type === "approval.task.created") {
        failures.push(event.id);
        throw new Error("联系人服务不可用");
      }
    },
  });
  await worker.runOnce();
  await worker.runOnce();
  const dead = await store.listDeadOutboxEvents(10);
  const attemptsBeforeRequeue = seen.length;
  const failuresBeforeRequeue = failures.length;
  await store.resetDeadOutboxEvent({ eventId: dead[0].event.id, retryAt: new Date().toISOString() });
  const requeued = await worker.runOnce();
  const passed = failuresBeforeRequeue === 2 && dead.length === 1 && dead[0].attempts === 2 && requeued === 1;
  return result("dead-letter", "死信与重投", passed, "达到重试上限进入 DEAD，重置后重新投递。", [
    step("毒消息两次失败", failuresBeforeRequeue === 2, `失败 ${failuresBeforeRequeue} 次后进入死信`),
    step("标记死信", dead.length === 1 && dead[0].attempts === 2, `attempts ${dead[0]?.attempts}`),
    step("重置后可重投", requeued === 1, `重新领取 ${requeued} 个`),
  ], [
    evidence("重试上限", "maxAttempts = 2"),
    evidence("死信状态", "DEAD → reset → PENDING"),
  ]);
}

class FlakyConflictStore extends InMemoryApprovalStore {
  constructor() {
    super();
    this.conflictsRemaining = 2;
  }

  async save(instance, expectedVersion, idempotencyKey, fingerprint, events, operationType) {
    if (this.conflictsRemaining > 0) {
      this.conflictsRemaining -= 1;
      throw new ApprovalError("VERSION_CONFLICT", "模拟并发冲突");
    }
    return super.save(instance, expectedVersion, idempotencyKey, fingerprint, events, operationType);
  }
}

export async function conflictRetryScenario() {
  const definition = approvalWorkflow({ key: "lab-conflict-retry" });
  const store = new FlakyConflictStore();
  store.publish(definition);
  const approval = createApprovalModule({
    store,
    organizationProvider: createDemoOrganizationProvider(),
  });
  const started = await approval.start(command(definition.key));
  const completed = await approval.act({
    idempotencyKey: "lab:conflict-retry:approve",
    taskId: started.tasks[0].id,
    operatorId: started.tasks[0].assigneeId,
    action: "APPROVE",
  });
  const passed = completed.status === "APPROVED" && store.conflictsRemaining === 0;
  return result("conflict-retry", "会签并发自动重试", passed, "act 遇到 VERSION_CONFLICT 时读-重放，幂等键保证安全。", [
    step("两次冲突后成功", completed.status === "APPROVED", `最终状态 ${completed.status}`),
    step("重试预算耗尽", store.conflictsRemaining === 0, "2 次冲突均已重放"),
  ], [evidence("默认重试", "3 次")]);
}
