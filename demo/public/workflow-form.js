import { applyConditionEvent, defaultCondition, renderConditionEditor } from "./condition-editor.js";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function options(values, selected) {
  return values.map((value) => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(value)}</option>`).join("");
}

function minimalWorkflow() {
  return {
    key: "custom-approval",
    name: "自定义审批",
    version: 1,
    description: "由 Demo 配置中心创建的流程",
    nodes: [
      { id: "start", name: "开始", type: "START" },
      {
        id: "review",
        name: "指定审批人审批",
        type: "APPROVAL",
        config: {
          mode: "ANY",
          assignees: [{ type: "REQUEST_FIELD", value: "reviewerId" }],
          emptyAssigneePolicy: "ERROR",
          selfApprovalPolicy: "REQUIRE_OTHER",
        },
      },
      { id: "approved_end", name: "审批通过", type: "END" },
    ],
    edges: [
      { id: "e_start_review", source: "start", target: "review" },
      { id: "e_review_end", source: "review", target: "approved_end" },
    ],
  };
}

function defaultApprovalConfig() {
  return {
    mode: "ANY",
    assignees: [{ type: "USER", value: "manager-1" }],
    emptyAssigneePolicy: "ERROR",
    selfApprovalPolicy: "REQUIRE_OTHER",
  };
}

export function createWorkflowForm({ api, catalog, getWorkflows, showToast, onPublished }) {
  const elements = {
    select: document.querySelector("#config-workflow-select"),
    clone: document.querySelector("#clone-workflow"),
    create: document.querySelector("#new-workflow"),
    key: document.querySelector("#workflow-key"),
    name: document.querySelector("#workflow-name"),
    version: document.querySelector("#workflow-version"),
    description: document.querySelector("#workflow-description"),
    summary: document.querySelector("#workflow-editor-summary"),
    nodeList: document.querySelector("#workflow-node-list"),
    addNode: document.querySelector("#add-workflow-node"),
    edgeList: document.querySelector("#workflow-edge-list"),
    addEdge: document.querySelector("#add-workflow-edge"),
    validate: document.querySelector("#check-workflow"),
    publish: document.querySelector("#publish-workflow"),
    result: document.querySelector("#workflow-config-result"),
  };
  let draft = minimalWorkflow();

  function setResult(message, passed) {
    elements.result.textContent = `${passed ? "✓" : "×"} ${message}`;
    elements.result.className = `config-result config-result--${passed ? "passed" : "failed"}`;
  }

  function renderSummary() {
    const approvalCount = draft.nodes.filter((node) => node.type === "APPROVAL").length;
    const conditionCount = draft.edges.filter((edge) => edge.condition !== undefined).length;
    elements.summary.innerHTML = `
      <span><strong>${draft.nodes.length}</strong> 节点</span>
      <span><strong>${draft.edges.length}</strong> 连线</span>
      <span><strong>${approvalCount}</strong> 审批节点</span>
      <span><strong>${conditionCount}</strong> 条件分支</span>
    `;
  }

  function renderMetadata() {
    elements.key.value = draft.key;
    elements.name.value = draft.name;
    elements.version.value = String(draft.version);
    elements.description.value = draft.description ?? "";
  }

  function renderAssignees(node, nodeIndex) {
    return `
      <div class="assignee-list">
        ${node.config.assignees.map((assignee, assigneeIndex) => `
          <div class="assignee-row" data-assignee-index="${assigneeIndex}">
            <label>策略类型<select data-assignee-field="type">${options(catalog.assigneePolicyTypes, assignee.type)}</select></label>
            <label>策略值<input data-assignee-field="value" value="${escapeHtml(assignee.value)}" placeholder="用户、角色、字段或 Provider Key" /></label>
            <button class="icon-button" data-remove-assignee type="button" aria-label="删除审批人策略">×</button>
          </div>
        `).join("")}
      </div>
      <button class="button button--secondary button--small" data-add-assignee="${nodeIndex}" type="button">＋ 添加审批人策略</button>
    `;
  }

  function renderNodes() {
    elements.nodeList.innerHTML = draft.nodes.map((node, nodeIndex) => `
      <article class="workflow-node-card" data-node-index="${nodeIndex}">
        <div class="card-index">NODE ${String(nodeIndex + 1).padStart(2, "0")}</div>
        <div class="node-core-fields">
          <label>节点 ID<input data-node-field="id" value="${escapeHtml(node.id)}" placeholder="例如 manager_review" /></label>
          <label>显示名称<input data-node-field="name" value="${escapeHtml(node.name)}" /></label>
          <label>节点类型<select data-node-field="type">${options(catalog.nodeTypes, node.type)}</select></label>
          <button class="icon-button" data-remove-node type="button" aria-label="删除节点">×</button>
        </div>
        ${node.type === "APPROVAL" ? `
          <div class="approval-node-config">
            <div class="approval-policy-grid">
              <label>完成模式<select data-node-config="mode">${options(catalog.approvalModes, node.config.mode)}</select><small>ANY 或签；ALL 会签</small></label>
              <label>无人审批策略<select data-node-config="emptyAssigneePolicy">${options(catalog.emptyAssigneePolicies, node.config.emptyAssigneePolicy)}</select></label>
              <label>本人审批策略<select data-node-config="selfApprovalPolicy">${options(catalog.selfApprovalPolicies, node.config.selfApprovalPolicy)}</select></label>
            </div>
            <div class="subsection-label">审批人解析策略</div>
            ${renderAssignees(node, nodeIndex)}
          </div>
        ` : ""}
      </article>
    `).join("");
  }

  function renderEdges() {
    const nodeOptions = draft.nodes.map((node) => [node.id, `${node.name} (${node.id})`]);
    const endpointOptions = (selected) => nodeOptions.map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`).join("");
    elements.edgeList.innerHTML = draft.edges.map((edge, edgeIndex) => `
      <article class="workflow-edge-card" data-edge-index="${edgeIndex}">
        <div class="card-index">EDGE ${String(edgeIndex + 1).padStart(2, "0")}</div>
        <div class="edge-core-fields">
          <label>连线 ID<input data-edge-field="id" value="${escapeHtml(edge.id)}" /></label>
          <label>来源节点<select data-edge-field="source">${endpointOptions(edge.source)}</select></label>
          <label>目标节点<select data-edge-field="target">${endpointOptions(edge.target)}</select></label>
          <label>优先级<input data-edge-field="priority" type="number" min="0" step="1" value="${edge.priority ?? ""}" placeholder="可选" /></label>
          <label class="switch-field"><input data-edge-field="default" type="checkbox" ${edge.default === true ? "checked" : ""} /> 默认分支</label>
          <button class="icon-button" data-remove-edge type="button" aria-label="删除连线">×</button>
        </div>
        <div class="edge-condition-area">
          ${edge.default === true
            ? '<p class="inline-help">默认分支不配置条件；同一条件节点只能有一个默认分支。</p>'
            : edge.condition === undefined
              ? '<div class="empty-inline"><span>当前连线没有路由条件</span><button class="button button--secondary button--small" data-add-root-condition type="button">＋ 添加条件</button></div>'
              : renderConditionEditor(edge.condition, edgeIndex, [], catalog, escapeHtml)}
        </div>
      </article>
    `).join("");
  }

  function renderAll() {
    renderMetadata();
    renderSummary();
    renderNodes();
    renderEdges();
  }

  function load(key) {
    const workflow = getWorkflows().find((item) => item.key === key);
    if (workflow === undefined) return;
    draft = structuredClone(workflow);
    elements.select.value = key;
    renderAll();
    elements.result.className = "config-result";
    elements.result.textContent = "已载入发布版本；再次发布前请递增版本号";
  }

  function renderSelect(selectedKey) {
    const workflows = getWorkflows();
    elements.select.innerHTML = workflows.map((workflow) => `
      <option value="${escapeHtml(workflow.key)}" ${workflow.key === selectedKey ? "selected" : ""}>${escapeHtml(workflow.name)} · v${workflow.version}</option>
    `).join("");
    const requested = workflows.find((workflow) => workflow.key === selectedKey)?.key ?? workflows[0]?.key;
    if (requested !== undefined) load(requested);
  }

  function updateNode(event) {
    const card = event.target.closest("[data-node-index]");
    if (card === null) return false;
    const node = draft.nodes[Number(card.dataset.nodeIndex)];
    if (node === undefined) return false;
    const field = event.target.dataset.nodeField;
    if (field !== undefined) {
      node[field] = event.target.value;
      if (field === "type") {
        if (event.target.value === "APPROVAL") node.config = defaultApprovalConfig();
        else delete node.config;
        return true;
      }
      return false;
    }
    const configField = event.target.dataset.nodeConfig;
    if (configField !== undefined) node.config[configField] = event.target.value;
    const assigneeField = event.target.dataset.assigneeField;
    if (assigneeField !== undefined) {
      const assigneeIndex = Number(event.target.closest("[data-assignee-index]").dataset.assigneeIndex);
      node.config.assignees[assigneeIndex][assigneeField] = event.target.value;
    }
    return false;
  }

  function updateEdge(event) {
    const card = event.target.closest("[data-edge-index]");
    const field = event.target.dataset.edgeField;
    if (card === null || field === undefined) return false;
    const edge = draft.edges[Number(card.dataset.edgeIndex)];
    if (field === "default") {
      if (event.target.checked) {
        edge.default = true;
        delete edge.condition;
      } else {
        delete edge.default;
        edge.condition = defaultCondition();
      }
      return true;
    }
    if (field === "priority") {
      if (event.target.value === "") delete edge.priority;
      else edge.priority = Number(event.target.value);
    } else edge[field] = event.target.value;
    return false;
  }

  elements.key.addEventListener("input", () => { draft.key = elements.key.value; });
  elements.name.addEventListener("input", () => { draft.name = elements.name.value; });
  elements.version.addEventListener("input", () => { draft.version = Number(elements.version.value); });
  elements.description.addEventListener("input", () => {
    if (elements.description.value === "") delete draft.description;
    else draft.description = elements.description.value;
  });
  elements.select.addEventListener("change", () => load(elements.select.value));
  elements.clone.addEventListener("click", () => {
    const workflow = getWorkflows().find((item) => item.key === elements.select.value);
    if (workflow === undefined) return;
    draft = structuredClone(workflow);
    draft.version += 1;
    draft.description = `${draft.description ?? draft.name}（配置中心发布的新版本）`;
    renderAll();
    setResult(`已克隆 ${draft.key} v${draft.version}，可以修改并发布`, true);
  });
  elements.create.addEventListener("click", () => {
    draft = minimalWorkflow();
    renderAll();
    setResult("已创建包含完整审批策略的最小流程", true);
  });
  elements.addNode.addEventListener("click", () => {
    const index = draft.nodes.length + 1;
    draft.nodes.push({ id: `node_${index}`, name: `新节点 ${index}`, type: "APPROVAL", config: defaultApprovalConfig() });
    renderNodes();
    renderEdges();
    renderSummary();
  });
  elements.addEdge.addEventListener("click", () => {
    const index = draft.edges.length + 1;
    draft.edges.push({ id: `edge_${index}`, source: draft.nodes[0]?.id ?? "start", target: draft.nodes.at(-1)?.id ?? "end" });
    renderEdges();
    renderSummary();
  });

  elements.nodeList.addEventListener("input", (event) => {
    if (event.target.dataset.nodeField === "id") {
      const nodeIndex = Number(event.target.closest("[data-node-index]").dataset.nodeIndex);
      const oldId = draft.nodes[nodeIndex].id;
      const newId = event.target.value;
      draft.nodes[nodeIndex].id = newId;
      for (const edge of draft.edges) {
        if (edge.source === oldId) edge.source = newId;
        if (edge.target === oldId) edge.target = newId;
      }
      for (const select of elements.edgeList.querySelectorAll('[data-edge-field="source"], [data-edge-field="target"]')) {
        const option = [...select.options].find((candidate) => candidate.value === oldId);
        if (option === undefined) continue;
        option.value = newId;
        option.textContent = option.textContent.replace(`(${oldId})`, `(${newId})`);
      }
      return;
    }
    if (updateNode(event)) {
      renderNodes();
      renderSummary();
    }
  });
  elements.nodeList.addEventListener("change", (event) => {
    if (event.target.dataset.nodeField === "id") {
      renderNodes();
      renderEdges();
      return;
    }
    if (updateNode(event)) {
      renderNodes();
      renderSummary();
    }
  });
  elements.nodeList.addEventListener("click", (event) => {
    const card = event.target.closest("[data-node-index]");
    if (card === null) return;
    const nodeIndex = Number(card.dataset.nodeIndex);
    if (event.target.closest("[data-remove-node]")) draft.nodes.splice(nodeIndex, 1);
    else if (event.target.closest("[data-add-assignee]")) draft.nodes[nodeIndex].config.assignees.push({ type: "USER", value: "manager-1" });
    else if (event.target.closest("[data-remove-assignee]")) {
      const assigneeIndex = Number(event.target.closest("[data-assignee-index]").dataset.assigneeIndex);
      draft.nodes[nodeIndex].config.assignees.splice(assigneeIndex, 1);
    } else return;
    renderNodes();
    renderEdges();
    renderSummary();
  });

  const handleEdgeMutation = (event) => {
    const conditionResult = applyConditionEvent(draft, event);
    if (conditionResult.handled) {
      if (conditionResult.render) renderEdges();
      renderSummary();
      return;
    }
    if (updateEdge(event)) renderEdges();
  };
  elements.edgeList.addEventListener("input", handleEdgeMutation);
  elements.edgeList.addEventListener("change", handleEdgeMutation);
  elements.edgeList.addEventListener("click", (event) => {
    const conditionResult = applyConditionEvent(draft, event);
    if (conditionResult.handled) {
      if (conditionResult.render) renderEdges();
      renderSummary();
      return;
    }
    const card = event.target.closest("[data-edge-index]");
    if (card !== null && event.target.closest("[data-remove-edge]")) {
      draft.edges.splice(Number(card.dataset.edgeIndex), 1);
      renderEdges();
      renderSummary();
    }
  });

  async function validateDraft() {
    return api("/api/workflows/validate", {
      method: "POST",
      body: JSON.stringify({ definition: draft }),
    });
  }

  elements.validate.addEventListener("click", async () => {
    elements.validate.disabled = true;
    try {
      const result = await validateDraft();
      setResult(`定义有效：${result.summary}`, true);
    } catch (error) {
      setResult(error.message, false);
    } finally {
      elements.validate.disabled = false;
    }
  });
  elements.publish.addEventListener("click", async () => {
    elements.publish.disabled = true;
    try {
      const response = await api("/api/config/workflows/publish", {
        method: "POST",
        body: JSON.stringify({ definition: draft }),
      });
      showToast("流程配置发布成功");
      await onPublished(response);
      setResult(`${response.workflow.key} v${response.workflow.version} 已发布并可发起业务`, true);
    } catch (error) {
      setResult(error.message, false);
    } finally {
      elements.publish.disabled = false;
    }
  });

  return { renderSelect, load };
}
