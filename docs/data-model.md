# 审批数据模型

本文档整理当前数据库中与审批相关的全部表结构。所有表位于私有 `approval` Schema，外部只能通过 `approval_api` Schema 的事务 RPC 函数访问，不允许直接查表或写表。定义来源：

- [20260910000100_initial_approval_schema.sql](../supabase/migrations/20260910000100_initial_approval_schema.sql)（初始迁移）
- [20260921000100_return_lifecycle_and_outbox_hardening.sql](../supabase/migrations/20260921000100_return_lifecycle_and_outbox_hardening.sql)（退回重提 / 死信增强迁移）

## 1. 与业务单据表的关系

本框架**没有也不需要"审批单据表"**。报销单、请假单等业务单据始终保存在宿主系统自己的业务表中，框架只通过实例上的 3 个引用字段关联业务单据，不复制业务数据：

```text
workflow_instances.business_type  ->  业务类型（如 expense / leave）
workflow_instances.business_id    ->  业务单号（如 EXP-2026-001）
workflow_instances.business_url   ->  详情页链接（用于邮件通知跳转）
```

两个方向的定位方式：

- 业务单据找审批：`getInstanceByBusiness(type, id, status?)`，按 `(business_type, business_id, created_at desc)` 索引返回最新实例；
- 审批结果回写业务：宿主消费 `outbox_events` 中的领域事件后，自行更新业务表状态（如 `approvalstatus` 字段），推荐异步回写模式见改进清单。

## 2. 表关系总览

```text
workflow_definitions（流程定义，如"报销审批"）
 ├── workflow_drafts（编辑中的草稿，1:1）
 └── workflow_versions（不可变发布版本，1:N）
        ↑
workflow_instances（审批实例 = 一次单据的审批过程）
 ├── node_executions（节点执行，1:N，退回时同节点多轮次）
 │     ├── approval_tasks（待办，1:N，会签时一轮执行多个任务）
 │     └── transition_history（节点间跳转轨迹，引用两侧执行）
 ├── approval_actions（审批动作留痕：谁在什么时候点了什么）
 ├── idempotency_records（命令幂等记录）
 └── outbox_events（事务性事件，异步投递邮件与集成）
```

共 10 张表，按职责分三组：流程定义组（3 张）、审批运行组（5 张）、基础设施组（2 张）。

## 3. 流程定义组

### 3.1 `workflow_definitions` — 流程身份

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| id | text | 主键 |
| definition_key | varchar(64) | 唯一，`^[a-z][a-z0-9-]{2,63}$` |
| name | varchar(100) | 非空 |
| description | varchar(500) | |
| status | varchar(16) | `ACTIVE` / `DISABLED`，默认 ACTIVE |
| current_version_id | text | 外键 → workflow_versions，延迟约束 |
| created_by / updated_by | text | 非空 |
| created_at / updated_at | timestamptz | 非空 |

### 3.2 `workflow_drafts` — 流程草稿（与定义 1:1）

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| definition_id | text | 主键 + 外键 → workflow_definitions，级联删除 |
| content | jsonb | 编辑中的 nodes / edges，默认空结构 |
| revision | bigint | 草稿乐观锁版本号，>= 0 |
| published_revision | bigint | 最近一次已发布的草稿版本 |
| updated_by / updated_at | | 非空 |

### 3.3 `workflow_versions` — 不可变发布快照

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| id | text | 主键 |
| definition_id | text | 外键 → workflow_definitions，restrict |
| version | int | `(definition_id, version)` 唯一，> 0 |
| schema_version | int | 默认 1 |
| content | jsonb | 发布时的完整流程 JSON，发布后永不再改 |
| content_hash | varchar(64) | 内容 SHA-256，防篡改与比对 |
| published_by / published_at | | 非空 |

## 4. 审批运行组

