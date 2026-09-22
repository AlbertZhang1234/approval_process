import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ApprovalError, parseWorkflowDefinition } from "../dist/esm/index.js";
import { createDemoRuntime } from "./lib/demo-runtime.mjs";
import { LAB_SCENARIOS, runLabScenario } from "./lib/lab-scenarios.mjs";

const demoDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const publicDirectory = join(demoDirectory, "public");
const projectDirectory = resolve(demoDirectory, "..");
const configuredPort = Number.parseInt(process.env.PORT ?? "4173", 10);
const port = Number.isSafeInteger(configuredPort) && configuredPort > 0 ? configuredPort : 4173;

let runtime = await createDemoRuntime(projectDirectory);

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, "请求内容过大");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "请求体必须是有效 JSON");
  }
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `${field} 不能为空`);
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function parseContext(value) {
  if (value === undefined || value === "") return {};
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new HttpError(400, "业务上下文格式无效");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "业务上下文必须是键值对象");
  }
  return parsed;
}

const PRIMARY_CONTEXT_FIELDS = {
  "expense-approval": "amount",
  "leave-approval": "days",
};

function buildContext(workflowKey, base, value, rawContext) {
  const context = { ...base, ...parseContext(rawContext) };
  const field = PRIMARY_CONTEXT_FIELDS[workflowKey];
  if (field !== undefined) {
    const primaryValue = Number(value);
    if (!Number.isFinite(primaryValue) || primaryValue < 0) {
      throw new HttpError(400, "金额或天数必须是非负数字");
    }
    context[field] = primaryValue;
  }
  return context;
}

