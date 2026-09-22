# 审批数据库迁移

- `migrations/`：按文件名顺序前向执行的 PostgreSQL/Supabase 迁移。
- `rollback/`：人工审查后执行的对应回滚脚本，不由 Supabase CLI 自动运行。

测试和生产使用同一套迁移。Supabase Data API 只需额外将 `approval_api` 加入 Exposed schemas；不要暴露私有 `approval` Schema。完整装配、密钥和连接方式见 [持久化与部署说明](../docs/persistence-and-deployment.md)。
