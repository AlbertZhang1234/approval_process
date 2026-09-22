# PostgreSQL 与 Supabase 双通道持久化

## 1. 边界和选择

审批核心不依赖数据库驱动。两个适配器实现同一组 `ApprovalStore`、`WorkflowManagementStore` 和 `OutboxStore` 契约，并调用同一套 `approval_api` 数据库函数：

| 环境 | 导入入口 | 连接方式 | 建议用途 |
| --- | --- | --- | --- |
| 单元测试、演示 | `@approval-flow/core/testing` | 内存 | 快速测试，不保存数据 |
| Supabase 免费项目 | `@approval-flow/core/supabase` | 服务端 HTTPS Data API | 开发、联调和测试环境 |
| 正式环境 | `@approval-flow/core/postgres` | PostgreSQL 驱动 | 长期运行的 Node.js 服务 |

两条数据库通道共用 `supabase/migrations` 中的 Schema，不维护两套表结构。业务代码只依赖 Store 接口，因此切换环境不改变审批规则、流程配置或调用方式。

## 2. 数据模型

私有 `approval` Schema 包含（完整字段、约束、索引与数据流转示例见[审批数据模型](data-model.md)）：

- `workflow_definitions`：流程身份、启停状态和当前发布版本；
- `workflow_drafts`：前端编辑中的节点、连线、条件和审批人配置，使用 `revision` 乐观锁；
- `workflow_versions`：不可变发布快照；
- `workflow_instances`：运行实例及其流程快照，实例始终沿用启动时的版本；
- `node_executions`、`approval_tasks`、`transition_history`、`approval_actions`：节点执行、待办、轨迹和操作留痕；
- `idempotency_records`：开始与审批操作的幂等记录；
- `outbox_events`：与审批状态同事务写入的邮件及集成事件。

`approval_api` Schema 只包含带固定 `search_path` 的事务函数。Supabase Data API 不直接开放私有表；Direct PostgreSQL 适配器也调用相同函数，确保两条路径具有相同的事务边界。

## 3. 迁移与回滚

首次部署执行：

```shell
supabase db push
```

也可以由现有 PostgreSQL 迁移工具按文件名顺序执行 `supabase/migrations/*.sql`。初始迁移是 [20260910000100_initial_approval_schema.sql](../supabase/migrations/20260910000100_initial_approval_schema.sql)；退回重提 / 撤回取消与 Outbox 死信增强迁移是 [20260921000100_return_lifecycle_and_outbox_hardening.sql](../supabase/migrations/20260921000100_return_lifecycle_and_outbox_hardening.sql)，新环境应按顺序全部执行。

增强迁移会放宽 `transition_history`（`RETURN` / `RESUBMIT`）、`approval_actions`（退回动作）与 `outbox_events`（`DEAD`）的检查约束，增加 `dead_lettered_at` 列与死信索引，并新增以下 RPC：`get_instance_by_business`、`mark_outbox_event_dead`、`list_dead_outbox_events`、`reset_dead_outbox_event`；`list_tasks` 升级为业务类型过滤 + 游标分页 + 排序，`persist_instance_change` 记录命令操作类型。已有 Supabase 测试项目在执行该迁移后即可使用包内对应能力。

对应回滚脚本位于 `supabase/rollback`。初始回滚会删除整个 `approval_api` 与 `approval` Schema，因而只适合尚无需要保留数据的回退。生产环境执行前必须备份，并由宿主项目自己的迁移发布流程审批。

在 Supabase Dashboard 的 API 设置中，将 `approval_api` 加入 Exposed schemas。私有 `approval` 不要加入。迁移已撤销 `anon` 与 `authenticated` 的调用权限，只向 `service_role` 授予 RPC 执行权限。

## 4. Supabase 测试环境

密钥必须只存在于 Route Handler、Server Action、后台任务等服务端代码中，不能使用 `NEXT_PUBLIC_` 前缀，也不能由浏览器直接请求审批 RPC。

