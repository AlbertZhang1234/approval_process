import { createHostConfigForm } from "./host-config-form.js";
import { createWorkflowForm } from "./workflow-form.js";

const CATALOG_LABELS = {
  nodeTypes: ["节点类型", "流程图允许的节点"],
  approvalModes: ["审批完成模式", "或签与会签"],
  assigneePolicyTypes: ["审批人策略", "组织架构解析入口"],
  emptyAssigneePolicies: ["无人审批策略", "解析结果为空时"],
  selfApprovalPolicies: ["本人审批策略", "申请人与审批人相同时"],
  conditionOperators: ["条件操作符", "结构化安全表达式"],
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function initializeConfig({ api, showToast, getWorkflows, onWorkflowPublished, onHostUpdated }) {
  const elements = {
    status: document.querySelector("#config-status"),
    runtime: document.querySelector("#runtime-config"),
    tabs: document.querySelector(".config-tabs"),
    catalog: document.querySelector("#config-catalog"),
    audit: document.querySelector("#config-audit"),
  };
  let configuration = await api("/api/config");

  function renderRuntime() {
    elements.runtime.innerHTML = Object.entries(configuration.runtime).map(([key, value]) => `
      <div><span>${escapeHtml(key)}</span><strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong></div>
    `).join("");
  }

  function renderCatalog() {
    elements.catalog.innerHTML = Object.entries(configuration.catalogs).map(([key, values]) => `
      <article><span>${escapeHtml(CATALOG_LABELS[key]?.[1] ?? key)}</span><h3>${escapeHtml(CATALOG_LABELS[key]?.[0] ?? key)}</h3><div>${values.map((value) => `<code>${escapeHtml(value)}</code>`).join("")}</div></article>
    `).join("");
    elements.audit.innerHTML = configuration.audit.map((item) => `
      <div><span>${new Date(item.occurredAt).toLocaleTimeString("zh-CN")}</span><strong>${escapeHtml(item.type)}</strong><small>${escapeHtml(item.detail)}</small></div>
    `).join("");
  }

  function renderShell() {
    elements.status.textContent = `${Object.keys(configuration.workflowVersions).length} 个流程 · ${Object.keys(configuration.host.people).length} 个用户`;
    renderRuntime();
    renderCatalog();
  }

  const workflowForm = createWorkflowForm({
    api,
    catalog: configuration.catalogs,
    getWorkflows,
    showToast,
    onPublished: async (response) => {
      configuration = response.configuration;
      renderShell();
      await onWorkflowPublished(response.workflow.key);
      workflowForm.renderSelect(response.workflow.key);
    },
  });
  const hostForm = createHostConfigForm({
    api,
    showToast,
    onSaved: async (nextConfiguration) => {
      configuration = nextConfiguration;
      renderShell();
      await onHostUpdated();
    },
  });

  elements.tabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-config-tab]");
    if (button === null) return;
    document.querySelectorAll(".config-tab").forEach((tab) => tab.classList.toggle("config-tab--active", tab === button));
    document.querySelectorAll(".config-pane").forEach((pane) => pane.classList.toggle("config-pane--active", pane.dataset.configPane === button.dataset.configTab));
  });

  function renderForms(selectedKey) {
    renderShell();
    hostForm.load(configuration.host);
    workflowForm.renderSelect(selectedKey);
  }

  async function reload() {
    const selectedKey = document.querySelector("#config-workflow-select").value || undefined;
    configuration = await api("/api/config");
    renderForms(selectedKey);
  }

  renderForms();
  return { reload };
}
