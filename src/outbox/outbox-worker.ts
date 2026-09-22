import { randomUUID } from "node:crypto";
import type { DomainEvent } from "../domain/model.js";
import type { OutboxStore } from "../ports/outbox-store.js";
import { systemClock, type Clock } from "../ports/platform.js";

export interface OutboxEventHandlerContext {
  readonly attempts: number;
}

export type OutboxEventHandler = (event: DomainEvent, context: OutboxEventHandlerContext) => Promise<void>;

export interface OutboxWorkerOptions {
  readonly store: OutboxStore;
  readonly handler: OutboxEventHandler;
  readonly workerId?: string;
  readonly pollIntervalMs?: number;
  readonly leaseSeconds?: number;
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: (attempts: number) => number;
  readonly clock?: Clock;
  readonly onError?: (error: unknown, event?: DomainEvent) => void;
  readonly onDeadLetter?: (event: DomainEvent, attempts: number, error: unknown) => void;
}

export interface OutboxWorker {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<number>;
}

const DEFAULT_MAX_RETRY_DELAY_MS = 15 * 60_000;

function defaultRetryDelayMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), DEFAULT_MAX_RETRY_DELAY_MS);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function createOutboxWorker(options: OutboxWorkerOptions): OutboxWorker {
  const workerId = options.workerId ?? `worker_${randomUUID()}`;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const leaseSeconds = options.leaseSeconds ?? 60;
  const batchSize = options.batchSize ?? 20;
  const maxAttempts = options.maxAttempts ?? 10;
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
  const clock = options.clock ?? systemClock;

  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new Error("pollIntervalMs must be a positive integer");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error("batchSize must be an integer between 1 and 100");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer");
  }

  let running = false;
  let timer: NodeJS.Timeout | undefined;
  let currentRun: Promise<number> | undefined;
  let busy = false;

  async function runOnce(): Promise<number> {
    if (busy) return 0;
    busy = true;
    try {
      const claimed = await options.store.claimOutboxEvents({
        workerId,
        limit: batchSize,
        leaseSeconds,
        occurredAt: clock.now().toISOString(),
      });
      for (const item of claimed) {
        await processEvent(item.event, item.attempts);
      }
      return claimed.length;
    } finally {
      busy = false;
    }
  }

  async function processEvent(event: DomainEvent, attempts: number): Promise<void> {
    try {
      await options.handler(event, { attempts });
      await options.store.markOutboxEventProcessed({
        eventId: event.id,
        workerId,
        occurredAt: clock.now().toISOString(),
      });
      return;
    } catch (error) {
      options.onError?.(error, event);
      const message = errorMessage(error);
      const occurredAt = clock.now().toISOString();
      if (attempts >= maxAttempts) {
        await options.store.markOutboxEventDead({ eventId: event.id, workerId, occurredAt, error: message });
        options.onDeadLetter?.(event, attempts, error);
        return;
      }
      const retryAt = new Date(clock.now().getTime() + retryDelayMs(attempts)).toISOString();
      await options.store.markOutboxEventFailed({ eventId: event.id, workerId, error: message, retryAt });
    }
  }

  function schedule(): void {
    timer = setTimeout(() => {
      timer = undefined;
      void tick();
    }, pollIntervalMs);
  }

  async function tick(): Promise<void> {
    if (!running) return;
    const execution = runOnce();
    currentRun = execution;
    try {
      await execution;
    } catch (error) {
      options.onError?.(error);
    } finally {
      if (currentRun === execution) currentRun = undefined;
      if (running) schedule();
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      schedule();
    },
    async stop(): Promise<void> {
      running = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (currentRun !== undefined) {
        await currentRun.catch(() => undefined);
      }
    },
    runOnce(): Promise<number> {
      const execution = runOnce();
      currentRun = execution;
      return execution.finally(() => {
        if (currentRun === execution) currentRun = undefined;
      });
    },
  };
}