### 4.1 `workflow_instances` — 审批实例（审批主单）

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| id | text | 主键 |
| workflow_version_id | text | 外键 → workflow_versions；**实例锁定启动时的版本，之后发新版不影响在途实例** |
| definition_key | varchar(64) | 冗余流程标识 |
| definition_version | int | 冗余版本号 |
| definition_snapshot | jsonb | 完整流程快照，再冗余一份供审计脱离版本表读取 |
| business_type | varchar(100) | 业务类型（引用宿主单据，无外键） |
| business_id | varchar(200) | 业务单号 |
| business_url | varchar(2000) | 详情页链接 |
| applicant_id | text | 申请人 |
| context | jsonb | 业务上下文（金额、天数等），条件路由数据源 |
| context_revision | int | 上下文修订号，退回重提时 +1，默认 1 |
| status | varchar(16) | `RUNNING` / `APPROVED` / `REJECTED` / `CANCELED` / `WITHDRAWN` |
| current_execution_id | text | 外键 → node_executions，当前停留节点，延迟约束 |
| version | bigint | 乐观锁版本号，每次动作 +1 |
| created_at / updated_at | timestamptz | 非空 |

索引：

- `(business_type, business_id, created_at desc)` — 业务反查最新实例；
- `(applicant_id, created_at desc)` — 我发起的审批；
- `(status, updated_at desc)` — 按状态运维巡检。

### 4.2 `node_executions` — 节点执行（轨迹骨架）

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| id | text | 主键 |
| instance_id | text | 外键 → workflow_instances，级联删除 |
| node_id | varchar(64) | 节点 ID（如 manager_review） |
| round | int | 轮次：同一节点第几次进入，退回重审 = 2、3…，> 0 |
| previous_execution_id | text | 外键 → 同表，上一轮同节点执行（退回链） |
| status | varchar(16) | `ACTIVE` / `COMPLETED` / `CANCELED` |
| result | varchar(16) | `PASSED` / `REJECTED` / `SKIPPED` / null |
| entered_at | timestamptz | 非空 |
| left_at | timestamptz | ACTIVE 时必须为 null |

约束：`(instance_id, node_id, round)` 唯一 —— 多轮执行的结构基础。

### 4.3 `approval_tasks` — 审批待办

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| id | text | 主键 |
| instance_id | text | 外键 → workflow_instances，级联删除 |
| execution_id | text | 外键 → node_executions，**绑定到具体一轮执行，旧轮次任务不复用** |
| node_id | varchar(64) | 节点 |
| assignee_id | text | 审批人（创建时解析快照，组织变动不影响在途待办） |
| status | varchar(16) | `PENDING` / `APPROVED` / `REJECTED` / `CANCELED` |
| created_at | timestamptz | 非空 |
| completed_at | timestamptz | PENDING 时必须为 null |
| comment | text | 审批意见 |

索引：`(assignee_id, status, created_at desc, id desc)` 统一待办分页；`(instance_id, created_at, id)`；`(execution_id)`。

### 4.4 `transition_history` — 节点跳转轨迹

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| id | text | 主键 |
| instance_id | text | 外键 → workflow_instances，级联删除 |
| from_execution_id | text | 外键 → node_executions，发起方执行 |
| to_execution_id | text | 外键 → node_executions，非空，目标方执行 |
| transition_type | varchar(24) | `FORWARD`（前进）/ `RETURN`（退回）/ `RESUBMIT`（重新提交） |
| occurred_at | timestamptz | 非空 |

### 4.5 `approval_actions` — 审批动作留痕

由内核保存 `approval.task.completed` 事件时自动从事件数据落库，纯审计表。

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| id | text | 主键（复用对应事件 ID） |
| instance_id | text | 外键 → workflow_instances，级联删除 |
| execution_id | text | 外键 → node_executions |
| task_id | text | 外键 → approval_tasks |
| node_id | varchar(64) | 节点 |
| operator_id | text | 实际操作人 |
| action_type | varchar(24) | `APPROVE` / `REJECT` / `REJECT_TO_APPLICANT` / `RETURN_TO_NODE` |
| comment | text | 审批意见 |
| occurred_at | timestamptz | 非空 |

