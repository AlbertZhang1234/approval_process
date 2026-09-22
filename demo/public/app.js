import { initializeLab } from "./lab.js";
import { initializeConfig } from "./config.js";
import { createBusinessController } from "./business-form.js";
import { createInboxViews } from "./views/inbox-views.js";
import { createInstanceViews } from "./views/instance-views.js";
import { createOutboxViews } from "./views/outbox-views.js";
import { createDefinitionViews } from "./views/definition-views.js";

const state = {
  data: { workflows: [], people: {}, instances: [], events: [], outbox: [] },
};

const elements = {
  resetButton: document.querySelector("#reset-button"),
  toast: document.querySelector("#toast"),
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "请求失败");
  return body;
}

function showToast(message, tone = "success") {
  elements.toast.textContent = message;
  elements.toast.dataset.tone = tone;
  elements.toast.classList.add("toast--visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => elements.toast.classList.remove("toast--visible"), 2600);
}

function getData() {
  return state.data;
}

async function refresh() {
  state.data = await api("/api/state");
  if (!refresh.initialized) {
    refresh.initialized = true;
    refresh.businessController = createBusinessController({ api, showToast, getData, refresh });
    await initializeLab({ api, showToast, getWorkflows: () => state.data.workflows });
    refresh.configController = await initializeConfig({
      api,
      showToast,
      getWorkflows: () => state.data.workflows,
      onWorkflowPublished: async (workflowKey) => {
        await refresh();
        refresh.businessController.selectWorkflow(workflowKey);
      },
      onHostUpdated: refresh,
    });
    refresh.views = {
      inbox: createInboxViews({ api, showToast, getData, refresh }),
      instances: createInstanceViews({ api, showToast, getData, refresh }),
      outbox: createOutboxViews({ api, showToast, getData, refresh }),
      definitions: createDefinitionViews({ getData }),
    };
  }
  refresh.businessController.render();
  await Promise.all([
    refresh.views.inbox.render(),
    refresh.views.instances.render(),
    refresh.views.outbox.render(),
    Promise.resolve(refresh.views.definitions.render()),
  ]);
}

elements.resetButton.addEventListener("click", async () => {
  elements.resetButton.disabled = true;
  try {
    await api("/api/reset", { method: "POST", body: "{}" });
    await refresh.configController?.reload();
    await refresh();
    showToast("演示数据已重置");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    elements.resetButton.disabled = false;
  }
});

refresh().catch((error) => showToast(`无法连接演示服务：${error.message}`, "error"));
