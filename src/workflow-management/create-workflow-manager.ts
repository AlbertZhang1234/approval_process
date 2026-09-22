import { randomUUID } from "node:crypto";
import type { Clock, IdGenerator } from "../ports/platform.js";
import { systemClock } from "../ports/platform.js";
import type { WorkflowManagementStore } from "../ports/workflow-management-store.js";
import { WorkflowManager } from "./workflow-manager.js";

export interface CreateWorkflowManagerOptions {
  readonly store: WorkflowManagementStore;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
}

const uuidGenerator: IdGenerator = {
  nextId: (scope) => `${scope}_${randomUUID()}`,
};

export function createWorkflowManager(options: CreateWorkflowManagerOptions): WorkflowManager {
  return new WorkflowManager(
    options.store,
    options.clock ?? systemClock,
    options.idGenerator ?? uuidGenerator,
  );
}