```ts
import "server-only";
import { createSupabaseApiApprovalStore } from "@approval-flow/core/supabase";

export const approvalStore = createSupabaseApiApprovalStore({
  url: process.env.SUPABASE_URL!,
  secretKey: process.env.SUPABASE_SECRET_KEY!,
});
```

推荐使用 Supabase 新式 Secret Key。旧式 `service_role` JWT 仍可兼容，但不应写入仓库、日志或前端 Bundle。

## 5. 正式 PostgreSQL 环境

`postgres` 是 Direct PostgreSQL 入口的可选 peer dependency。只有使用该入口的宿主需要安装：

```shell
npm install postgres
```

```ts
import "server-only";
import { createPostgresApprovalStore } from "@approval-flow/core/postgres";

export const approvalStore = createPostgresApprovalStore({
  connectionString: process.env.DATABASE_URL!,
  maxConnections: 10,
});
```

长驻 Node.js 服务优先使用 Direct 或 Session Pooler；Serverless Route Handler 优先使用 Transaction Pooler。适配器关闭 prepared statements，以兼容事务池模式。应用退出时调用 `approvalStore.close()`。如果宿主已有 `postgres` 客户端，使用 `createPostgresApprovalStoreFromClient(sql)`，由宿主管理连接生命周期。

数据库迁移不要通过 Transaction Pooler 执行，使用 Direct 连接或迁移平台提供的专用连接。

## 6. Next.js 15 组合方式

在只会被服务端引用的模块里根据环境装配一次 Store，再把同一个实例交给流程管理器和运行门面：

```ts
import "server-only";
import { createApprovalModule, createWorkflowManager } from "@approval-flow/core";
import { createSupabaseApiApprovalStore } from "@approval-flow/core/supabase";

const store = createSupabaseApiApprovalStore({
  url: process.env.SUPABASE_URL!,
  secretKey: process.env.SUPABASE_SECRET_KEY!,
});

export const workflows = createWorkflowManager({ store });
export const approval = createApprovalModule({ store, organizationProvider });
```

Route Handler 负责登录态、权限、HTTP 输入校验和错误响应映射；`WorkflowManager` 负责草稿规则、发布校验和版本语义。配置端典型链路为：

1. `createDefinition` 创建流程和空草稿；
2. 前端读取 `getDraft`，用表单或画布编辑 `nodes`、`edges`、条件及审批人策略；
3. `saveDraft` 携带当前 `expectedRevision`，冲突时返回 `VERSION_CONFLICT` 并要求刷新；
4. `validateDraft` 展示领域校验结果；
5. `publishDraft` 生成不可变新版本；相同 revision 不可重复发布；
6. 新实例读取最新版本，运行中的实例继续使用原快照。

流程 key、名称和描述在当前版本创建后固定；可编辑项是草稿中的节点、顺序、条件、审批人、会签模式和边界策略。元数据修改接口、流程版本回滚和运行中实例迁移尚未实现。

## 7. 邮件 Outbox Worker

审批操作只负责把领域事件写入 Outbox，不在请求事务中发送邮件。后台 Worker 周期性：

1. `claimOutboxEvents` 领取一批事件，并设置有时限的 Worker 锁；
2. 将事件交给 `ApprovalEmailNotifier`；
3. 成功后调用 `markOutboxEventProcessed`；
4. 失败后计算下一次时间，调用 `markOutboxEventFailed`。

过期的 `PROCESSING` 锁可以被其他 Worker 再次领取，因此邮件发送器仍应使用事件 ID 做幂等去重。错误文本入库前会截断到 2000 字符，调用方不得传入密钥或隐私数据。

## 8. 当前验证边界

仓库测试覆盖流程草稿版本化、运行实例版本锁定、RPC 编解码、Supabase 请求头与错误映射、Outbox 契约和迁移结构。由于本地未安装 PostgreSQL、Supabase CLI 或 Docker，SQL 尚未在真实数据库执行；部署到首个 Supabase 测试项目后应补跑迁移和一条“创建流程 → 发布 → 发起 → 审批 → 消费 Outbox”的集成测试。
