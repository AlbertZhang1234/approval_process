import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalError } from "../src/domain/errors.js";
import { RpcApprovalStore } from "../src/adapters/rpc/rpc-approval-store.js";
import type { ApprovalRpcClient, ApprovalRpcFunction } from "../src/adapters/rpc/rpc-client.js";

class RecordingRpcClient implements ApprovalRpcClient {
  public readonly calls: Array<{
    readonly functionName: ApprovalRpcFunction;
    readonly input: Readonly<Record<string, unknown>>;
  }> = [];

  public async call(
    functionName: ApprovalRpcFunction,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    this.calls.push({ functionName, input });
    if (functionName === "get_instance_by_business") {
      return null;
    }
    if (functionName === "list_tasks") {
      return {
        tasks: [
          {
            id: "task-1",
            instanceId: "instance-1",
            executionId: "execution-1",
            nodeId: "manager_review",
            assigneeId: "manager-1",
            status: "PENDING",
            createdAt: "2026-09-10T08:00:00.000Z",
          },
        ],
        nextCursor: { createdAt: "2026-09-10T08:00:00.000Z", id: "task-1" },
      };
    }
    if (functionName === "list_dead_outbox_events") {
      return [
        {
          event: {
            id: "event-1",
            type: "approval.task.created",
            instanceId: "instance-1",
            business: { type: "expense", id: "EXP-1" },
            occurredAt: "2026-09-10T08:00:00.000Z",
            data: { taskId: "task-1", assigneeId: "manager-1", nodeId: "manager" },
          },
          attempts: 10,
          lastError: "contact missing",
          deadLetteredAt: "2026-09-10T09:00:00.000Z",
        },
      ];
    }
    if (functionName === "claim_outbox_events") {
      return [{
        attempts: 2,
        event: {
          id: "event-1",
          type: "approval.task.created",
          instanceId: "instance-1",
          business: { type: "expense", id: "EXP-1" },
          occurredAt: "2026-09-10T08:00:00.000Z",
          data: { taskId: "task-1", assigneeId: "manager-1", nodeId: "manager" },
        },
      }];
    }
    return { ok: true };
  }
}

test("RPC store claims and acknowledges typed outbox events", async () => {
  const client = new RecordingRpcClient();
  const store = new RpcApprovalStore(client);
  const claimed = await store.claimOutboxEvents({
    workerId: "mail-worker-1",
    limit: 20,
    leaseSeconds: 60,
    occurredAt: "2026-09-10T08:00:00.000Z",
  });
  assert.equal(claimed[0]?.event.type, "approval.task.created");
  assert.equal(claimed[0]?.attempts, 2);

  await store.markOutboxEventProcessed({
    eventId: "event-1",
    workerId: "mail-worker-1",
    occurredAt: "2026-09-10T08:00:01.000Z",
  });
  assert.deepEqual(client.calls.map((call) => call.functionName), [
    "claim_outbox_events",
    "mark_outbox_event_processed",
  ]);
});

test("RPC store maps task queries, business lookups and dead-letter operations", async () => {
  const client = new RecordingRpcClient();
  const store = new RpcApprovalStore(client);

  const tasks = await store.listTasks({
    assigneeId: "manager-1",
    status: "PENDING",
    businessType: "expense",
    limit: 50,
    orderBy: "CREATED_ASC",
    cursor: { createdAt: "2026-09-10T07:00:00.000Z", id: "task-0" },
  });
  assert.equal(tasks.tasks[0]?.id, "task-1");
  assert.deepEqual(tasks.nextCursor, { createdAt: "2026-09-10T08:00:00.000Z", id: "task-1" });

  await store.getInstanceByBusiness("expense", "EXP-1", ["RUNNING", "WITHDRAWN"]);
  await store.markOutboxEventDead({
    eventId: "event-1",
    workerId: "mail-worker-1",
    occurredAt: "2026-09-10T09:00:00.000Z",
    error: "contact missing",
  });
  const dead = await store.listDeadOutboxEvents(20);
  assert.equal(dead[0]?.attempts, 10);
  assert.equal(dead[0]?.lastError, "contact missing");
  await store.resetDeadOutboxEvent({ eventId: "event-1", retryAt: "2026-09-10T10:00:00.000Z" });

  assert.deepEqual(
    client.calls.map((call) => call.functionName),
    ["list_tasks", "get_instance_by_business", "mark_outbox_event_dead", "list_dead_outbox_events", "reset_dead_outbox_event"],
  );
  assert.deepEqual(client.calls[1]?.input, {
    businessType: "expense",
    businessId: "EXP-1",
    status: ["RUNNING", "WITHDRAWN"],
  });
});

test("RPC store validates outbox lease bounds before accessing the database", async () => {
  const store = new RpcApprovalStore(new RecordingRpcClient());
  await assert.rejects(
    store.claimOutboxEvents({
      workerId: "mail-worker-1",
      limit: 101,
      leaseSeconds: 60,
      occurredAt: "2026-09-10T08:00:00.000Z",
    }),
    (error: unknown) => error instanceof ApprovalError && error.code === "INVALID_COMMAND",
  );
});
