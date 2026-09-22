# 通用审批流框架

这是一个面向报销、请假及其他审批场景的 TypeScript 嵌入式审批模块。审批核心不依赖 Web 框架，可直接嵌入 Node.js 应用；Next.js、NestJS 等框架通过宿主适配层装配。

## 当前实现

- 数据库草稿、发布校验、不可变版本和运行实例版本锁定；
- 安全的结构化条件判断；
- 审批人解析端口；
- `ANY` 或签和 `ALL` 会签；
- 同意、驳回、退回申请人、退回指定节点，以及退回后修改上下文重新提交（`contextRevision` 递增、`RETURN`/`RESUBMIT` 迁移轨迹）；
- 申请人撤回与管理员取消，含可配置的“已处理后是否允许撤回”策略；
- 幂等请求和乐观锁存储契约；审批动作内置有限的乐观锁冲突自动重试；
- Supabase Data API（测试/联调）与 Direct PostgreSQL（生产）双适配入口；
- 事务 Outbox 事件，以及多 Worker 领取、成功确认和失败重试契约；
- 可复用的 Outbox Worker（领取 → 处理 → 确认 / 退避重试 / 达到上限进入死信），死信查询与重置；
- 按业务单据反查最新审批实例，统一待办按业务类型过滤、稳定游标分页和排序；
- 邮件联系人、模板和发送端口，以及默认安全转义模板；
- 供测试和演示使用的内存适配器。

## 在任意 Node.js 项目中使用

包同时提供 ESM、CommonJS 和 TypeScript 类型声明，要求 Node.js 20.9 或更高版本，不依赖任何 Web 框架或 ORM。

```ts
import { createApprovalModule } from "@approval-flow/core";

const approval = createApprovalModule({
  store: approvalStore,
  organizationProvider,
});

const instance = await approval.start({
  idempotencyKey: "expense:EXP-001:submit:1",
  definitionKey: "expense-approval",
  business: { type: "expense", id: "EXP-001", url: "/expenses/EXP-001" },
  applicantId: currentUser.id,
  context: { amount: 6800, departmentId: "sales" },
});
```

宿主系统可以自行实现 `ApprovalStore`，也可以使用内置的 Supabase Data API 或 Direct PostgreSQL 适配器。两种数据库实现共用迁移和事务 RPC，保证审批状态、幂等记录和 Outbox 事件在同一个数据库事务中提交。`OrganizationProvider` 负责接入公司的统一组织架构。邮件功能通过 `ApprovalEmailNotifier`、`UserContactProvider` 和 `EmailSender` 装配。

`@approval-flow/core/testing` 中的内存实现只用于测试和本地演示，不得用于生产环境。

## 退回、重新提交与撤回

```ts
// 审批人退回申请人修改（实例保持 RUNNING，START 节点开启第 2 轮执行）
await approval.act({
  idempotencyKey: "expense:EXP-001:return:1",
  taskId,
  operatorId: approverId,
  action: "REJECT_TO_APPLICANT",
  comment: "发票信息有误",
});

// 申请人修改业务上下文后重新提交，contextRevision 递增，条件节点按新上下文重新路由
await approval.updateContext({
  idempotencyKey: "expense:EXP-001:resubmit:1",
  instanceId,
  operatorId: applicantId,
  context: { ...instance.context, amount: 1200 },
});

// 退回指定已到过的审批节点（重新解析审批人并开启新轮次）
await approval.act({
  idempotencyKey: "expense:EXP-001:return-node:1",
  taskId,
  operatorId: approverId,
  action: "RETURN_TO_NODE",
  targetNodeId: "manager_review",
});

// 申请人撤回（默认有任务已被同意后禁止，可用 policies.withdrawalPolicy 放开）
await approval.withdraw({
  idempotencyKey: "expense:EXP-001:withdraw:1",
  instanceId,
  operatorId: applicantId,
  reason: "误提交",
});

// 管理员取消（权限判断在宿主完成）
await approval.cancel({
  idempotencyKey: "expense:EXP-001:cancel:1",
  instanceId,
  operatorId: adminId,
  reason: "重复单据",
});
```

## 统一待办与业务反查

