import { randomUUID } from "node:crypto";
import type { OrganizationProvider } from "../ports/organization.js";
import type { Clock, IdGenerator } from "../ports/platform.js";
import { systemClock } from "../ports/platform.js";
import type { ApprovalStore } from "../ports/store.js";
import { ApprovalFacade, type ApprovalFacadeOptions } from "./approval-facade.js";

export interface CreateApprovalModuleOptions {
  readonly store: ApprovalStore;
  readonly organizationProvider: OrganizationProvider;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
  readonly policies?: ApprovalFacadeOptions;
}

const uuidGenerator: IdGenerator = {
  nextId: (scope) => `${scope}_${randomUUID()}`,
};

export function createApprovalModule(options: CreateApprovalModuleOptions): ApprovalFacade {
  return new ApprovalFacade(
    options.store,
    {
      organizationProvider: options.organizationProvider,
      clock: options.clock ?? systemClock,
      ids: options.idGenerator ?? uuidGenerator,
    },
    options.policies,
  );
}