async function drainOutbox() {
  let processed = 0;
  for (let round = 0; round < 5; round += 1) {
    const count = await runtime.processOutbox();
    processed += count;
    if (count === 0) break;
  }
  return processed;
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/state") {
    sendJson(response, 200, await runtime.readState());
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/lab") {
    sendJson(response, 200, LAB_SCENARIOS.map(({ id, title, description }) => ({ id, title, description })));
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/config") {
    sendJson(response, 200, runtime.readConfiguration());
    return true;
  }

  if (request.method === "PUT" && url.pathname === "/api/config/host") {
    const body = await readJson(request);
    sendJson(response, 200, runtime.updateHostConfig(body.config));
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/config/workflows/publish") {
    const body = await readJson(request);
    const workflow = runtime.publishWorkflow(body.definition);
    sendJson(response, 201, { workflow, configuration: runtime.readConfiguration() });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/reset") {
    runtime = await createDemoRuntime(projectDirectory);
    sendJson(response, 200, await runtime.readState());
    return true;
  }

  const labMatch = /^\/api\/lab\/([a-z0-9-]+)$/.exec(url.pathname);
  if (request.method === "POST" && labMatch !== null) {
    const result = await runLabScenario(labMatch[1]);
    if (result === undefined) throw new HttpError(404, "未知能力实验");
    sendJson(response, 200, result);
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/workflows/validate") {
    const body = await readJson(request);
    const definition = parseWorkflowDefinition(body.definition);
    sendJson(response, 200, {
      valid: true,
      summary: `${definition.nodes.length} 个节点，${definition.edges.length} 条连线，版本 v${definition.version}`,
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/instances") {
    const body = await readJson(request);
    const workflowKey = requireString(body.workflowKey, "workflowKey");
    const businessId = requireString(body.businessId, "businessId");
    const applicantId = requireString(body.applicantId, "applicantId");
    const workflow = runtime.workflows.find((candidate) => candidate.key === workflowKey);
    if (workflow === undefined) throw new HttpError(400, "未知流程");

    const context = buildContext(workflowKey, {}, body.value, body.context ?? body.contextJson);

    const instance = await runtime.approval.start({
      idempotencyKey: optionalString(body.idempotencyKey) ?? `demo:start:${randomUUID()}`,
      definitionKey: workflowKey,
      business: {
        type: optionalString(body.businessType) ?? (workflowKey === "expense-approval" ? "expense" : workflowKey === "leave-approval" ? "leave" : "custom"),
        id: businessId,
        url: optionalString(body.businessUrl) ?? `/demo/${workflowKey}/${encodeURIComponent(businessId)}`,
      },
      applicantId,
      context,
    });
    runtime.instanceIds.push(instance.id);
    await drainOutbox();
    sendJson(response, 201, instance);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/instances/by-business") {
    const businessType = requireString(url.searchParams.get("businessType") ?? "", "businessType");
    const businessId = requireString(url.searchParams.get("businessId") ?? "", "businessId");
    const statuses = url.searchParams.getAll("status").filter((item) => item.trim() !== "");
    const instance = await runtime.store.getInstanceByBusiness(
      businessType,
      businessId,
      statuses.length === 0 ? undefined : statuses,
    );
    sendJson(response, 200, { found: instance !== undefined, instance: instance ?? null });
    return true;
  }

  const instanceMatch = /^\/api\/instances\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && instanceMatch !== null) {
    sendJson(response, 200, await runtime.approval.getInstance(decodeURIComponent(instanceMatch[1])));
    return true;
  }

  const contextMatch = /^\/api\/instances\/([^/]+)\/context$/.exec(url.pathname);
  if (request.method === "POST" && contextMatch !== null) {
    const body = await readJson(request);
    const instance = await runtime.approval.getInstance(decodeURIComponent(contextMatch[1]));
    const context = buildContext(
      instance.definitionKey,
      instance.context,
      body.value,
      body.context ?? body.contextJson,
    );
    const updated = await runtime.approval.updateContext({
      idempotencyKey: optionalString(body.idempotencyKey) ?? `demo:context:${randomUUID()}`,
      instanceId: instance.id,
      operatorId: requireString(body.operatorId, "operatorId"),
      context,
      ...(optionalString(body.comment) === undefined ? {} : { comment: optionalString(body.comment) }),
    });
    await drainOutbox();
    sendJson(response, 200, updated);
    return true;
  }

  const withdrawMatch = /^\/api\/instances\/([^/]+)\/withdraw$/.exec(url.pathname);
  if (request.method === "POST" && withdrawMatch !== null) {
    const body = await readJson(request);
    const withdrawn = await runtime.approval.withdraw({
      idempotencyKey: optionalString(body.idempotencyKey) ?? `demo:withdraw:${randomUUID()}`,
      instanceId: decodeURIComponent(withdrawMatch[1]),
      operatorId: requireString(body.operatorId, "operatorId"),
      ...(optionalString(body.reason) === undefined ? {} : { reason: optionalString(body.reason) }),
    });
    await drainOutbox();
    sendJson(response, 200, withdrawn);
    return true;
  }

  const cancelMatch = /^\/api\/instances\/([^/]+)\/cancel$/.exec(url.pathname);
  if (request.method === "POST" && cancelMatch !== null) {
    const body = await readJson(request);
    const canceled = await runtime.approval.cancel({
      idempotencyKey: optionalString(body.idempotencyKey) ?? `demo:cancel:${randomUUID()}`,
      instanceId: decodeURIComponent(cancelMatch[1]),
      operatorId: requireString(body.operatorId, "operatorId"),
      ...(optionalString(body.reason) === undefined ? {} : { reason: optionalString(body.reason) }),
    });
    await drainOutbox();
    sendJson(response, 200, canceled);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/tasks") {
    const assigneeId = requireString(url.searchParams.get("assigneeId") ?? "", "assigneeId");
    const status = url.searchParams.get("status");
    const businessType = url.searchParams.get("businessType");
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const orderBy = url.searchParams.get("orderBy");
    const cursorCreatedAt = url.searchParams.get("cursorCreatedAt");
    const cursorId = url.searchParams.get("cursorId");
    const page = await runtime.approval.queryTasks({
      assigneeId,
      ...(status === null || status === "" ? {} : { status }),
      ...(businessType === null || businessType === "" ? {} : { businessType }),
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(orderBy === null ? {} : { orderBy }),
      ...(cursorCreatedAt === null || cursorId === null
        ? {}
        : { cursor: { createdAt: cursorCreatedAt, id: cursorId } }),
    });
    sendJson(response, 200, page);
    return true;
  }

  const actionMatch = /^\/api\/tasks\/([^/]+)\/actions$/.exec(url.pathname);
  if (request.method === "POST" && actionMatch !== null) {
    const body = await readJson(request);
    const taskId = decodeURIComponent(actionMatch[1]);
    const operatorId = requireString(body.operatorId, "operatorId");
    const allowedActions = ["APPROVE", "REJECT", "REJECT_TO_APPLICANT", "RETURN_TO_NODE"];
    const action = allowedActions.includes(body.action) ? body.action : undefined;
    if (action === undefined) throw new HttpError(400, `action 必须是 ${allowedActions.join(" / ")}`);
    const comment = typeof body.comment === "string" && body.comment.trim() !== "" ? body.comment.trim() : undefined;
    const targetNodeId = optionalString(body.targetNodeId);
    const instance = await runtime.approval.act({
      idempotencyKey: `demo:act:${randomUUID()}`,
      taskId,
      operatorId,
      action,
      ...(comment === undefined ? {} : { comment }),
      ...(targetNodeId === undefined ? {} : { targetNodeId }),
    });
    await drainOutbox();
    sendJson(response, 200, instance);
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/outbox/worker/run") {
    const processed = await drainOutbox();
    sendJson(response, 200, { processed });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/outbox/poison") {
    const body = await readJson(request);
    sendJson(response, 200, runtime.setOutboxPoisonMode(body.enabled === true));
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/outbox/dead") {
    sendJson(response, 200, { events: await runtime.store.listDeadOutboxEvents(50) });
    return true;
  }

  const deadResetMatch = /^\/api\/outbox\/dead\/([^/]+)\/reset$/.exec(url.pathname);
  if (request.method === "POST" && deadResetMatch !== null) {
    const events = await runtime.resetDeadOutboxEvent(decodeURIComponent(deadResetMatch[1]));
    sendJson(response, 200, { events });
    return true;
  }

  if (url.pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: { code: "NOT_FOUND", message: "接口不存在" } });
    return true;
  }
  return false;
}

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const normalized = normalize(requested);
  const filePath = resolve(publicDirectory, normalized);
  const relativePath = relative(publicDirectory, filePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new HttpError(403, "禁止访问");
  }
  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    response.end(content);
  } catch (error) {
    if (error?.code === "ENOENT") throw new HttpError(404, "页面不存在");
    throw error;
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (await handleApi(request, response, url)) return;
    if (request.method !== "GET") throw new HttpError(405, "请求方法不支持");
    await serveStatic(response, decodeURIComponent(url.pathname));
} catch (error) {
    const approvalStatusMap = {
      INVALID_COMMAND: 400,
      INVALID_WORKFLOW: 400,
      FORBIDDEN_TASK_ACTION: 403,
      FORBIDDEN_INSTANCE_ACTION: 403,
      TASK_NOT_FOUND: 404,
      INSTANCE_NOT_FOUND: 404,
      WORKFLOW_NOT_FOUND: 404,
      OUTBOX_EVENT_NOT_FOUND: 404,
    };
    const approvalStatus = error instanceof ApprovalError
      ? approvalStatusMap[error.code] ?? 409
      : 500;
    const statusCode = error instanceof HttpError ? error.statusCode : error instanceof ApprovalError ? approvalStatus : 500;
    const code = error instanceof ApprovalError ? error.code : statusCode === 500 ? "INTERNAL_ERROR" : "BAD_REQUEST";
    const message = error instanceof Error ? error.message : "未知错误";
    if (statusCode === 500) console.error(error);
    sendJson(response, statusCode, { error: { code, message } });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`审批流演示环境已启动：http://localhost:${port}`);
});