## 5. 基础设施组

### 5.1 `idempotency_records` — 命令幂等记录

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| idempotency_key | varchar(300) | 主键，宿主提供 |
| fingerprint | varchar(64) | 命令内容 SHA-256；同键不同内容抛 IDEMPOTENCY_CONFLICT |
| operation_type | varchar(32) | `START` / `ACT` / `WITHDRAW` / `CANCEL` / `UPDATE_CONTEXT` |
| instance_id | text | 外键 → workflow_instances，级联删除 |
| created_at | timestamptz | 非空 |

### 5.2 `outbox_events` — 事务性 Outbox 事件

| 字段 | 类型 | 约束 / 说明 |
| --- | --- | --- |
| id | text | 主键 |
| event_type | varchar(100) | 如 `approval.task.created`、`approval.instance.returned` |
| instance_id | text | 外键 → workflow_instances，级联删除 |
| payload | jsonb | 完整事件内容 |
| status | varchar(16) | `PENDING` / `PROCESSING` / `PROCESSED` / `FAILED` / `DEAD`（死信） |
| attempts | int | 尝试次数，>= 0 |
| available_at | timestamptz | 下次可领取时间（失败退避） |
| locked_at / locked_by | timestamptz / text | Worker 租约锁 |
| processed_at | timestamptz | 处理完成时间 |
| last_error | text | 最后一次错误 |
| dead_lettered_at | timestamptz | 进入死信时间 |
| occurred_at / created_at | timestamptz | 事件发生 / 落库时间 |

索引：`(available_at, occurred_at, id) where status in ('PENDING','FAILED')` 待领取扫描；`(dead_lettered_at desc, id) where status = 'DEAD'` 死信查询。

## 6. 一笔报销的完整数据流转示例

场景：6800 元报销 → 经理同意 → 财务退回申请人 → 改成 200 元重新提交 → 经理同意 → 审批通过。

| 表 | 产生的记录 |
| --- | --- |
| workflow_instances | 1 条：status RUNNING → RUNNING → APPROVED；version 1 → 6；context_revision 1 → 2 |
| node_executions | 8 条：start(R1) → 经理(R1) → 金额判断(R1) → 财务(R1, REJECTED) → **start(R2)** → 经理(R2) → 金额判断(R2) → 终点 |
| approval_tasks | 4 条：经理R1(APPROVED)、财务×2（一人 REJECTED、一人 CANCELED）、**经理R2(APPROVED)** |
| transition_history | 8 条：FORWARD×4 → **RETURN** → **RESUBMIT** → FORWARD×2 |
| approval_actions | 3 条：经理 APPROVE → 财务 REJECT_TO_APPLICANT → 经理 APPROVE |
| outbox_events | 约 11 条：started / task.created / task.completed / returned / resubmitted / approved 等 |
| idempotency_records | 4 条：start、两次 act、updateContext，各带独立幂等键 |

## 7. 设计要点

1. **单据与审批分离**：业务表归宿主系统，框架只存引用，通过业务反查定位实例；
2. **事件溯源式留痕**：实例状态是"当前值"，完整历史追加保存在 node_executions / transition_history / approval_actions 三张表中，退回重提不覆盖旧记录；
3. **三层定位结构**：instance → execution（轮次）→ task，会签（一轮多任务）与多轮退回（一节点多轮）都能精确还原；
4. **事务一致性**：实例状态、幂等记录与 Outbox 事件在同一个数据库事务内写入（由 `approval_api` RPC 保证），邮件与集成异步消费不丢事件；
5. **安全边界**：所有表启用 RLS 并回收 anon / authenticated 权限，仅 `service_role` 可调用 RPC。
