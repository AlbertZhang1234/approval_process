import {
  ApprovalEmailNotifier,
  DefaultEmailTemplateRenderer,
  evaluateCondition,
  parseWorkflowDefinition,
  validateWorkflow,
} from "../../dist/esm/index.js";
import { StaticOrganizationProvider } from "../../dist/esm/adapters/in-memory/index.js";
import { PEOPLE } from "./demo-runtime.mjs";
import {
  approvalWorkflow,
  command,
  createFixture,
  evidence,
  errorCode,
  expectError,
  result,
  step,
} from "./lab-helpers.mjs";
import {
  conflictRetryScenario,
  deadLetterScenario,
  queriesScenario,
  returnResubmitScenario,
  returnToNodeScenario,
  terminateScenario,
} from "./lab-lifecycle-scenarios.mjs";

async function allApprovalScenario() {
  const definition = approvalWorkflow({
    key: "lab-all-approval",
    name: "双人会签",
    mode: "ALL",
    assignees: [{ type: "ROLE", value: "finance-approver" }],
  });
  const { approval } = createFixture([definition]);
  const started = await approval.start(command(definition.key));
  const [firstTask, secondTask] = started.tasks;
  const afterFirst = await approval.act({
    idempotencyKey: "lab:all:first",
    taskId: firstTask.id,
    operatorId: firstTask.assigneeId,
    action: "APPROVE",
  });
  const completed = await approval.act({
    idempotencyKey: "lab:all:second",
    taskId: secondTask.id,
    operatorId: secondTask.assigneeId,
    action: "APPROVE",
  });
  const passed = started.tasks.length === 2 && afterFirst.status === "RUNNING" && completed.status === "APPROVED";
  return result("all-approval", "ALL 会签", passed, "两位审批人全部同意后才完成节点。", [
    step("创建会签任务", started.tasks.length === 2, `生成 ${started.tasks.length} 条待办`),
    step("第一人同意", afterFirst.status === "RUNNING", `实例保持 ${afterFirst.status}`),
    step("第二人同意", completed.status === "APPROVED", `实例变为 ${completed.status}`),
  ], [
    evidence("审批模式", "ALL"),
    evidence("实例版本", `v${started.version} → v${completed.version}`),
  ]);
}

async function idempotencyScenario() {
  const definition = approvalWorkflow({ key: "lab-idempotency" });
  const { approval } = createFixture([definition]);
  const startCommand = command(definition.key, "same-key", { amount: 100 });
  const first = await approval.start(startCommand);
  const repeated = await approval.start(startCommand);
  const conflict = await expectError(() => approval.start({ ...startCommand, context: { amount: 200 } }));
  const passed = first.id === repeated.id && conflict === "IDEMPOTENCY_CONFLICT";
  return result("idempotency", "幂等保护", passed, "相同命令复用结果，相同键不能代表另一条命令。", [
    step("重复提交", first.id === repeated.id, `两次均返回 ${first.id}`),
    step("摘要冲突", conflict === "IDEMPOTENCY_CONFLICT", conflict),
  ], [evidence("保存的实例数", "1")]);
}

async function conditionScenario() {
  const context = {
    amount: 6800,
    days: 5,
    department: { id: "sales" },
    priority: "high",
    optional: true,
  };
  const cases = [
    ["EQ", { field: "priority", operator: "EQ", value: "high" }, true],
    ["NE", { field: "priority", operator: "NE", value: "low" }, true],
    ["GT", { field: "days", operator: "GT", value: 3 }, true],
    ["GTE", { field: "amount", operator: "GTE", value: 6800 }, true],
    ["LT", { field: "days", operator: "LT", value: 10 }, true],
    ["LTE", { field: "days", operator: "LTE", value: 5 }, true],
    ["IN", { field: "priority", operator: "IN", value: ["high", "urgent"] }, true],
    ["NOT_IN", { field: "priority", operator: "NOT_IN", value: ["low"] }, true],
    ["EXISTS", { field: "optional", operator: "EXISTS" }, true],
    ["嵌套 all/any/not", {
      all: [
        { field: "department.id", operator: "EQ", value: "sales" },
        { any: [
          { field: "amount", operator: "GT", value: 5000 },
          { not: { field: "priority", operator: "EQ", value: "high" } },
        ] },
      ],
    }, true],
  ];
  const checks = cases.map(([label, condition, expected]) => {
    const actual = evaluateCondition(condition, context);
    return { label, actual, expected, passed: actual === expected };
  });
  const inherited = Object.create({ secret: "hidden" });
  const prototypeBlocked = !evaluateCondition({ field: "secret", operator: "EXISTS" }, inherited);
  return result("conditions", "结构化条件引擎", checks.every((item) => item.passed) && prototypeBlocked,
    "全部比较操作符、布尔组合、嵌套字段和原型链保护。",
    [...checks.map((item) => step(item.label, item.passed, String(item.actual))), step("原型链字段保护", prototypeBlocked, "继承字段不可读取")],
    [evidence("操作符覆盖", "9 / 9"), evidence("布尔组合", "all · any · not")]);
}

