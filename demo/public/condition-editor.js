export function defaultCondition() {
  return { field: "amount", operator: "GTE", value: 5000 };
}

function kindOf(condition) {
  if (condition === undefined) return "predicate";
  if ("all" in condition) return "all";
  if ("any" in condition) return "any";
  if ("not" in condition) return "not";
  return "predicate";
}

function childAt(condition, index) {
  const kind = kindOf(condition);
  if (kind === "all" || kind === "any") return condition[kind][index];
  if (kind === "not" && index === 0) return condition.not;
  return undefined;
}

function nodeAt(root, path) {
  let current = root;
  for (const index of path) current = childAt(current, index);
  return current;
}

function replaceAt(root, path, replacement) {
  if (path.length === 0) return replacement;
  const parent = nodeAt(root, path.slice(0, -1));
  const childIndex = path.at(-1);
  const kind = kindOf(parent);
  if (kind === "all" || kind === "any") parent[kind][childIndex] = replacement;
  else if (kind === "not") parent.not = replacement;
  return root;
}

function removeAt(root, path) {
  if (path.length === 0) return undefined;
  const parent = nodeAt(root, path.slice(0, -1));
  const childIndex = path.at(-1);
  const kind = kindOf(parent);
  if (kind === "all" || kind === "any") parent[kind].splice(childIndex, 1);
  return root;
}

function pathFrom(element) {
  const value = element.closest("[data-condition-path]")?.dataset.conditionPath ?? "";
  return value === "" ? [] : value.split(".").map(Number);
}

function valueDescriptor(value) {
  if (value === null) return { type: "null", text: "" };
  if (Array.isArray(value)) {
    const numeric = value.every((item) => typeof item === "number");
    return { type: numeric ? "number-list" : "string-list", text: value.join(", ") };
  }
  if (typeof value === "number") return { type: "number", text: String(value) };
  if (typeof value === "boolean") return { type: "boolean", text: String(value) };
  return { type: "string", text: String(value ?? "") };
}

function parseValue(type, raw) {
  if (type === "null") return null;
  if (type === "number") return Number(raw);
  if (type === "boolean") return raw === "true";
  if (type === "number-list") return raw.split(",").map((item) => Number(item.trim())).filter(Number.isFinite);
  if (type === "string-list") return raw.split(",").map((item) => item.trim()).filter(Boolean);
  return raw;
}

function conditionForKind(kind) {
  if (kind === "all" || kind === "any") return { [kind]: [defaultCondition()] };
  if (kind === "not") return { not: defaultCondition() };
  return defaultCondition();
}

export function renderConditionEditor(condition, edgeIndex, path, catalog, escapeHtml) {
  const kind = kindOf(condition);
  const pathValue = path.join(".");
  const header = `
    <div class="condition-toolbar">
      <label>组合方式
        <select data-condition-kind>
          ${[["predicate", "单项条件"], ["all", "全部满足 (all)"], ["any", "任一满足 (any)"], ["not", "条件取反 (not)"]].map(([value, label]) => `<option value="${value}" ${kind === value ? "selected" : ""}>${label}</option>`).join("")}
        </select>
      </label>
      <button class="icon-button" data-condition-remove type="button" aria-label="删除条件">×</button>
    </div>
  `;
  if (kind === "predicate") {
    const descriptor = valueDescriptor(condition.value);
    const valueInput = condition.operator === "EXISTS" ? "" : `
      <label>值类型
        <select data-condition-value-type>
          ${[["string", "文本"], ["number", "数字"], ["boolean", "布尔"], ["string-list", "文本列表"], ["number-list", "数字列表"], ["null", "空值"]].map(([value, label]) => `<option value="${value}" ${descriptor.type === value ? "selected" : ""}>${label}</option>`).join("")}
        </select>
      </label>
      <label>比较值<input data-condition-value value="${escapeHtml(descriptor.text)}" ${descriptor.type === "null" ? "disabled" : ""} placeholder="列表用逗号分隔" /></label>
    `;
    return `
      <div class="condition-block condition-block--predicate" data-edge-index="${edgeIndex}" data-condition-path="${pathValue}">
        ${header}
        <div class="condition-predicate">
          <label>字段路径<input data-condition-field value="${escapeHtml(condition.field)}" placeholder="例如 applicant.department" /></label>
          <label>操作符<select data-condition-operator>${catalog.conditionOperators.map((operator) => `<option value="${operator}" ${condition.operator === operator ? "selected" : ""}>${operator}</option>`).join("")}</select></label>
          ${valueInput}
        </div>
      </div>
    `;
  }
  const children = kind === "not" ? [condition.not] : condition[kind];
  return `
    <div class="condition-block condition-block--group" data-edge-index="${edgeIndex}" data-condition-path="${pathValue}">
      ${header}
      <div class="condition-children">
        ${children.map((child, index) => renderConditionEditor(child, edgeIndex, [...path, index], catalog, escapeHtml)).join("")}
      </div>
      ${kind === "not" ? "" : '<button class="button button--secondary button--small" data-condition-add-child type="button">＋ 添加子条件</button>'}
    </div>
  `;
}

export function applyConditionEvent(draft, event) {
  const target = event.target;
  const block = target.closest("[data-edge-index]");
  if (block === null) return { handled: false, render: false };
  const edge = draft.edges[Number(block.dataset.edgeIndex)];
  if (edge === undefined) return { handled: false, render: false };
  if (target.closest("[data-add-root-condition]")) {
    edge.condition = defaultCondition();
    delete edge.default;
    return { handled: true, render: true };
  }
  if (edge.condition === undefined) return { handled: false, render: false };
  const path = pathFrom(target);
  const condition = nodeAt(edge.condition, path);
  if (target.matches("[data-condition-kind]")) {
    edge.condition = replaceAt(edge.condition, path, conditionForKind(target.value));
    return { handled: true, render: true };
  }
  if (target.closest("[data-condition-remove]")) {
    edge.condition = removeAt(edge.condition, path);
    return { handled: true, render: true };
  }
  if (target.closest("[data-condition-add-child]")) {
    const kind = kindOf(condition);
    condition[kind].push(defaultCondition());
    return { handled: true, render: true };
  }
  if (kindOf(condition) !== "predicate") return { handled: false, render: false };
  if (target.matches("[data-condition-field]")) condition.field = target.value;
  else if (target.matches("[data-condition-operator]")) {
    condition.operator = target.value;
    if (target.value === "EXISTS") delete condition.value;
    else if (!("value" in condition)) condition.value = "";
    return { handled: true, render: true };
  } else if (target.matches("[data-condition-value-type]")) {
    condition.value = parseValue(target.value, target.closest(".condition-predicate").querySelector("[data-condition-value]")?.value ?? "");
    return { handled: true, render: true };
  } else if (target.matches("[data-condition-value]")) {
    const type = target.closest(".condition-predicate").querySelector("[data-condition-value-type]").value;
    condition.value = parseValue(type, target.value);
  } else return { handled: false, render: false };
  return { handled: true, render: false };
}
