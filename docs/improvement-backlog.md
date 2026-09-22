# 审批项目问题与改进清单

> 基于真实嵌入场景（Next.js + Supabase PostgreSQL + 会话认证 + nodemailer 的差旅报销系统）的评估结论整理。
> 优先级说明：P0 = 阻碍真实使用 / 嵌入前必须解决；P1 = 首个版本上线前应解决；P2 = 可排入后续迭代。

## 一、功能缺口

### P0 驳回重提 / 退回（最大功能缺口）

> 状态：已完成。`act` 支持 `REJECT_TO_APPLICANT` / `RETURN_TO_NODE`；`updateContext` 重新提交并递增 `contextRevision`；`TransitionRecord.type` 扩展为 `FORWARD` / `RETURN` / `RESUBMIT`，见 `src/domain/approval-runtime.ts`、`src/domain/instance-lifecycle.ts` 与迁移 `20260921000100`。

- **现状**：多轮执行结构已预留（`NodeExecution.round`、`previousExecutionId`、迁移历史），但没有任何命令使用它们；`contextRevision` 永远是 1，不存在更新 context 的命令；`TransitionRecord.type` 只有 `"FORWARD"`。
- **影响**：真实审批场景中大部分需要"驳回给申请人修改后重新提交"或"退回上一节点"。当前只能整体 REJECT 终止实例，申请人修改后必须发起新实例，幂等键和轨迹连续性都会受影响。
- **建议**：
  1. 新增动作：`REJECT_TO_APPLICANT`（退回申请人）与 `RETURN_TO_NODE`（退回指定节点）；
  2. 新增 `updateContext` 命令，重新提交时允许修改业务上下文并递增 `contextRevision`；
  3. 扩展 `TransitionRecord.type`（如 `RETURN`、`RESUBMIT`），补齐退回链路审计。

### P0 撤回 / 取消

> 状态：已完成。`withdraw(instanceId, applicantId)`（仅申请人、仅运行中、`policies.withdrawalPolicy.allowAfterTaskCompleted` 可配置；退回申请人后未有人同意时仍可撤回）与 `cancel(instanceId, operatorId, reason?)` 已提供，并产生 `approval.instance.withdrawn` / `approval.instance.canceled` 事件。

- **现状**：`ApprovalInstanceStatus` 枚举包含 `WITHDRAWN` / `CANCELED`，但没有对应命令，只有 `start` 和 `act`。
- **影响**：申请人无法撤回误提交的单据；管理员无法取消作废流程。状态枚举成了"死代码"。
- **建议**：新增 `withdraw(instanceId, applicantId)`（仅申请人、仅运行中实例、可配置是否允许在有任务已处理后撤回）与 `cancel(instanceId, operatorId)`（宿主层做权限判断），并产生相应领域事件。

### P1 业务反查实例

> 状态：已完成。`ApprovalStore.getInstanceByBusiness(type, id, status?)` + RPC `get_instance_by_business` 返回最新实例，支持单个/多个状态过滤。

- **现状**：只能按 `instanceId` 查询实例；数据库已建 `workflow_instances_business_idx` 索引，但 RPC 层没有对应接口。
- **影响**：业务系统详情页要展示审批轨迹时（如报销单详情页），无法从业务单据定位审批实例，只能靠幂等键约定绕。
- **建议**：增加 `get_instance_by_business(type, id)` RPC 函数与 `ApprovalStore` 方法（建议返回最新实例，或按状态过滤）。

### P1 待办查询增强

> 状态：已完成。`queryTasks` 支持 businessType 过滤、createdAt+id 稳定游标分页、CREATED_DESC/ASC 排序；RPC `list_tasks` 配合 `(assignee_id, status, created_at desc, id desc)` 索引。

- **现状**：`listTasks(assigneeId, status)` 没有业务类型过滤、分页、排序。
- **影响**：真实系统的统一待办需要按业务类型筛选、分页展示、按创建时间排序，当前接口在数据量增长后不可用。
- **建议**：扩展查询参数（businessType、cursor/limit、orderBy），RPC 层配合索引调整。

### P2 超时 / 催办 / 升级

- **现状**：完全没有时间维度的机制。
- **影响**：审批挂起无人处理时无提醒、无升级，流程会无限期停滞。
- **建议**：节点级 `timeout` 配置 + 定时扫描产生 `task.reminder` / `task.escalated` 事件，宿主通过 Outbox 消费。

### P2 转办 / 加签 / 委托

- **现状**：不支持。任务创建后 assignee 固定。
- **建议**：后续版本设计（转办 = 重新解析 assignee 并结束旧任务；加签 = 同节点动态追加任务；委托 = 时间段内代理审批），需同步考虑会签模式语义。

## 二、工程缺口

### P0 数据库接入策略：测试用 Supabase 云端 API，正式再切 PostgreSQL（已明确）

- **决策**：
  1. **测试阶段**：统一使用内置的 Supabase Data API 适配器（`@approval-flow/core/supabase` 的 `createSupabaseApiApprovalStore({ url, secretKey })`），通过 HTTPS 调用 `approval_api` RPC。不直连数据库、不占用连接池，部署与联调成本最低。适配器已内置安全约束：仅允许服务端运行、强制 HTTPS、使用私有密钥与 `approval_api` profile。
  2. **正式环境（或明确要求切换时）**：切换到 Direct PostgreSQL 适配器（`@approval-flow/core/postgres` 的 `createPostgresApprovalStore({ connectionString })`，基于 postgres.js），获得更低的延迟与更稳定的直连链路。切换时需在宿主 Next.js 配置 `serverExternalPackages: ['postgres']`。