async function validationScenario() {
  const valid = approvalWorkflow({ key: "lab-valid-workflow" });
  validateWorkflow(valid);
  const cycle = structuredClone(valid);
  cycle.edges[1] = { id: "e_review_start", source: "review", target: "start" };
  const extraProperty = { ...structuredClone(valid), unsafeScript: "return true" };
  const malformed = { ...structuredClone(valid), version: "1" };
  const results = {
    cycle: await expectError(() => Promise.resolve(validateWorkflow(cycle))),
    extra: await expectError(() => Promise.resolve(parseWorkflowDefinition(extraProperty))),
    malformed: await expectError(() => Promise.resolve(parseWorkflowDefinition(malformed))),
  };
  const passed = Object.values(results).every((code) => code === "INVALID_WORKFLOW");
  return result("validation", "流程定义校验", passed, "发布前拒绝环路、未知字段和畸形外部数据。", [
    step("合法 DAG", true, "校验通过"),
    step("环路", results.cycle === "INVALID_WORKFLOW", results.cycle),
    step("未知脚本字段", results.extra === "INVALID_WORKFLOW", results.extra),
    step("错误版本类型", results.malformed === "INVALID_WORKFLOW", results.malformed),
  ], [evidence("节点类型", "START · APPROVAL · CONDITION · END")]);
}

async function assigneeScenario() {
  const policies = [
    ["USER", "special-1", {}],
    ["ROLE", "finance-approver", {}],
    ["DEPARTMENT_ROLE", "sales-manager", {}],
    ["MANAGER", "1", {}],
    ["REQUEST_FIELD", "reviewerId", { reviewerId: "special-1" }],
    ["PROVIDER", "risk-owner", {}],
  ];
  const checks = [];
  for (const [type, value, context] of policies) {
    const key = `lab-policy-${type.toLowerCase().replaceAll("_", "-")}`;
    const definition = approvalWorkflow({ key, assignees: [{ type, value }] });
    const { approval } = createFixture([definition]);
    const instance = await approval.start(command(key, key, context));
    checks.push({ type, assignees: instance.tasks.map((task) => task.assigneeId) });
  }
  const passed = checks.every((item) => item.assignees.length > 0);
  return result("assignees", "审批人解析策略", passed, "六种策略都通过 OrganizationProvider 边界解析为人员快照。",
    checks.map((item) => step(item.type, item.assignees.length > 0, item.assignees.join(", "))),
    [evidence("策略覆盖", `${checks.length} / 6`)]);
}

async function policyScenario() {
  const rows = [];
  const emptyOrganization = new StaticOrganizationProvider(() => []);
  for (const emptyPolicy of ["ERROR", "SKIP", "AUTO_APPROVE"]) {
    const key = `lab-empty-${emptyPolicy.toLowerCase().replaceAll("_", "-")}`;
    const definition = approvalWorkflow({ key, emptyAssigneePolicy: emptyPolicy });
    const { approval } = createFixture([definition], emptyOrganization);
    try {
      const instance = await approval.start(command(key));
      rows.push({ label: `无人审批 / ${emptyPolicy}`, actual: instance.status, ok: instance.status === "APPROVED" });
    } catch (error) {
      const code = errorCode(error);
      rows.push({ label: `无人审批 / ${emptyPolicy}`, actual: code, ok: emptyPolicy === "ERROR" && code === "ASSIGNEE_NOT_FOUND" });
    }
  }
  const selfOrganization = new StaticOrganizationProvider(() => ["employee-1"]);
  for (const selfPolicy of ["ALLOW", "SKIP", "REQUIRE_OTHER"]) {
    const key = `lab-self-${selfPolicy.toLowerCase().replaceAll("_", "-")}`;
    const definition = approvalWorkflow({
      key,
      selfApprovalPolicy: selfPolicy,
      emptyAssigneePolicy: "SKIP",
    });
    const { approval } = createFixture([definition], selfOrganization);
    try {
      const instance = await approval.start(command(key));
      const expected = selfPolicy === "ALLOW" ? "RUNNING" : "APPROVED";
      rows.push({ label: `本人审批 / ${selfPolicy}`, actual: instance.status, ok: instance.status === expected });
    } catch (error) {
      const code = errorCode(error);
      rows.push({ label: `本人审批 / ${selfPolicy}`, actual: code, ok: selfPolicy === "REQUIRE_OTHER" && code === "ASSIGNEE_NOT_FOUND" });
    }
  }
  return result("policies", "空审批人与本人审批", rows.every((row) => row.ok), "边界策略产生明确、可预测的运行结果。",
    rows.map((row) => step(row.label, row.ok, row.actual)),
    [evidence("无人策略", "ERROR · SKIP · AUTO_APPROVE"), evidence("本人策略", "ALLOW · SKIP · REQUIRE_OTHER")]);
}

