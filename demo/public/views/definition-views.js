import { escapeHtml } from "./shared.js";

export function createDefinitionViews({ getData }) {
  const elements = { grid: document.querySelector("#definitions") };

  function render() {
    const workflows = getData().workflows ?? [];
    elements.grid.innerHTML = workflows.map((workflow) => {
      const nodeIndex = new Map(workflow.nodes.map((node) => [node.id, node]));
      const nodes = workflow.nodes.map((node) => {
        const approval = node.type === "APPROVAL"
          ? `<small>${node.config.mode} · ${node.config.assignees.map((item) => `${item.type}:${item.value}`).join(" + ")}</small>`
          : "";
        return `<div class="definition-node definition-node--${node.type.toLowerCase()}"><span>${escapeHtml(node.type)}</span><strong>${escapeHtml(node.name)}</strong>${approval}</div>`;
      }).join('<span class="definition-arrow">→</span>');
      const conditions = workflow.edges.filter((edge) => edge.condition !== undefined).map((edge) => {
        const target = nodeIndex.get(edge.target)?.name ?? edge.target;
        return `<code>${escapeHtml(JSON.stringify(edge.condition))}</code><span>→ ${escapeHtml(target)}</span>`;
      }).join("");
      return `
        <article class="definition-card">
          <div class="definition-card__header"><div><span>${escapeHtml(workflow.key)} · v${workflow.version}</span><h3>${escapeHtml(workflow.name)}</h3></div><strong>${workflow.nodes.length} 节点</strong></div>
          <p>${escapeHtml(workflow.description ?? "")}</p>
          <div class="definition-flow">${nodes}</div>
          ${conditions === "" ? "" : `<div class="definition-conditions"><strong>条件路由</strong>${conditions}</div>`}
        </article>
      `;
    }).join("");
  }

  return { render };
}