- **切换成本**：两个适配器共用同一套数据库迁移与 RPC 契约（这正是本项目的双适配设计目标），切换只发生在装配入口——把 store 工厂从 `createSupabaseApiApprovalStore` 换成 `createPostgresApprovalStore`，其余代码（领域逻辑、Route Handlers、Outbox Worker）零改动。
- **测试阶段的准备工作**：宿主需在环境变量中补充 Supabase 私有密钥（service key，现有 `.env` 只有 anon key 与 `DATABASE_URL`），迁移 SQL 照常先在 Supabase 项目执行。
- **遗留关注点（降级为 P2 观察项）**：正式环境切 PostgreSQL 后，若宿主自身用 `pg` 访问业务表，会形成 postgres.js + `pg` 双连接池，需评估连接数预算；确有压力时再补一个基于 `pg` 的 `ApprovalRpcClient`（持久化入口只有 `call(fn, input)` 一个方法，成本很低）。

### P1 缺少现成的 Outbox Worker

> 状态：已完成。`createOutboxWorker({ store, handler, pollInterval, leaseSeconds, maxAttempts, ... })` 覆盖领取、处理、确认、指数退避失败重试、死信告警回调与优雅退出。

- **现状**：只有 `OutboxStore` 端口（claim / markProcessed / markFailed），demo 中是手动循环，包内没有可复用的 Worker 实现。
- **影响**：每个宿主都要自己写 claim→处理→ack 循环、失败退避、优雅退出，容易写错。
- **建议**：提供参考实现（如 `createOutboxWorker({ store, handler, pollInterval, leaseSeconds })`），覆盖领取、处理、确认、失败重试与停机。

### P1 Outbox 无死信策略

> 状态：已完成。达到 `maxAttempts` 后标记 `DEAD`（含 `dead_lettered_at`），提供 `listDeadOutboxEvents` / `resetDeadOutboxEvent` 查询与重置，Worker 暴露 `onDeadLetter` 告警钩子。

- **现状**：失败只有 `retryAt` 退避和 `attempts` 计数，没有最大尝试次数与死信状态。
- **影响**：毒消息（如联系人永远缺失）会无限重试，占用 Worker。
- **建议**：达到 `maxAttempts` 后标记 `DEAD`（或单独 dead 状态），提供查询/重置接口与告警事件。

### P1 `ALL` 会签并发冲突

> 状态：已完成。`act` 等变更命令对 `VERSION_CONFLICT` 内置有限次读-重放重试（默认 3 次重试，`policies.versionConflictRetries` 可配），幂等键保证重放安全。

- **现状**：每次审批动作整体保存实例 + 乐观锁版本号；多个会签人同时操作会有人拿到 `VERSION_CONFLICT`，内核无重试。
- **影响**：会签场景下偶发失败，用户体验差，宿主容易误判为业务错误。
- **建议**：`act` 内部对 `VERSION_CONFLICT` 做有限次读-重放重试（幂等键保证安全），或在文档中明确要求宿主重试。

### P2 业务状态回写模式缺失

- **现状**：审批结果只存在于独立 instance 存储和 Outbox 事件中，业务表状态（如 `otto_tr_h.approvalstatus`）需要宿主自行同步；文档与 demo 均未展示推荐方案。
- **影响**：像"业务表状态驱动下游（SAP 过账、列表页展示）"这种极普遍的场景，每个宿主都要自己摸索；同步回写有两段事务不一致风险，异步回写有一致性延迟，缺乏官方指导。
- **建议**：文档化推荐模式（Outbox 消费者回写业务表），或提供可选的同步回调钩子，并说明两种方式的取舍。

## 三、次要问题

| 问题 | 说明 | 建议 |
| --- | --- | --- |
| 邮件模板单一、无 i18n | 只有内置默认模板，变量较少 | 模板键化 + 多语言支持；宿主自定义模板已有端口，可先行 |
| 流程管理 UI 需宿主自建 | 草稿/校验/发布只有 demo 页面，包内无管理端组件 | 可将 demo 表单抽成可选的宿主组件包，或补一份管理端接入指南 |
| 未纳入 git 版本管理 | 当前目录不是 git 仓库 | 嵌入前先 `git init` 并提交基线 |
| 未发布、版本 0.1.0 | 宿主只能 tarball 或私有 registry 引用 | 嵌入验证通过后发布私有 npm 包，锁定版本 |
| 单实例整体快照保存 | 每次动作全量替换实例 JSON 与子记录 | 中小规模可接受；数据量大后再考虑增量持久化，暂不动 |

## 四、建议的处理顺序

1. **嵌入前置**：按既定策略接入 Supabase Data API（测试阶段）+ git 基线；
2. **首个真实版本前**：~~P0 驳回重提 + 撤回取消（功能）、P1 业务反查 + 待办增强 + Outbox Worker + 死信 + 会签并发重试（工程）~~ ✅ 已全部完成；
3. **上线后迭代**：P2 超时催办、转办加签、业务回写模式文档化、邮件 i18n、管理端组件化。

## 附：与目标宿主（ORBCN_TR Frontend）嵌入相关的结论

- 迁移 SQL 为纯 PostgreSQL（无 `auth.uid()` 等 Supabase 专属依赖），可直接跑在宿主同一个 Supabase 库；
- 认证（会话 → `operatorId`）、组织架构（角色表 + 项目经理映射）、邮件（nodemailer）、后台 Worker（`instrumentation.ts` 模式）均有对接点；
- 实际嵌入的关键胶水：Supabase Data API store 装配（测试阶段；正式环境或明确要求后再切换 PostgreSQL store）、`OrganizationProvider`、`EmailSender` 适配器、服务端装配工厂、审批 Route Handlers、业务状态回写消费者、存量单据走老流程的切换策略。
