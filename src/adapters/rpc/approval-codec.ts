import type { WorkflowDefinition } from "../../contracts/workflow.js";
import type {
  ApprovalInstance,
  ApprovalTask,
  DomainEvent,
  NodeExecution,
  TransitionRecord,
} from "../../domain/model.js";
import type { DeadOutboxEvent } from "../../ports/outbox-store.js";
import type { TaskListResult } from "../../ports/store.js";
import { parseWorkflowDefinition } from "../../domain/workflow-validator.js";
import {
  readArray,
  readEnum,
  readInteger,
  readOptionalString,
  readRecord,
  readString,
} from "./json-reader.js";

const INSTANCE_STATUSES = ["RUNNING", "APPROVED", "REJECTED", "CANCELED", "WITHDRAWN"] as const;
const EXECUTION_STATUSES = ["ACTIVE", "COMPLETED", "CANCELED"] as const;
const EXECUTION_RESULTS = ["PASSED", "REJECTED", "SKIPPED"] as const;
const TASK_STATUSES = ["PENDING", "APPROVED", "REJECTED", "CANCELED"] as const;
const TRANSITION_TYPES = ["FORWARD", "RETURN", "RESUBMIT"] as const;
const EVENT_TYPES = [
  "approval.instance.started",
  "approval.task.created",
  "approval.task.completed",
  "approval.instance.approved",
  "approval.instance.rejected",
  "approval.instance.returned",
  "approval.instance.resubmitted",
  "approval.instance.withdrawn",
  "approval.instance.canceled",
] as const;

function parseBusiness(value: unknown, path: string): ApprovalInstance["business"] {
  const record = readRecord(value, path);
  const url = readOptionalString(record["url"], `${path}.url`);
  return {
    type: readString(record["type"], `${path}.type`),
    id: readString(record["id"], `${path}.id`),
    ...(url === undefined ? {} : { url }),
  };
}

function parseExecution(value: unknown, path: string): NodeExecution {
  const record = readRecord(value, path);
  const previousExecutionId = readOptionalString(record["previousExecutionId"], `${path}.previousExecutionId`);
  const result = record["result"] === undefined || record["result"] === null
    ? undefined
    : readEnum(record["result"], EXECUTION_RESULTS, `${path}.result`);
  const leftAt = readOptionalString(record["leftAt"], `${path}.leftAt`);
  return {
    id: readString(record["id"], `${path}.id`),
    nodeId: readString(record["nodeId"], `${path}.nodeId`),
    round: readInteger(record["round"], `${path}.round`),
    ...(previousExecutionId === undefined ? {} : { previousExecutionId }),
    status: readEnum(record["status"], EXECUTION_STATUSES, `${path}.status`),
    ...(result === undefined ? {} : { result }),
    enteredAt: readString(record["enteredAt"], `${path}.enteredAt`),
    ...(leftAt === undefined ? {} : { leftAt }),
  };
}

export function parseApprovalTask(value: unknown, path = "task"): ApprovalTask {
  const record = readRecord(value, path);
  const completedAt = readOptionalString(record["completedAt"], `${path}.completedAt`);
  const comment = readOptionalString(record["comment"], `${path}.comment`);
  return {
    id: readString(record["id"], `${path}.id`),
    instanceId: readString(record["instanceId"], `${path}.instanceId`),
    executionId: readString(record["executionId"], `${path}.executionId`),
    nodeId: readString(record["nodeId"], `${path}.nodeId`),
    assigneeId: readString(record["assigneeId"], `${path}.assigneeId`),
    status: readEnum(record["status"], TASK_STATUSES, `${path}.status`),
    createdAt: readString(record["createdAt"], `${path}.createdAt`),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(comment === undefined ? {} : { comment }),
  };
}

export function parseDomainEvent(value: unknown, path = "event"): DomainEvent {
  const record = readRecord(value, path);
  return {
    id: readString(record["id"], `${path}.id`),
    type: readEnum(record["type"], EVENT_TYPES, `${path}.type`),
    instanceId: readString(record["instanceId"], `${path}.instanceId`),
    business: parseBusiness(record["business"], `${path}.business`),
    occurredAt: readString(record["occurredAt"], `${path}.occurredAt`),
    data: structuredClone(readRecord(record["data"], `${path}.data`)),
  };
}

