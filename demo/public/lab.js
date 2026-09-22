export async function initializeLab({ api, showToast, getWorkflows }) {
  const elements = {
    cards: document.querySelector("#lab-cards"),
    results: document.querySelector("#lab-results"),
    runAll: document.querySelector("#run-all-labs"),
    preset: document.querySelector("#validator-preset"),
    validationPreview: document.querySelector("#validation-preview"),
    validate: document.querySelector("#validate-workflow"),
    validationResult: document.querySelector("#validation-result"),
  };
  const scenarios = await api("/api/lab");
  const completed = new Map();

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function renderCards(runningId) {
    elements.cards.innerHTML = scenarios.map((scenario, index) => {
      const result = completed.get(scenario.id);
      const status = result === undefined ? "等待运行" : result.passed ? "验证通过" : "验证失败";
      return `
        <article class="lab-card ${result?.passed ? "lab-card--passed" : ""}">
          <span class="lab-card__number">${String(index + 1).padStart(2, "0")}</span>
          <div><h3>${escapeHtml(scenario.title)}</h3><p>${escapeHtml(scenario.description)}</p></div>
          <button class="button button--lab" data-lab-id="${scenario.id}" type="button" ${runningId === scenario.id ? "disabled" : ""}>
            ${runningId === scenario.id ? "运行中…" : status}
          </button>
        </article>
      `;
    }).join("");
  }

  function renderResult(result) {
    const existing = elements.results.querySelector(`[data-result-id="${result.id}"]`);
    existing?.remove();
    elements.results.insertAdjacentHTML("afterbegin", `
      <article class="lab-result ${result.passed ? "lab-result--passed" : "lab-result--failed"}" data-result-id="${result.id}">
        <div class="lab-result__header">
          <div><span>${result.passed ? "PASS" : "FAIL"}</span><h3>${escapeHtml(result.title)}</h3><p>${escapeHtml(result.summary)}</p></div>
          <div class="lab-result__evidence">${result.evidence.map((item) => `<span><small>${escapeHtml(item.label)}</small><strong>${escapeHtml(item.value)}</strong></span>`).join("")}</div>
        </div>
        <div class="lab-result__steps">
          ${result.steps.map((item) => `<div><i>${item.passed ? "✓" : "×"}</i><span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></span></div>`).join("")}
        </div>
      </article>
    `);
  }

  async function runScenario(id) {
    renderCards(id);
    try {
      const result = await api(`/api/lab/${id}`, { method: "POST", body: "{}" });
      completed.set(id, result);
      renderResult(result);
      return result;
    } catch (error) {
      showToast(`实验运行失败：${error.message}`, "error");
      return undefined;
    } finally {
      renderCards();
    }
  }

  elements.cards.addEventListener("click", (event) => {
    const button = event.target.closest("[data-lab-id]");
    if (button !== null) void runScenario(button.dataset.labId);
  });

  elements.runAll.addEventListener("click", async () => {
    elements.runAll.disabled = true;
    completed.clear();
    elements.results.innerHTML = "";
    let passed = 0;
    for (const scenario of scenarios) {
      const result = await runScenario(scenario.id);
      if (result?.passed) passed += 1;
    }
    elements.runAll.disabled = false;
    showToast(`${passed} / ${scenarios.length} 个能力实验通过`, passed === scenarios.length ? "success" : "error");
  });

  function presetDefinition(name) {
    const definition = structuredClone(getWorkflows()[0]);
    if (name === "cycle") {
      definition.edges = definition.edges.map((edge) => edge.id === "e_manager_amount" ? { ...edge, target: "start" } : edge);
    }
    if (name === "unknown") definition.script = "return context.amount > 0";
    return definition;
  }

  function updatePreset() {
    const definition = presetDefinition(elements.preset.value);
    const presetDetails = {
      valid: ["标准拓扑", "所有节点可达", "仅使用受支持字段"],
      cycle: ["故意把经理审批连回开始节点", "预期：检测到环路并拒绝"],
      unknown: ["故意增加不受支持的 script 属性", "预期：严格字段白名单拒绝"],
    };
    elements.validationPreview.innerHTML = `
      <div><span>流程</span><strong>${escapeHtml(definition.name)} · v${definition.version}</strong></div>
      <div><span>结构</span><strong>${definition.nodes.length} 节点 / ${definition.edges.length} 连线</strong></div>
      <ul>${presetDetails[elements.preset.value].map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    `;
    elements.validationResult.className = "validation-result";
    elements.validationResult.textContent = "等待校验";
  }

  elements.preset.addEventListener("change", updatePreset);
  elements.validate.addEventListener("click", async () => {
    elements.validate.disabled = true;
    try {
      const definition = presetDefinition(elements.preset.value);
      const result = await api("/api/workflows/validate", {
        method: "POST",
        body: JSON.stringify({ definition }),
      });
      elements.validationResult.className = "validation-result validation-result--passed";
      elements.validationResult.textContent = `✓ 定义有效：${result.summary}`;
    } catch (error) {
      elements.validationResult.className = "validation-result validation-result--failed";
      elements.validationResult.textContent = `× ${error.message}`;
    } finally {
      elements.validate.disabled = false;
    }
  });

  renderCards();
  updatePreset();
}
