import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ApprovalEmailNotifier,
  ApprovalError,
  DefaultEmailTemplateRenderer,
  createApprovalModule,
  createOutboxWorker,
  parseWorkflowDefinition,
} from "../../dist/esm/index.js";
import {
  InMemoryApprovalStore,
  StaticOrganizationProvider,
} from "../../dist/esm/adapters/in-memory/index.js";
import {
  DEFAULT_PEOPLE,
  WORKFLOW_OPTION_CATALOG,
  createDefaultHostConfig,
  parseHostConfig,
  runtimeConfigurationView,
} from "./host-config.mjs";

export const PEOPLE = DEFAULT_PEOPLE;

export function createDemoOrganizationProvider(settings = createDefaultHostConfig()) {
  return new StaticOrganizationProvider((policy, context) => {
    if (policy.type === "USER") return [policy.value];
    if (policy.type === "MANAGER") return settings.organization.managers[context.applicantId] ?? [];
    if (policy.type === "ROLE") return settings.organization.roles[policy.value] ?? [];
    if (policy.type === "DEPARTMENT_ROLE") return settings.organization.departmentRoles[policy.value] ?? [];
    if (policy.type === "PROVIDER") return settings.organization.providers[policy.value] ?? [];
    if (policy.type === "REQUEST_FIELD") {
      const candidate = context.context[policy.value];
      if (typeof candidate === "string") return [candidate];
      if (Array.isArray(candidate)) return candidate.filter((item) => typeof item === "string");
    }
    return [];
  });
}

async function loadWorkflows(projectDirectory) {
  const workflowFiles = ["reimbursement.workflow.json", "leave.workflow.json"];
  return Promise.all(
    workflowFiles.map(async (fileName) => {
      const raw = await readFile(join(projectDirectory, "examples", fileName), "utf8");
      return JSON.parse(raw);
    }),
  );
}

function publicPeople(settings) {
  return Object.fromEntries(Object.entries(settings.people).map(([id, person]) => [id, person.name]));
}

