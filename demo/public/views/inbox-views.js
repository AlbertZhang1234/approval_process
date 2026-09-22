import { createDisplayNameResolver, escapeHtml, formatTime, statusLabels } from "./shared.js";

function queryToParams(state) {
  const params = new URLSearchParams({ assigneeId: state.assigneeId });
  if (state.status) params.set("status", state.status);
  if (state.businessType.trim() !== "") params.set("businessType", state.businessType.trim());
  params.set("limit", String(state.limit));
  params.set("orderBy", state.orderBy);
  if (state.cursor !== undefined) {
    params.set("cursorCreatedAt", state.cursor.createdAt);
    params.set("cursorId", state.cursor.id);
  }
  return params;
}

export function createInboxViews({ api, showToast, getData }) {
  const elements = {
    form: document.querySelector("#inbox-query-form"),
    assignee: document.querySelector("#inbox-assignee"),
    status: document.querySelector("#inbox-status"),
    businessType: document.querySelector("#inbox-business-type"),
    limit: document.querySelector("#inbox-limit"),
    order: document.querySelector("#inbox-order"),
    prev: document.querySelector("#inbox-prev"),
    next: document.querySelector("#inbox-next"),
    list: document.querySelector("#inbox"),
    count: document.querySelector("#inbox-count"),
    lookupForm: document.querySelector("#business-lookup-form"),
    lookupType: document.querySelector("#lookup-type"),
    lookupId: document.querySelector("#lookup-id"),
    lookupStatus: document.querySelector("#lookup-status"),
    lookupResult: document.querySelector("#business-lookup-result"),
  };
  const displayName = createDisplayNameResolver(() => getData().people ?? {});
  let currentPage = { tasks: [], nextCursor: undefined };
  const cursorStack = [];

  function readControls() {
    return {
      assigneeId: elements.assignee.value,
      status: elements.status.value,
      businessType: elements.businessType.value,
      limit: Number(elements.limit.value),
      orderBy: elements.order.value,
    };
  }

  function renderPeople() {
    const people = getData().people ?? {};
    const selected = elements.assignee.value || "manager-1";
    elements.assignee.innerHTML = Object.entries(people)
      .map(([id, name]) => `<option value="${escapeHtml(id)}" ${id === selected ? "selected" : ""}>${escapeHtml(name)}</option>`)
      .join("");
  }

  function renderPage() {
    const instanceById = new Map((getData().instances ?? []).map((instance) => [instance.id, instance]));
    const total = currentPage.tasks.length;
    elements.count.textContent = `${total} 条${currentPage.nextCursor === undefined ? "" : " · 还有下一页"}`;
    if (total === 0) {
      elements.list.innerHTML = '<p class="compact-empty">当前查询条件下没有任务。</p>';
    } else {
      elements.list.innerHTML = currentPage.tasks.map((task) => {
        const instance = instanceById.get(task.instanceId);
        const node = instance?.definition.nodes.find((candidate) => candidate.id === task.nodeId);
        return `
          <a class="inbox-item" href="#instances-section">
            <span class="avatar">${escapeHtml(displayName(task.assigneeId).slice(0, 1))}</span>
            <span><strong>${escapeHtml(displayName(task.assigneeId))}</strong><small>${escapeHtml(instance?.business.id ?? task.instanceId)}</small></span>
            <span class="inbox-item__node">${escapeHtml(node?.name ?? task.nodeId)} · ${escapeHtml(statusLabels[task.status] ?? task.status)}</span>
          </a>
        `;
      }).join("");
    }
    elements.next.disabled = currentPage.nextCursor === undefined;
    elements.prev.disabled = cursorStack.length === 0;
  }

  async function loadPage(cursor) {
    const base = readControls();
    const state = { ...base, ...(cursor === undefined ? {} : { cursor }) };
    currentPage = await api(`/api/tasks?${queryToParams(state).toString()}`);
    renderPage();
  }

  elements.form.addEventListener("submit", (event) => event.preventDefault());
  for (const control of [elements.assignee, elements.status, elements.businessType, elements.limit, elements.order]) {
    control.addEventListener("change", async () => {
      cursorStack.length = 0;
      await loadPage();
    });
  }
  elements.next.addEventListener("click", async () => {
    if (currentPage.nextCursor === undefined) return;
    cursorStack.push(currentPage.nextCursor);
    await loadPage(cursorStack.at(-1));
  });
  elements.prev.addEventListener("click", async () => {
    cursorStack.pop();
    await loadPage(cursorStack.at(-1));
  });

  function renderLookupResult(payload) {
    if (!payload.found || payload.instance === null) {
      elements.lookupResult.innerHTML = '<span class="lookup-miss">未找到符合条件的实例。</span>';
      return;
    }
    const instance = payload.instance;
    elements.lookupResult.innerHTML = `
      <div class="lookup-hit">
        <div>
          <span class="status status--${instance.status.toLowerCase()}">${statusLabels[instance.status] ?? instance.status}</span>
          <strong>${escapeHtml(instance.business.id)}</strong>
          <small>${escapeHtml(instance.definition.name)} · v${instance.definitionVersion} · revision ${instance.contextRevision}</small>
        </div>
        <div>
          <small>申请人 ${escapeHtml(displayName(instance.applicantId))} · ${formatTime(instance.createdAt)}</small>
          <code>${escapeHtml(instance.id)}</code>
        </div>
      </div>
    `;
  }

  elements.lookupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const params = new URLSearchParams({
      businessType: elements.lookupType.value.trim(),
      businessId: elements.lookupId.value.trim(),
    });
    if (elements.lookupStatus.value !== "") params.set("status", elements.lookupStatus.value);
    try {
      renderLookupResult(await api(`/api/instances/by-business?${params.toString()}`));
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  async function render() {
    renderPeople();
    if (elements.assignee.value === "") return;
    await loadPage(cursorStack.at(-1));
  }

  return { render };
}
