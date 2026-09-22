import type { AssigneePolicy } from "../../contracts/workflow.js";
import type { AssigneeResolutionContext, OrganizationProvider } from "../../ports/organization.js";

export type AssigneeLookup = (
  policy: AssigneePolicy,
  context: AssigneeResolutionContext,
) => readonly string[] | Promise<readonly string[]>;

export class StaticOrganizationProvider implements OrganizationProvider {
  public constructor(private readonly lookup: AssigneeLookup) {}

  public resolveAssignees(
    policy: AssigneePolicy,
    context: AssigneeResolutionContext,
  ): Promise<readonly string[]> {
    return Promise.resolve(this.lookup(policy, context));
  }
}