export async function createDemoRuntime(projectDirectory, initialConfig) {
  const store = new InMemoryApprovalStore();
  const settings = parseHostConfig(initialConfig ?? createDefaultHostConfig());
  const workflows = await loadWorkflows(projectDirectory);
  const workflowHistory = new Map();
  for (const workflow of workflows) {
    store.publish(workflow);
    workflowHistory.set(workflow.key, [structuredClone(workflow)]);
  }
  const configAudit = [{ type: "demo.initialized", occurredAt: new Date().toISOString(), detail: "载入内置流程与默认宿主配置" }];

  const approval = createApprovalModule({
    store,
    organizationProvider: createDemoOrganizationProvider(settings),
  });
  const emails = [];
  const emailFailures = [];
  const outboxIncidents = [];
  const sentEmailKeys = new Set();
  const outboxSettings = { poisonMode: false };
  const notifier = new ApprovalEmailNotifier(
    store,
    {
      getUserContact: (userId) => {
        const person = settings.people[userId];
        return Promise.resolve(
          person === undefined
            ? undefined
            : { userId, displayName: person.name, email: person.email },
        );
      },
    },
    new DefaultEmailTemplateRenderer(),
    {
      send: (message) => {
        if (!sentEmailKeys.has(message.idempotencyKey)) {
          sentEmailKeys.add(message.idempotencyKey);
          emails.push({ ...structuredClone(message), sentAt: new Date().toISOString() });
        }
        return Promise.resolve();
      },
    },
  );

  const worker = createOutboxWorker({
    store,
    workerId: "demo-mailer-1",
    batchSize: 20,
    leaseSeconds: 60,
    maxAttempts: 3,
    retryDelayMs: () => 1_000,
    handler: async (event) => {
      if (outboxSettings.poisonMode && event.type === "approval.task.created") {
        throw new Error("模拟毒消息：联系人服务持续不可用");
      }
      const taskEventEnabled = event.type !== "approval.task.created" || settings.notifications.taskCreated;
      const resultEventEnabled = !["approval.instance.approved", "approval.instance.rejected"].includes(event.type)
        || settings.notifications.finalResult;
      if (taskEventEnabled && resultEventEnabled) {
        await notifier.handle(event);
      }
    },
    onError: (error, event) => {
      emailFailures.push({
        eventId: event?.id ?? "unknown",
        eventType: event?.type ?? "unknown",
        message: error instanceof Error ? error.message : "未知通知错误",
        occurredAt: new Date().toISOString(),
      });
    },
    onDeadLetter: (event, attempts, error) => {
      outboxIncidents.unshift({
        eventId: event.id,
        eventType: event.type,
        attempts,
        message: error instanceof Error ? error.message : "未知错误",
        occurredAt: new Date().toISOString(),
      });
    },
  });

  const runtime = {
    store,
    workflows,
    approval,
    emails,
    emailFailures,
    outboxIncidents,
    instanceIds: [],
    settings,
    publishWorkflow(value) {
      const definition = parseWorkflowDefinition(value);
      const currentIndex = workflows.findIndex((item) => item.key === definition.key);
      const current = workflows[currentIndex];
      if (current !== undefined && definition.version <= current.version) {
        throw new ApprovalError("INVALID_COMMAND", `流程 '${definition.key}' 的新版本必须大于当前 v${current.version}`);
      }
      store.publish(definition);
      if (currentIndex === -1) workflows.push(definition);
      else workflows[currentIndex] = definition;
      const versions = workflowHistory.get(definition.key) ?? [];
      versions.push(structuredClone(definition));
      workflowHistory.set(definition.key, versions);
      configAudit.unshift({
        type: "workflow.published",
        occurredAt: new Date().toISOString(),
        detail: `${definition.key} v${definition.version}`,
      });
      return structuredClone(definition);
    },
    updateHostConfig(value) {
      const parsed = parseHostConfig(value);
      settings.organization = parsed.organization;
      settings.people = parsed.people;
      settings.notifications = parsed.notifications;
      configAudit.unshift({
        type: "host-config.updated",
        occurredAt: new Date().toISOString(),
        detail: "组织映射、联系人或通知策略已更新",
      });
      return runtime.readConfiguration();
    },
    readConfiguration() {
      return {
        runtime: runtimeConfigurationView(),
        catalogs: WORKFLOW_OPTION_CATALOG,
        host: structuredClone(settings),
        workflowVersions: Object.fromEntries(
          [...workflowHistory].map(([key, versions]) => [key, versions.map(({ version, name }) => ({ version, name }))]),
        ),
        audit: structuredClone(configAudit),
      };
    },
    setOutboxPoisonMode(enabled) {
      outboxSettings.poisonMode = enabled === true;
      return structuredClone(outboxSettings);
    },
    async processOutbox() {
      return worker.runOnce();
    },
    async resetDeadOutboxEvent(eventId, retryAt = new Date(Date.now() + 1_000).toISOString()) {
      await store.resetDeadOutboxEvent({ eventId, retryAt });
      return store.listDeadOutboxEvents(50);
    },
    async readState() {
      const instances = await Promise.all(runtime.instanceIds.map((id) => approval.getInstance(id)));
      const inbox = [];
      for (const userId of Object.keys(settings.people)) {
        const tasks = await approval.listTasks(userId);
        inbox.push(...tasks.map((task) => ({ ...task, displayName: settings.people[userId].name })));
      }
      return {
        workflows,
        people: publicPeople(settings),
        instances: instances.reverse(),
        inbox,
        events: [...store.readOutbox()].reverse(),
        outbox: store.readOutboxRecords().slice().reverse(),
        outboxDead: await store.listDeadOutboxEvents(50),
        outboxSettings: structuredClone(outboxSettings),
        outboxIncidents: structuredClone(outboxIncidents),
        emails: [...emails].reverse(),
        emailFailures: [...emailFailures].reverse(),
      };
    },
  };
  return runtime;
}
