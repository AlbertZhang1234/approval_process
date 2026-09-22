import assert from "node:assert/strict";
import test from "node:test";
import type { DomainEvent } from "../src/domain/model.js";
import type {
  ClaimedOutboxEvent,
  ClaimOutboxEventsInput,
  CompleteOutboxEventInput,
  DeadLetterOutboxEventInput,
  DeadOutboxEvent,
  FailOutboxEventInput,
  OutboxStore,
  ResetDeadOutboxEventInput,
} from "../src/ports/outbox-store.js";
import { createOutboxWorker } from "../src/outbox/outbox-worker.js";
import { ApprovalError } from "../src/domain/errors.js";
import { InMemoryApprovalStore } from "../src/adapters/in-memory/index.js";
import type { ApprovalInstance } from "../src/domain/model.js";

function sampleEvent(id: string): DomainEvent {
  return {
    id,
    type: "approval.task.created",
    instanceId: "instance-1",
    business: { type: "expense", id: "EXP-1" },
    occurredAt: "2026-09-21T08:00:00.000Z",
    data: { taskId: `task-${id}`, assigneeId: "manager-1", nodeId: "manager_review" },
  };
}

class ScriptedOutboxStore implements OutboxStore {
  public readonly claims: ClaimOutboxEventsInput[] = [];
  public readonly processed: CompleteOutboxEventInput[] = [];
  public readonly failures: FailOutboxEventInput[] = [];
  public readonly dead: DeadLetterOutboxEventInput[] = [];
  public readonly resets: ResetDeadOutboxEventInput[] = [];
  public queue: readonly ClaimedOutboxEvent[] = [];

  public async claimOutboxEvents(input: ClaimOutboxEventsInput): Promise<readonly ClaimedOutboxEvent[]> {
    this.claims.push(input);
    const claimed = this.queue;
    this.queue = [];
    return claimed;
  }

  public async markOutboxEventProcessed(input: CompleteOutboxEventInput): Promise<void> {
    this.processed.push(input);
  }

  public async markOutboxEventFailed(input: FailOutboxEventInput): Promise<void> {
    this.failures.push(input);
  }

  public async markOutboxEventDead(input: DeadLetterOutboxEventInput): Promise<void> {
    this.dead.push(input);
  }

  public async listDeadOutboxEvents(_limit: number): Promise<readonly DeadOutboxEvent[]> {
    return [];
  }

  public async resetDeadOutboxEvent(input: ResetDeadOutboxEventInput): Promise<void> {
    this.resets.push(input);
  }
}

test("worker claims events, invokes the handler and acknowledges success", async () => {
  const store = new ScriptedOutboxStore();
  store.queue = [{ event: sampleEvent("event-1"), attempts: 1 }];
  const handled: string[] = [];
  const worker = createOutboxWorker({
    store,
    workerId: "worker-1",
    handler: async (event) => {
      handled.push(event.id);
    },
    clock: { now: () => new Date("2026-09-21T08:00:00.000Z") },
  });

  const count = await worker.runOnce();
  assert.equal(count, 1);
  assert.deepEqual(handled, ["event-1"]);
  assert.equal(store.claims[0]?.workerId, "worker-1");
  assert.deepEqual(store.processed, [
    { eventId: "event-1", workerId: "worker-1", occurredAt: "2026-09-21T08:00:00.000Z" },
  ]);
  assert.deepEqual(store.failures, []);
});

test("worker retries failures with the configured backoff and reports errors", async () => {
  const store = new ScriptedOutboxStore();
  store.queue = [{ event: sampleEvent("event-2"), attempts: 2 }];
  const errors: unknown[] = [];
  const worker = createOutboxWorker({
    store,
    workerId: "worker-1",
    handler: async () => {
      throw new Error("smtp unavailable");
    },
    retryDelayMs: () => 5_000,
    onError: (error) => errors.push(error),
    clock: { now: () => new Date("2026-09-21T08:00:00.000Z") },
  });

  await worker.runOnce();
  assert.equal(errors.length, 1);
  assert.deepEqual(store.failures, [
    {
      eventId: "event-2",
      workerId: "worker-1",
      error: "smtp unavailable",
      retryAt: "2026-09-21T08:00:05.000Z",
    },
  ]);
  assert.deepEqual(store.dead, []);
});

