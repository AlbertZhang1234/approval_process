import {
  createDisplayNameResolver,
  escapeHtml,
  formatTime,
  statusLabels,
  transitionLabels,
} from "./shared.js";

const PRIMARY_FIELDS = { "expense-approval": "amount", "leave-approval": "days" };

function isReturnedToApplicant(instance) {
  if (instance.status !== "RUNNING" || instance.currentExecutionId === undefined) return false;
  const execution = instance.executions.find((candidate) => candidate.id === instance.currentExecutionId);
  return execution !== undefined && execution.nodeId === "start" && execution.round >= 2;
}

function visitedApprovalNodes(instance) {
  const visited = new Set(instance.executions.map((execution) => execution.nodeId));
  return instance.definition.nodes.filter(
    (node) => node.type === "APPROVAL" && visited.has(node.id),
  );
}

function renderFlowTrack(instance, displayName) {
  const nodeMap = new Map(instance.definition.nodes.map((node) => [node.id, node]));
  const transitionByTarget = new Map(instance.transitions.map((edge) => [edge.toExecutionId, edge]));
  return instance.executions
    .map((execution, index) => {
      const node = nodeMap.get(execution.nodeId);
      const task = instance.tasks.find((candidate) => candidate.executionId === execution.id);
      const current = execution.status === "ACTIVE";
      const failed = execution.result === "REJECTED";
      const roundBadge = execution.round > 1 ? `<em class="step__round">第 ${execution.round} 轮</em>` : "";
      const transition = transitionByTarget.get(execution.id);
      const marker = transition !== undefined && index > 0
        ? `<em class="step__transition step__transition--${transition.type.toLowerCase()}">${transitionLabels[transition.type] ?? transition.type}</em>`
        : "";
      const detail = current
        ? "当前节点"
        : failed
          ? "已驳回"
          : execution.status === "CANCELED"
            ? "已终止"
            : task
              ? statusLabels[task.status] ?? task.status
              : "已通过";
      const assignees = instance.tasks
        .filter((candidate) => candidate.executionId === execution.id)
        .map((candidate) => displayName(candidate.assigneeId));
      return `
        <div class="step ${current ? "step--active" : ""} ${failed ? "step--failed" : ""}">
          <span class="step__dot">${current ? index + 1 : failed ? "×" : "✓"}</span>
          <div class="step__body">
            ${marker}${roundBadge}
            <strong>${escapeHtml(node?.name ?? execution.nodeId)}</strong>
            <small>${escapeHtml(detail)}${assignees.length > 0 ? ` · ${escapeHtml(assignees.join("、"))}` : ""}</small>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderTask(task, node, instance, displayName) {
  const targets = visitedApprovalNodes(instance);
  const targetSelect = `
    <select name="targetNodeId" aria-label="退回目标节点">
      ${targets.map((candidate) => `<option value="${escapeHtml(candidate.id)}">${escapeHtml(candidate.name)}</option>`).join("")}
    </select>
  `;
  return `
    <form class="task" data-task-id="${escapeHtml(task.id)}" data-operator-id="${escapeHtml(task.assigneeId)}">
      <div class="task__identity">
        <span class="avatar">${escapeHtml(displayName(task.assigneeId).slice(0, 1))}</span>
        <span><small>${escapeHtml(node?.name ?? task.nodeId)}</small><strong>${escapeHtml(displayName(task.assigneeId))}</strong></span>
      </div>
      <input name="comment" aria-label="审批意见" placeholder="审批意见（可选）" />
      <button class="button button--approve" name="action" value="APPROVE" type="submit">同意</button>
      <button class="button button--reject" name="action" value="REJECT" type="submit">驳回</button>
      <button class="button button--warn" name="action" value="REJECT_TO_APPLICANT" type="submit">退回申请人</button>
      <div class="task__return">
        ${targetSelect}
        <button class="button button--warn button--outline" name="action" value="RETURN_TO_NODE" type="submit">退回该节点</button>
      </div>
    </form>
  `;
}

function renderResubmitForm(instance) {
  const field = PRIMARY_FIELDS[instance.definitionKey];
  const valueInput = field !== undefined
    ? `<input name="value" type="number" min="0" step="0.5" value="${escapeHtml(String(instance.context[field] ?? 0))}" required aria-label="修改后的${field === "amount" ? "金额" : "天数"}" />`
    : `<textarea name="context" aria-label="业务上下文 JSON" rows="2">${escapeHtml(JSON.stringify(instance.context))}</textarea>`;
  return `
    <form class="resubmit" data-instance-id="${escapeHtml(instance.id)}" data-applicant-id="${escapeHtml(instance.applicantId)}">
      <div class="resubmit__heading">
        <strong>已退回申请人 · 第 ${escapeHtml(String(instance.contextRevision + 1))} 次修订待提交</strong>
        <small>updateContext：修改业务上下文后重新进入审批，条件节点按新值重新路由</small>
      </div>
      ${valueInput}
      <input name="comment" placeholder="修改说明（可选）" aria-label="修改说明" />
      <button class="button button--primary" type="submit">重新提交 <span>→</span></button>
    </form>
  `;
}

function renderTerminateForm(instance) {
  return `
    <div class="terminate" data-instance-id="${escapeHtml(instance.id)}">
      <form class="terminate__form" data-terminate-kind="withdraw" data-operator-id="${escapeHtml(instance.applicantId)}">
        <input name="reason" placeholder="撤回原因（可选）" aria-label="撤回原因" />
        <button class="button button--reject" type="submit">申请人撤回</button>
      </form>
      <form class="terminate__form" data-terminate-kind="cancel">
        <select name="operatorId" aria-label="取消操作人">
          <option value="manager-1">李经理（管理员）</option>
          <option value="dept-manager-1">孙部门负责人（管理员）</option>
        </select>
        <input name="reason" placeholder="取消原因（可选）" aria-label="取消原因" />
        <button class="button button--reject button--outline" type="submit">取消实例</button>
      </form>
    </div>
  `;
}

function renderTransitionList(instance) {
  const nodeMap = new Map(instance.definition.nodes.map((node) => [node.id, node]));
  const executionNode = new Map(instance.executions.map((execution) => [execution.id, execution.nodeId]));
  return instance.transitions
    .map((edge) => {
      const from = edge.fromExecutionId === undefined ? "发起" : nodeMap.get(executionNode.get(edge.fromExecutionId))?.name ?? edge.fromExecutionId;
      const to = nodeMap.get(executionNode.get(edge.toExecutionId))?.name ?? edge.toExecutionId;
      return `<span><i class="transition-tag transition-tag--${edge.type.toLowerCase()}">${transitionLabels[edge.type] ?? edge.type}</i>${escapeHtml(from)} → ${escapeHtml(to)}</span>`;
    })
    .join("");
}

export function createInstanceViews({ api, showToast, getData, refresh }) {
  const elements = {
    list: document.querySelector("#instances"),
    count: document.querySelector("#instance-count"),
    emptyTemplate: document.querySelector("#empty-template"),
  };
  const displayName = createDisplayNameResolver(() => getData().people ?? {});

  function renderInstance(instance) {
    const nodeMap = new Map(instance.definition.nodes.map((node) => [node.id, node]));
    const field = PRIMARY_FIELDS[instance.definitionKey];
    const valueText = field !== undefined
      ? field === "amount"
        ? `¥ ${Number(instance.context.amount).toLocaleString("zh-CN")}`
        : `${instance.context.days} 天`
      : `${Object.keys(instance.context).length} 个上下文字段`;
    const pendingTasks = instance.tasks.filter((task) => task.status === "PENDING");
    const returned = isReturnedToApplicant(instance);
    let actions = "";
    if (returned) {
      actions = renderResubmitForm(instance);
    } else if (pendingTasks.length > 0) {
      actions = pendingTasks
        .map((task) => renderTask(task, nodeMap.get(task.nodeId), instance, displayName))
        .join("");
    } else {
      actions = `<div class="result result--${instance.status.toLowerCase()}">${statusLabels[instance.status] ?? instance.status}</div>`;
    }
    const terminate = instance.status === "RUNNING" ? renderTerminateForm(instance) : "";

    return `
      <article class="instance-card">
        <div class="instance-card__header">
          <div>
            <div class="instance-card__meta">
              <span class="status status--${instance.status.toLowerCase()}">${statusLabels[instance.status]}</span>
              <span>${escapeHtml(instance.definition.name)}</span>
              <span>v${instance.definitionVersion}</span>
              <span>revision ${instance.contextRevision}</span>
            </div>
            <h3>${escapeHtml(instance.business.id)}</h3>
            <p>申请人 ${escapeHtml(displayName(instance.applicantId))} · ${formatTime(instance.createdAt)} · ${escapeHtml(instance.business.type)}</p>
          </div>
          <strong class="instance-card__value">${escapeHtml(valueText)}</strong>
        </div>
        <div class="flow-track">${renderFlowTrack(instance, displayName)}</div>
        <div class="task-area">${actions}</div>
        ${terminate}
        <details class="audit-details">
          <summary>查看完整审计数据</summary>
          <div class="audit-grid">
            <div><span>实例 ID</span><code>${escapeHtml(instance.id)}</code></div>
            <div><span>上下文快照</span><code>${escapeHtml(JSON.stringify(instance.context))}</code></div>
            <div><span>执行记录</span><code>${instance.executions.length} 条</code></div>
            <div><span>迁移记录</span><code>${instance.transitions.length} 条</code></div>
            <div><span>迁移轨迹</span><code class="transition-list">${renderTransitionList(instance) || "—"}</code></div>
            <div><span>任务状态</span><code>${escapeHtml(instance.tasks.map((task) => `${displayName(task.assigneeId)}:${task.status}`).join(" · "))}</code></div>
            <div><span>乐观锁版本</span><code>v${instance.version}</code></div>
            <div><span>上下文修订</span><code>revision ${instance.contextRevision}</code></div>
          </div>
        </details>
      </article>
    `;
  }

  function render() {
    const instances = getData().instances ?? [];
    elements.count.textContent = `${instances.length} 个实例`;
    if (instances.length === 0) {
      elements.list.replaceChildren(elements.emptyTemplate.content.cloneNode(true));
      return;
    }
    elements.list.innerHTML = instances.map(renderInstance).join("");
  }

  async function submitTaskAction(form, submitter, formData) {
    const action = submitter.value;
    const body = {
      operatorId: form.dataset.operatorId,
      action,
      comment: formData.get("comment"),
    };
    if (action === "RETURN_TO_NODE") body.targetNodeId = formData.get("targetNodeId");
    await api(`/api/tasks/${encodeURIComponent(form.dataset.taskId)}/actions`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const messages = {
      APPROVE: "已同意，流程继续推进",
      REJECT: "已驳回，流程已结束",
      REJECT_TO_APPLICANT: "已退回申请人，等待修改后重新提交",
      RETURN_TO_NODE: "已退回目标节点，新轮次任务已创建",
    };
    showToast(messages[action] ?? "操作成功");
  }

  async function submitResubmit(form, formData) {
    const body = { operatorId: form.dataset.applicantId };
    if (formData.get("value") !== null) body.value = Number(formData.get("value"));
    if (formData.get("context") !== null && String(formData.get("context")).trim() !== "") {
      body.context = JSON.parse(String(formData.get("context")));
    }
    const comment = formData.get("comment");
    if (typeof comment === "string" && comment.trim() !== "") body.comment = comment.trim();
    await api(`/api/instances/${encodeURIComponent(form.dataset.instanceId)}/context`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    showToast("已重新提交，流程带新上下文继续流转");
  }

  async function submitTerminate(form, formData) {
    const kind = form.dataset.terminateKind;
    const body = {
      operatorId: kind === "withdraw" ? form.dataset.operatorId : formData.get("operatorId"),
    };
    const reason = formData.get("reason");
    if (typeof reason === "string" && reason.trim() !== "") body.reason = reason.trim();
    await api(`/api/instances/${encodeURIComponent(form.closest("[data-instance-id]").dataset.instanceId)}/${kind}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    showToast(kind === "withdraw" ? "实例已撤回" : "实例已取消");
  }

  elements.list.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const isTask = form.classList.contains("task");
    const isResubmit = form.classList.contains("resubmit");
    const isTerminate = form.classList.contains("terminate__form");
    if (!isTask && !isResubmit && !isTerminate) return;
    event.preventDefault();
    const formData = new FormData(form);
    const controls = form.querySelectorAll("button, input, select, textarea");
    controls.forEach((control) => { control.disabled = true; });
    try {
      if (isTask) await submitTaskAction(form, event.submitter, formData);
      else if (isResubmit) await submitResubmit(form, formData);
      else await submitTerminate(form, formData);
      await refresh();
    } catch (error) {
      showToast(error.message, "error");
      controls.forEach((control) => { control.disabled = false; });
    }
  });

  return { render };
}