function parseTransition(value: unknown, path: string): TransitionRecord {
  const record = readRecord(value, path);
  const fromExecutionId = readOptionalString(record["fromExecutionId"], `${path}.fromExecutionId`);
  return {
    id: readString(record["id"], `${path}.id`),
    ...(fromExecutionId === undefined ? {} : { fromExecutionId }),
    toExecutionId: readString(record["toExecutionId"], `${path}.toExecutionId`),
    type: readEnum(record["type"], TRANSITION_TYPES, `${path}.type`),
    occurredAt: readString(record["occurredAt"], `${path}.occurredAt`),
  };
}

export function parseTaskListResult(value: unknown, path = "taskList"): TaskListResult {
  const record = readRecord(value, path);
  const nextCursor = record["nextCursor"];
  return {
    tasks: readArray(record["tasks"], `${path}.tasks`).map((item, index) =>
      parseApprovalTask(item, `${path}.tasks[${index}]`),
    ),
    ...(nextCursor === undefined || nextCursor === null
      ? {}
      : {
          nextCursor: {
            createdAt: readString(readRecord(nextCursor, `${path}.nextCursor`)["createdAt"], `${path}.nextCursor.createdAt`),
            id: readString(readRecord(nextCursor, `${path}.nextCursor`)["id"], `${path}.nextCursor.id`),
          },
        }),
  };
}

export function parseDeadOutboxEvents(value: unknown, path = "deadOutboxEvents"): readonly DeadOutboxEvent[] {
  return readArray(value, path).map((item, index) => {
    const record = readRecord(item, `${path}[${index}]`);
    const lastError = readOptionalString(record["lastError"], `${path}[${index}].lastError`);
    const deadLetteredAt = readOptionalString(record["deadLetteredAt"], `${path}[${index}].deadLetteredAt`);
    return {
      event: parseDomainEvent(record["event"], `${path}[${index}].event`),
      attempts: readInteger(record["attempts"], `${path}[${index}].attempts`),
      ...(lastError === undefined ? {} : { lastError }),
      ...(deadLetteredAt === undefined ? {} : { deadLetteredAt }),
    };
  });
}

export function parseApprovalInstance(value: unknown, path = "instance"): ApprovalInstance {
  const record = readRecord(value, path);
  const definition: WorkflowDefinition = parseWorkflowDefinition(record["definition"]);
  const context = readRecord(record["context"], `${path}.context`);
  const currentExecutionId = readOptionalString(record["currentExecutionId"], `${path}.currentExecutionId`);
  return {
    id: readString(record["id"], `${path}.id`),
    definitionKey: readString(record["definitionKey"], `${path}.definitionKey`),
    definitionVersion: readInteger(record["definitionVersion"], `${path}.definitionVersion`),
    definition,
    business: parseBusiness(record["business"], `${path}.business`),
    applicantId: readString(record["applicantId"], `${path}.applicantId`),
    context: structuredClone(context),
    contextRevision: readInteger(record["contextRevision"], `${path}.contextRevision`),
    status: readEnum(record["status"], INSTANCE_STATUSES, `${path}.status`),
    ...(currentExecutionId === undefined ? {} : { currentExecutionId }),
    executions: readArray(record["executions"], `${path}.executions`).map((item, index) =>
      parseExecution(item, `${path}.executions[${index}]`),
    ),
    tasks: readArray(record["tasks"], `${path}.tasks`).map((item, index) =>
      parseApprovalTask(item, `${path}.tasks[${index}]`),
    ),
    transitions: readArray(record["transitions"], `${path}.transitions`).map((item, index) =>
      parseTransition(item, `${path}.transitions[${index}]`),
    ),
    createdAt: readString(record["createdAt"], `${path}.createdAt`),
    updatedAt: readString(record["updatedAt"], `${path}.updatedAt`),
    version: readInteger(record["version"], `${path}.version`),
  };
}