test("worker dead-letters events that reached the attempt budget", async () => {
  const store = new ScriptedOutboxStore();
  store.queue = [{ event: sampleEvent("event-3"), attempts: 3 }];
  const deadLetters: Array<{ eventId: string; attempts: number }> = [];
  const worker = createOutboxWorker({
    store,
    workerId: "worker-1",
    maxAttempts: 3,
    handler: async () => {
      throw new Error("contact missing");
    },
    onDeadLetter: (event, attempts) => deadLetters.push({ eventId: event.id, attempts }),
    clock: { now: () => new Date("2026-09-21T08:00:00.000Z") },
  });

  await worker.runOnce();
  assert.deepEqual(deadLetters, [{ eventId: "event-3", attempts: 3 }]);
  assert.deepEqual(store.dead, [
    {
      eventId: "event-3",
      workerId: "worker-1",
      occurredAt: "2026-09-21T08:00:00.000Z",
      error: "contact missing",
    },
  ]);
  assert.deepEqual(store.failures, []);
});

test("started worker polls until stopped", async () => {
  const store = new ScriptedOutboxStore();
  store.queue = [{ event: sampleEvent("event-4"), attempts: 1 }];
  let handled = 0;
  const firstPoll = new Promise<void>((resolve) => {
    void (async () => {
      while (handled === 0) {
        await new Promise((wait) => setTimeout(wait, 5));
      }
      resolve();
    })();
  });
  const worker = createOutboxWorker({
    store,
    workerId: "poll-worker",
    pollIntervalMs: 5,
    handler: async () => {
      handled += 1;
    },
    clock: { now: () => new Date("2026-09-21T08:00:00.000Z") },
  });

  worker.start();
  await firstPoll;
  await worker.stop();
  const pollsAfterStop = store.claims.length;
  await new Promise((wait) => setTimeout(wait, 20));
  assert.equal(store.claims.length, pollsAfterStop);
  assert.equal(handled, 1);
});

test("in-memory outbox store supports dead-letter bookkeeping and reset", async () => {
  const store = new InMemoryApprovalStore();
  const now = "2026-09-21T08:00:00.000Z";
  const instance: ApprovalInstance = {
    id: "instance-1",
    definitionKey: "expense-approval",
    definitionVersion: 1,
    definition: { key: "expense-approval", name: "报销审批", version: 1, nodes: [], edges: [] },
    business: { type: "expense", id: "EXP-1" },
    applicantId: "employee-1",
    context: {},
    contextRevision: 1,
    status: "RUNNING",
    executions: [],
    tasks: [],
    transitions: [],
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
  const event = sampleEvent("event-5");
  await store.saveNew(instance, "seed-key", "fingerprint", [event]);

  const claimed = await store.claimOutboxEvents({ workerId: "worker-1", limit: 10, occurredAt: now, leaseSeconds: 60 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]?.attempts, 1);

  await store.markOutboxEventDead({ eventId: "event-5", workerId: "worker-1", occurredAt: now, error: "contact missing" });
  assert.equal((await store.claimOutboxEvents({ workerId: "worker-1", limit: 10, occurredAt: now, leaseSeconds: 60 })).length, 0);

  const deadEvents = await store.listDeadOutboxEvents(10);
  assert.equal(deadEvents.length, 1);
  assert.equal(deadEvents[0]?.event.id, "event-5");
  assert.equal(deadEvents[0]?.attempts, 1);
  assert.equal(deadEvents[0]?.lastError, "contact missing");
  assert.equal(deadEvents[0]?.deadLetteredAt, now);

  const retryAt = "2026-09-21T09:00:00.000Z";
  await store.resetDeadOutboxEvent({ eventId: "event-5", retryAt });
  assert.equal((await store.claimOutboxEvents({ workerId: "worker-2", limit: 10, occurredAt: now, leaseSeconds: 60 })).length, 0);
  const requeued = await store.claimOutboxEvents({ workerId: "worker-2", limit: 10, occurredAt: retryAt, leaseSeconds: 60 });
  assert.equal(requeued.length, 1);
  assert.equal(requeued[0]?.attempts, 1);

  await assert.rejects(
    store.markOutboxEventDead({ eventId: "missing", workerId: "worker-1", occurredAt: now, error: "x" }),
    (error: unknown) => error instanceof ApprovalError && error.code === "OUTBOX_LOCK_CONFLICT",
  );
  await assert.rejects(
    store.resetDeadOutboxEvent({ eventId: "missing", retryAt: now }),
    (error: unknown) => error instanceof ApprovalError && error.code === "OUTBOX_EVENT_NOT_FOUND",
  );
});