```ts
// 业务单据详情页定位最新审批实例（可按状态过滤）
const instance = await approval.getInstanceByBusiness("expense", "EXP-001", "RUNNING");

// 统一待办：业务类型过滤 + 稳定游标分页 + 排序
const page = await approval.queryTasks({
  assigneeId: currentUser.id,
  status: "PENDING",
  businessType: "expense",
  limit: 20,
  orderBy: "CREATED_DESC",
});
const nextPage = await approval.queryTasks({
  assigneeId: currentUser.id,
  cursor: page.nextCursor,
});
```

## Outbox Worker

包内提供参考实现，宿主只需提供事件处理函数：

```ts
import { createOutboxWorker } from "@approval-flow/core";

const worker = createOutboxWorker({
  store: approvalStore, // 实现 OutboxStore 的适配器
  workerId: "mailer-1",
  handler: async (event) => {
    await deliver(event);
  },
  pollIntervalMs: 1_000,
  leaseSeconds: 60,
  maxAttempts: 10, // 达到上限标记 DEAD，并通过 onDeadLetter 告警
  onDeadLetter: (event, attempts, error) => reportAlert(event, attempts, error),
});

worker.start();
// 优雅退出
await worker.stop();
```

失败按指数退避重试；达到 `maxAttempts` 的事件进入 `DEAD` 状态，可通过 `listDeadOutboxEvents` 查询、`resetDeadOutboxEvent` 重置后重新投递。事件投递是 at-least-once 语义，消费者必须按 `eventId` 幂等。

## 本地验证

```shell
npm install
npm run typecheck
npm test
```

## 可视化演示环境

仓库包含一个与审批核心隔离的本地演示宿主，使用内存数据运行报销和请假示例：

```shell
npm run demo
```

浏览器打开 `http://localhost:4173` 后，可以提交审批、处理待办、查看流程轨迹和 Outbox 事件。演示数据仅保存在当前 Node.js 进程内，重启服务或点击“重置演示数据”后清空。可通过 `PORT` 环境变量指定端口。

演示页还提供统一待办（按人 / 状态 / 业务类型过滤 + 游标分页）、业务反查、流程定义视图、Outbox Worker 控制台（领取 / 重试 / 死信重投 / 毒消息模拟）、邮件沙箱和 16 个隔离能力实验，覆盖当前内核实现的会签、幂等、条件表达式、流程校验、审批人策略、边界策略、命令保护、乐观锁、邮件通知、版本审计、退回重提、退回指定节点、撤回取消、业务反查与分页、死信重投及会签并发自动重试。

“系统配置中心”使用表单编辑并发布完整的 `WorkflowDefinition`：可配置流程元数据、节点、审批策略、连线、优先级和递归条件组合，也可克隆并发布新版本。组织映射、邮件联系人、通知开关和业务上下文字段同样使用表单维护，不需要直接编辑 JSON。发布后的流程会立即出现在业务发起区。

配置在提交时经过内核或宿主边界校验；流程采用递增版本发布并写入配置审计，组织与通知配置保存后对后续业务立即生效。运行时适配器列表仅用于展示：替换 Store、时钟、ID 生成器等属于宿主代码装配，不是运行期表单配置。演示配置和审计仍只保存在当前内存进程中。

运行演示环境的自动冒烟测试：

```shell
npm run test:demo
```

服务运行时还可以单独验证“保存宿主配置 → 发布流程 → 发起配置化业务”的 HTTP 链路：

```shell
npm run test:demo-api
```

## 当前内容

- [总体设计](docs/approval-engine-design.md)
- [嵌入式架构](docs/embedded-architecture.md)
- [审批数据模型](docs/data-model.md)
- [PostgreSQL 与 Supabase 持久化及部署](docs/persistence-and-deployment.md)
- [流程定义 JSON Schema](contracts/workflow-definition.schema.json)
- [报销审批示例](examples/reimbursement.workflow.json)
- [请假审批示例](examples/leave.workflow.json)

## 建议的下一步

1. 在 Supabase 免费项目按顺序执行 `supabase/migrations` 中的迁移并完成真实数据库集成测试。
2. 对接公司统一组织架构与邮件基础设施。
3. 为 Next.js 管理端实现流程草稿、校验和发布 Route Handlers。
4. 用报销和请假示例完成第一轮端到端验收（含退回重提、撤回取消与 Outbox 消费链路）。
