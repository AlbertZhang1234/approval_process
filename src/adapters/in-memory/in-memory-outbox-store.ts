import { ApprovalError } from "../../domain/errors.js";
import type { DomainEvent } from "../../domain/model.js";
import type {
  ClaimedOutboxEvent,
  ClaimOutboxEventsInput,
  CompleteOutboxEventInput,
  DeadLetterOutboxEventInput,
  DeadOutboxEvent,
  FailOutboxEventInput,
  OutboxStore,
  ResetDeadOutboxEventInput,
} from "../../ports/outbox-store.js";

type OutboxStatus = "PENDING" | "PROCESSING" | "PROCESSED" | "FAILED" | "DEAD";

interface OutboxRecord {
  readonly event: DomainEvent;
  status: OutboxStatus;
  attempts: number;
  availableAtMs: number;
  lockedAtMs?: number;
  lockedBy?: string;
  processedAtMs?: number;
  lastError?: string;
  deadLetteredAtMs?: number;
}

export interface OutboxRecordView {
  readonly event: DomainEvent;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly lastError?: string;
  readonly deadLetteredAt?: string;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function epoch(value: string): number {
  return Date.parse(value);
}

export class InMemoryOutboxStore implements OutboxStore {
  private readonly records = new Map<string, OutboxRecord>();

  public append(events: readonly DomainEvent[]): void {
    for (const event of events) {
      this.records.set(event.id, {
        event: copy(event),
        status: "PENDING",
        attempts: 0,
        availableAtMs: epoch(event.occurredAt),
      });
    }
  }

  public readOutbox(): readonly DomainEvent[] {
    return [...this.records.values()].map((record) => copy(record.event));
  }

  public readOutboxRecords(): readonly OutboxRecordView[] {
    return [...this.records.values()].map((record) => ({
      event: copy(record.event),
      status: record.status,
      attempts: record.attempts,
      ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
      ...(record.deadLetteredAtMs === undefined
        ? {}
        : { deadLetteredAt: new Date(record.deadLetteredAtMs).toISOString() }),
    }));
  }

  public async claimOutboxEvents(input: ClaimOutboxEventsInput): Promise<readonly ClaimedOutboxEvent[]> {
    const occurredAtMs = epoch(input.occurredAt);
    const leaseMs = input.leaseSeconds * 1_000;
    const candidates = [...this.records.values()]
      .filter((record) => this.claimable(record, occurredAtMs, leaseMs))
      .sort(
        (left, right) =>
          left.availableAtMs - right.availableAtMs
          || left.event.occurredAt.localeCompare(right.event.occurredAt)
          || left.event.id.localeCompare(right.event.id),
      )
      .slice(0, input.limit);
    return candidates.map((record) => {
      record.status = "PROCESSING";
      record.attempts += 1;
      record.lockedAtMs = occurredAtMs;
      record.lockedBy = input.workerId;
      delete record.lastError;
      return { event: copy(record.event), attempts: record.attempts };
    });
  }

  private claimable(record: OutboxRecord, occurredAtMs: number, leaseMs: number): boolean {
    if (record.status === "PENDING" || record.status === "FAILED") return record.availableAtMs <= occurredAtMs;
    return record.status === "PROCESSING" && record.lockedAtMs !== undefined && record.lockedAtMs <= occurredAtMs - leaseMs;
  }

  private requireOwned(eventId: string, workerId: string): OutboxRecord {
    const record = this.records.get(eventId);
    if (record === undefined || record.status !== "PROCESSING" || record.lockedBy !== workerId) {
      throw new ApprovalError("OUTBOX_LOCK_CONFLICT", "Outbox event is not owned by this worker");
    }
    return record;
  }

  public async markOutboxEventProcessed(input: CompleteOutboxEventInput): Promise<void> {
    const record = this.requireOwned(input.eventId, input.workerId);
    record.status = "PROCESSED";
    record.processedAtMs = epoch(input.occurredAt);
    delete record.lockedAtMs;
    delete record.lockedBy;
  }

  public async markOutboxEventFailed(input: FailOutboxEventInput): Promise<void> {
    const record = this.requireOwned(input.eventId, input.workerId);
    record.status = "FAILED";
    record.availableAtMs = epoch(input.retryAt);
    delete record.lockedAtMs;
    delete record.lockedBy;
    record.lastError = input.error;
  }

  public async markOutboxEventDead(input: DeadLetterOutboxEventInput): Promise<void> {
    const record = this.requireOwned(input.eventId, input.workerId);
    record.status = "DEAD";
    record.deadLetteredAtMs = epoch(input.occurredAt);
    delete record.lockedAtMs;
    delete record.lockedBy;
    record.lastError = input.error;
  }

  public async listDeadOutboxEvents(limit: number): Promise<readonly DeadOutboxEvent[]> {
    return [...this.records.values()]
      .filter((record) => record.status === "DEAD")
      .sort(
        (left, right) =>
          (right.deadLetteredAtMs ?? 0) - (left.deadLetteredAtMs ?? 0) || left.event.id.localeCompare(right.event.id),
      )
      .slice(0, limit)
      .map((record) => ({
        event: copy(record.event),
        attempts: record.attempts,
        ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
        ...(record.deadLetteredAtMs === undefined
          ? {}
          : { deadLetteredAt: new Date(record.deadLetteredAtMs).toISOString() }),
      }));
  }

  public async resetDeadOutboxEvent(input: ResetDeadOutboxEventInput): Promise<void> {
    const record = this.records.get(input.eventId);
    if (record === undefined || record.status !== "DEAD") {
      throw new ApprovalError("OUTBOX_EVENT_NOT_FOUND", `Dead outbox event '${input.eventId}' was not found`);
    }
    record.status = "PENDING";
    record.attempts = 0;
    record.availableAtMs = epoch(input.retryAt);
    delete record.deadLetteredAtMs;
    delete record.lastError;
  }
}
