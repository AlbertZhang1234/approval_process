export const statusLabels = {
  RUNNING: "审批中",
  APPROVED: "已通过",
  REJECTED: "已驳回",
  CANCELED: "已取消",
  WITHDRAWN: "已撤回",
  PENDING: "待处理",
};

export const eventLabels = {
  "approval.instance.started": "实例已发起",
  "approval.task.created": "待办已创建",
  "approval.task.completed": "待办已处理",
  "approval.instance.approved": "实例已通过",
  "approval.instance.rejected": "实例已驳回",
  "approval.instance.returned": "实例已退回",
  "approval.instance.resubmitted": "实例已重新提交",
  "approval.instance.withdrawn": "实例已撤回",
  "approval.instance.canceled": "实例已取消",
};

export const outboxStatusLabels = {
  PENDING: "待处理",
  PROCESSING: "处理中",
  PROCESSED: "已处理",
  FAILED: "失败重试",
  DEAD: "死信",
};

export const transitionLabels = {
  FORWARD: "前进",
  RETURN: "退回",
  RESUBMIT: "重新提交",
};

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function formatTime(iso) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(iso));
}

export function createDisplayNameResolver(getPeople) {
  return (userId) => getPeople()[userId] ?? userId;
}