async function guardScenario() {
  const definition = approvalWorkflow({ key: "lab-guards" });
  const { approval } = createFixture([definition]);
  const started = await approval.start(command(definition.key));
  const task = started.tasks[0];
  const forbidden = await expectError(() => approval.act({
    idempotencyKey: "lab:guard:forbidden",
    taskId: task.id,
    operatorId: "employee-2",
    action: "APPROVE",
  }));
  await approval.act({
    idempotencyKey: "lab:guard:valid",
    taskId: task.id,
    operatorId: task.assigneeId,
    action: "APPROVE",
  });
  const completed = await expectError(() => approval.act({
    idempotencyKey: "lab:guard:completed",
    taskId: task.id,
    operatorId: task.assigneeId,
    action: "APPROVE",
  }));
  const missingTask = await expectError(() => approval.act({
    idempotencyKey: "lab:guard:missing-task",
    taskId: "task-missing",
    operatorId: "manager-1",
    action: "APPROVE",
  }));
  const missingInstance = await expectError(() => approval.getInstance("instance-missing"));
  const rows = [
    ["越权处理", forbidden, "FORBIDDEN_TASK_ACTION"],
    ["重复处理已完成任务", completed, "TASK_NOT_PENDING"],
    ["未知任务", missingTask, "TASK_NOT_FOUND"],
    ["未知实例", missingInstance, "INSTANCE_NOT_FOUND"],
  ];
  return result("guards", "命令与权限保护", rows.every(([, actual, expected]) => actual === expected), "错误以稳定错误码暴露给宿主。",
    rows.map(([label, actual, expected]) => step(label, actual === expected, actual)),
    [evidence("错误类型", `${rows.length} 种`)]);
}

async function concurrencyScenario() {
  const definition = approvalWorkflow({ key: "lab-concurrency" });
  const { approval, store } = createFixture([definition]);
  const started = await approval.start(command(definition.key));
  const stale = await approval.getInstance(started.id);
  const task = started.tasks[0];
  const current = await approval.act({
    idempotencyKey: "lab:concurrency:approve",
    taskId: task.id,
    operatorId: task.assigneeId,
    action: "APPROVE",
  });
  const conflict = await expectError(() => store.save(stale, stale.version, "lab:stale-save", "stale", []));
  const passed = stale.version === 1 && current.version === 2 && conflict === "VERSION_CONFLICT";
  return result("concurrency", "乐观锁并发保护", passed, "过期实例无法覆盖已经提交的新版本。", [
    step("读取旧版本", stale.version === 1, `v${stale.version}`),
    step("正常审批提交", current.version === 2, `v${current.version}`),
    step("旧版本覆盖", conflict === "VERSION_CONFLICT", conflict),
  ], [evidence("版本推进", "v1 → v2")]);
}

async function notificationScenario() {
  const definition = approvalWorkflow({ key: "lab-notifications" });
  const { approval, store } = createFixture([definition]);
  const messages = [];
  const notifier = new ApprovalEmailNotifier(
    store,
    {
      getUserContact: (userId) => {
        const person = PEOPLE[userId];
        return Promise.resolve(person && { userId, displayName: person.name, email: person.email });
      },
    },
    new DefaultEmailTemplateRenderer(),
    { send: (message) => { messages.push(message); return Promise.resolve(); } },
  );
  const started = await approval.start({
    ...command(definition.key),
    business: { type: "expense", id: "EXP-SAFE", url: "javascript:alert(1)" },
  });
  for (const event of store.readOutbox()) await notifier.handle(event);
  const completed = await approval.act({
    idempotencyKey: "lab:notification:approve",
    taskId: started.tasks[0].id,
    operatorId: started.tasks[0].assigneeId,
    action: "APPROVE",
  });
  for (const event of store.readOutbox().slice(2)) await notifier.handle(event);
  const uniqueKeys = new Set(messages.map((message) => message.idempotencyKey));
  const unsafeLinkRemoved = messages.every((message) => !message.html.includes("javascript:") && !message.html.includes("href="));
  const passed = completed.status === "APPROVED" && messages.length === 2 && uniqueKeys.size === 2 && unsafeLinkRemoved;
  return result("notifications", "Outbox 邮件通知", passed, "待办与最终结果事件渲染为幂等、安全的邮件。", [
    step("待办邮件", messages.some((message) => message.subject.startsWith("待审批")), messages[0]?.subject ?? "未发送"),
    step("结果邮件", messages.some((message) => message.subject.startsWith("审批已通过")), messages[1]?.subject ?? "未发送"),
    step("危险链接过滤", unsafeLinkRemoved, "javascript: URL 未进入 HTML"),
  ], [evidence("邮件幂等键", `${uniqueKeys.size} 个且互不重复`)]);
}

