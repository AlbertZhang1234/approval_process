export function createBusinessController({ api, showToast, getData, refresh }) {
  const elements = {
    form: document.querySelector("#start-form"),
    workflowPicker: document.querySelector("#workflow-picker"),
    businessId: document.querySelector("#business-id"),
    primaryValueField: document.querySelector("#primary-value-field"),
    contextValue: document.querySelector("#context-value"),
    valueLabel: document.querySelector("#value-label"),
    valueHint: document.querySelector("#value-hint"),
    applicantId: document.querySelector("#applicant-id"),
    businessType: document.querySelector("#business-type"),
    businessUrl: document.querySelector("#business-url"),
    idempotencyKey: document.querySelector("#idempotency-key"),
    contextFields: document.querySelector("#business-context-fields"),
    addContext: document.querySelector("#add-business-context"),
  };
  let selectedWorkflow = "expense-approval";

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function contextRow(key = "", value = "", type = "string") {
    return `
      <div class="key-value-row">
        <input data-context-key aria-label="上下文字段名" placeholder="字段名" value="${escapeHtml(key)}" />
        <select data-context-type aria-label="字段值类型">
          ${["string", "number", "boolean"].map((item) => `<option value="${item}" ${item === type ? "selected" : ""}>${item === "string" ? "文本" : item === "number" ? "数字" : "布尔"}</option>`).join("")}
        </select>
        <input data-context-value aria-label="上下文字段值" placeholder="字段值" value="${escapeHtml(value)}" />
        <button class="icon-button" data-remove-context type="button" aria-label="删除上下文字段">×</button>
      </div>
    `;
  }

  function setContextFields(fields) {
    elements.contextFields.innerHTML = fields.map(({ key, value, type }) => contextRow(key, value, type)).join("");
  }

  function collectContext() {
    const context = {};
    for (const row of elements.contextFields.querySelectorAll(".key-value-row")) {
      const key = row.querySelector("[data-context-key]").value.trim();
      if (key === "") continue;
      if (Object.hasOwn(context, key)) throw new Error(`业务上下文字段 '${key}' 重复`);
      const type = row.querySelector("[data-context-type]").value;
      const raw = row.querySelector("[data-context-value]").value;
      if (type === "number") {
        const number = Number(raw);
        if (!Number.isFinite(number)) throw new Error(`字段 '${key}' 必须是有效数字`);
        context[key] = number;
      } else if (type === "boolean") {
        if (raw !== "true" && raw !== "false") throw new Error(`字段 '${key}' 的布尔值必须是 true 或 false`);
        context[key] = raw === "true";
      } else {
        context[key] = raw;
      }
    }
    return context;
  }

  function updateFormForWorkflow() {
    const expense = selectedWorkflow === "expense-approval";
    const leave = selectedWorkflow === "leave-approval";
    const builtIn = expense || leave;
    elements.primaryValueField.hidden = !builtIn;
    elements.contextValue.required = builtIn;
    elements.valueLabel.textContent = expense ? "报销金额（元）" : "请假天数";
    elements.valueHint.textContent = expense ? "达到 5,000 元将进入财务审批" : "超过 3 天将进入人事审批";
    elements.contextValue.value = expense ? "6800" : leave ? "5" : "0";
    const prefix = expense ? "EXP" : leave ? "LEAVE" : "BIZ";
    const businessId = `${prefix}-${String(Date.now()).slice(-6)}`;
    elements.businessId.value = businessId;
    elements.businessType.value = expense ? "expense" : leave ? "leave" : "custom";
    elements.businessUrl.value = `/business/${businessId}`;
    elements.idempotencyKey.value = "";
    setContextFields(builtIn ? [] : [
      { key: "reviewerId", value: "special-1", type: "string" },
      { key: "amount", value: "1000", type: "number" },
    ]);
    elements.workflowPicker.querySelectorAll(".workflow-option").forEach((option) => {
      option.classList.toggle("workflow-option--active", option.querySelector("input").value === selectedWorkflow);
    });
  }

  function render() {
    const { workflows, people } = getData();
    if (!workflows.some((workflow) => workflow.key === selectedWorkflow)) selectedWorkflow = workflows[0]?.key ?? "";
    elements.workflowPicker.innerHTML = workflows.map((workflow) => `
      <label class="workflow-option ${workflow.key === selectedWorkflow ? "workflow-option--active" : ""}">
        <input type="radio" name="workflowKey" value="${escapeHtml(workflow.key)}" ${workflow.key === selectedWorkflow ? "checked" : ""} />
        <span class="workflow-option__mark">${workflow.key === "expense-approval" ? "¥" : workflow.key === "leave-approval" ? "休" : "◇"}</span>
        <span><strong>${escapeHtml(workflow.name)}</strong><small>${workflow.nodes.length} 个节点</small></span>
      </label>
    `).join("");
    elements.applicantId.innerHTML = Object.entries(people)
      .filter(([id]) => id.startsWith("employee"))
      .map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`)
      .join("");
    updateFormForWorkflow();
  }

  elements.workflowPicker.addEventListener("change", (event) => {
    selectedWorkflow = event.target.value;
    updateFormForWorkflow();
  });
  elements.addContext.addEventListener("click", () => elements.contextFields.insertAdjacentHTML("beforeend", contextRow()));
  elements.contextFields.addEventListener("click", (event) => event.target.closest("[data-remove-context]")?.closest(".key-value-row")?.remove());
  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = elements.form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(elements.form));
      body.context = collectContext();
      await api("/api/instances", { method: "POST", body: JSON.stringify(body) });
      await refresh();
      showToast("审批已发起，第一条待办已生成");
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      submitButton.disabled = false;
    }
  });

  return {
    render,
    selectWorkflow(key) {
      selectedWorkflow = key;
      render();
    },
  };
}
