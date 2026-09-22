import type { DomainEvent } from "../domain/model.js";

export interface ClaimedOutboxEvent {
  readonly event: DomainEvent;
  readonly attempts: number;
}

export interface ClaimOutboxEventsInput {
  readonly workerId: string;
  readonly limit: number;
  readonly occurredAt: string;
  readonly leaseSeconds: number;
}

export interface CompleteOutboxEventInput {
  readonly eventId: string;
  readonly workerId: string;
  readonly occurredAt: string;
}

export interface FailOutboxEventInput {
  readonly eventId: string;
  readonly workerId: string;
  readonly error: string;
  readonly retryAt: string;
}

export interface DeadLetterOutboxEventInput {
  readonly eventId: string;
  readonly workerId: string;
  readonly occurredAt: string;
  readonly error: string;
}

export interface DeadOutboxEvent {
  readonly event: DomainEvent;
  readonly attempts: number;
  readonly lastError?: string;
  readonly deadLetteredAt?: string;
}

export interface ResetDeadOutboxEventInput {
  readonly eventId: string;
  readonly retryAt: string;
}

export interface OutboxStore {
  claimOutboxEvents(input: ClaimOutboxEventsInput): Promise<readonly ClaimedOutboxEvent[]>;
  markOutboxEventProcessed(input: CompleteOutboxEventInput): Promise<void>;
  markOutboxEventFailed(input: FailOutboxEventInput): Promise<void>;
  markOutboxEventDead(input: DeadLetterOutboxEventInput): Promise<void>;
  listDeadOutboxEvents(limit: number): Promise<readonly DeadOutboxEvent[]>;
  resetDeadOutboxEvent(input: ResetDeadOutboxEventInput): Promise<void>;
}