async function historyScenario() {
  const versionOne = approvalWorkflow({ key: "lab-versioned", name: "规则 v1", version: 1 });
  const { approval, store } = createFixture([versionOne]);
  const first = await approval.start(command(versionOne.key, "version-1"));
  const versionTwo = approvalWorkflow({ key: "lab-versioned", name: "规则 v2", version: 2 });
  store.publish(versionTwo);
  const second = await approval.start(command(versionTwo.key, "version-2"));
  const firstAfterPublish = await approval.getInstance(first.id);
  const firstCompleted = await approval.act({
    idempotencyKey: "lab:version:first:approve",
    taskId: first.tasks[0].id,
    operatorId: first.tasks[0].assigneeId,
    action: "APPROVE",
  });
  const passed = firstAfterPublish.definitionVersion === 1 && second.definitionVersion === 2 && firstCompleted.transitions.length === 3;
  return result("history", "版本锁定与审计轨迹", passed, "运行实例保留启动时定义，并记录每次节点执行和迁移。", [
    step("旧实例版本锁定", firstAfterPublish.definitionVersion === 1, `仍为 v${firstAfterPublish.definitionVersion}`),
    step("新实例使用新版本", second.definitionVersion === 2, `使用 v${second.definitionVersion}`),
    step("执行历史", firstCompleted.executions.length === 3, `${firstCompleted.executions.length} 次节点执行`),
    step("迁移历史", firstCompleted.transitions.length === 3, `${firstCompleted.transitions.length} 条迁移`),
  ], [evidence("上下文修订", `revision ${firstCompleted.contextRevision}`)]);
}

export const LAB_SCENARIOS = [
  { id: "all-approval", title: "ALL 会签", description: "全部审批人通过才推进", run: allApprovalScenario },
  { id: "idempotency", title: "幂等保护", description: "重复请求复用与冲突检测", run: idempotencyScenario },
  { id: "conditions", title: "条件引擎", description: "9 种操作符和布尔组合", run: conditionScenario },
  { id: "validation", title: "定义校验", description: "DAG、字段与外部数据保护", run: validationScenario },
  { id: "assignees", title: "审批人策略", description: "六类组织架构解析策略", run: assigneeScenario },
  { id: "policies", title: "边界策略", description: "无人审批和本人审批规则", run: policyScenario },
  { id: "guards", title: "命令保护", description: "权限、状态与资源错误", run: guardScenario },
  { id: "concurrency", title: "乐观锁", description: "拒绝过期版本覆盖", run: concurrencyScenario },
  { id: "notifications", title: "邮件通知", description: "Outbox、幂等键与安全模板", run: notificationScenario },
  { id: "history", title: "版本与审计", description: "定义快照、执行和迁移历史", run: historyScenario },
  { id: "return-resubmit", title: "退回重提", description: "退回申请人、修改上下文重新提交", run: returnResubmitScenario },
  { id: "return-to-node", title: "退回指定节点", description: "新轮次执行与目标校验", run: returnToNodeScenario },
  { id: "terminate", title: "撤回与取消", description: "申请人撤回和管理员取消", run: terminateScenario },
  { id: "queries", title: "反查与分页", description: "业务反查实例、待办分页", run: queriesScenario },
  { id: "dead-letter", title: "死信与重投", description: "重试上限、死信重置", run: deadLetterScenario },
  { id: "conflict-retry", title: "并发自动重试", description: "乐观锁冲突读-重放", run: conflictRetryScenario },
];

export async function runLabScenario(id) {
  const scenario = LAB_SCENARIOS.find((candidate) => candidate.id === id);
  if (scenario === undefined) return undefined;
  return scenario.run();
}
