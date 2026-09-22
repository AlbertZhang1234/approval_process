import { escapeHtml, eventLabels, formatTime, outboxStatusLabels } from "./shared.js";

function outboxStatusClass(status) {
  return `outbox-badge outbox-badge--${status.toLowerCase()}`;
}

function renderEventRow(record) {
  const { event } = record;
  return `
    <div class="event-item">
      <span class="event-item__pulse"></span>
      <div>
        <strong>${escapeHtml(eventLabels[event.type] ?? event.type)}</strong>
        <small>${escapeHtml(event.business.id)} · ${formatTime(event.occurredAt)}${record.lastError === undefined ? "" : ` · ${escapeHtml(record.lastError)}`}</small>
      </div>
      <span class="${outboxStatusClass(record.status)}">${outboxStatusLabels[record.status] ?? record.status} · ${record.attempts} 次</span>
    </div>
  `;
}

export function createOutboxViews({ api, showToast, getData, refresh }) {
  const elements = {
    events: document.querySelector("#events"),
    eventCount: document.querySelector("#event-count"),
    emails: document.querySelector("#emails"),
    emailCount: document.querySelector("#email-count"),
    workerRun: document.querySelector("#worker-run"),
    poisonToggle: document.querySelector("#poison-toggle"),
    workerStats: document.querySelector("#worker-stats"),
    workerEvents: document.querySelector("#worker-events"),
    workerDead: document.querySelector("#worker-dead"),
    workerIncidents: document.querySelector("#worker-incidents"),
  };
  function renderEvents() {
    const outbox = getData().outbox ?? [];
    elements.eventCount.textContent = `${outbox.length} 条事件`;
    if (outbox.length === 0) {
      elements.events.innerHTML = '<p class="events-empty">发起审批后，领域事件会出现在这里。</p>';
      return;
    }
    elements.events.innerHTML = outbox.slice(0, 18).map(renderEventRow).join("");
  }

  function renderEmails() {
    const emails = getData().emails ?? [];
    const failures = getData().emailFailures ?? [];
    elements.emailCount.textContent = `${emails.length} 封邮件${failures.length > 0 ? ` · ${failures.length} 失败` : ""}`;
    if (emails.length === 0 && failures.length === 0) {
      elements.emails.innerHTML = '<p class="events-empty">审批产生通知事件后，邮件会进入这个本地沙箱。</p>';
      return;
    }
    const failedItems = failures
      .slice(0, 6)
      .map((failure) => `<div class="email-failure"><strong>投递失败</strong><span>${escapeHtml(failure.eventType)}</span><small>${escapeHtml(failure.message)}</small></div>`)
      .join("");
    elements.emails.innerHTML = failedItems + emails.slice(0, 12).map((email) => `
      <details class="email-item">
        <summary><span><strong>${escapeHtml(email.subject)}</strong><small>To: ${escapeHtml(email.to.join(", "))}</small></span><time>${formatTime(email.sentAt)}</time></summary>
        <div class="email-preview">${email.html}</div>
        <code>${escapeHtml(email.idempotencyKey)}</code>
      </details>
    `).join("");
  }

  function renderWorker() {
    const outbox = getData().outbox ?? [];
    const dead = getData().outboxDead ?? [];
    const incidents = getData().outboxIncidents ?? [];
    const settings = getData().outboxSettings ?? { poisonMode: false };
    elements.poisonToggle.checked = settings.poisonMode === true;
    const counts = { PENDING: 0, PROCESSING: 0, PROCESSED: 0, FAILED: 0, DEAD: 0 };
    for (const record of outbox) counts[record.status] = (counts[record.status] ?? 0) + 1;
  elements.workerStats.textContent = `${counts.PENDING} 待处理 · ${counts.PROCESSED} 已处理 · ${counts.FAILED} 失败 · ${counts.DEAD} 死信`;
    elements.workerEvents.innerHTML = outbox.length === 0
      ? '<p class="events-empty">事件由审批动作产生，Worker 领取后在这里显示状态。</p>'
      : outbox.slice(0, 24).map(renderEventRow).join("");
    elements.workerDead.innerHTML = dead.length === 0
      ? '<p class="events-empty">达到重试上限的事件会进入死信队列，可重置后重新投递。</p>'
      : dead.map((item) => `
        <div class="worker-dead-item">
          <div>
            <strong>${escapeHtml(eventLabels[item.event.type] ?? item.event.type)}</strong>
            <small>${escapeHtml(item.event.business.id)} · 尝试 ${item.attempts} 次${item.lastError === undefined ? "" : ` · ${escapeHtml(item.lastError)}`}</small>
          </div>
          <button class="button button--secondary button--small" data-reset-dead="${escapeHtml(item.event.id)}" type="button">重置重投</button>
        </div>
      `).join("");
    elements.workerIncidents.innerHTML = incidents.length === 0
      ? '<p class="events-empty">onDeadLetter 告警回调触发后出现在这里。</p>'
      : incidents.slice(0, 8).map((incident) => `
        <div class="worker-incident">
          <strong>DEAD LETTER</strong>
          <span>${escapeHtml(incident.eventType)} · ${escapeHtml(incident.eventId)}</span>
          <small>${escapeHtml(incident.message)} · ${formatTime(incident.occurredAt)}</small>
        </div>
      `).join("");
  }

  elements.workerRun.addEventListener("click", async () => {
    elements.workerRun.disabled = true;
    try {
      const result = await api("/api/outbox/worker/run", { method: "POST", body: "{}" });
      await refresh();
      showToast(result.processed > 0 ? `本轮处理 ${result.processed} 个事件` : "本轮没有可领取的事件");
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      elements.workerRun.disabled = false;
    }
  });

  elements.poisonToggle.addEventListener("change", async () => {
    try {
      await api("/api/outbox/poison", {
        method: "POST",
        body: JSON.stringify({ enabled: elements.poisonToggle.checked }),
      });
      showToast(elements.poisonToggle.checked ? "毒消息模拟已开启：新待办邮件将持续失败" : "毒消息模拟已关闭");
      await refresh();
    } catch (error) {
      showToast(error.message, "error");
      elements.poisonToggle.checked = !elements.poisonToggle.checked;
    }
  });

  elements.workerDead.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-reset-dead]");
    if (button === null) return;
    button.disabled = true;
    try {
      await api(`/api/outbox/dead/${encodeURIComponent(button.dataset.resetDead)}/reset`, { method: "POST", body: "{}" });
      await refresh();
      showToast("死信已重置，事件重新进入待处理队列");
    } catch (error) {
      showToast(error.message, "error");
      button.disabled = false;
    }
  });

  function render() {
    renderEvents();
    renderEmails();
    renderWorker();
  }

  return { render };
}
