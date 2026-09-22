import type { AssigneePolicy, BusinessReference } from "../contracts/workflow.js";

export interface AssigneeResolutionContext {
  readonly applicantId: string;
  readonly business: BusinessReference;
  readonly context: Readonly<Record<string, unknown>>;
}

export interface OrganizationProvider {
  resolveAssignees(
    policy: AssigneePolicy,
    resolutionContext: AssigneeResolutionContext,
  ): Promise<readonly string[]>;
}

export interface UserContact {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
}

export interface UserContactProvider {
  getUserContact(userId: string): Promise<UserContact | undefined>;
}

