import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ApprovalFacade, type IdGenerator, type WorkflowDefinition } from "../../src/index.js";
import { InMemoryApprovalStore, StaticOrganizationProvider } from "../../src/adapters/in-memory/index.js";

export class SequentialIds implements IdGenerator {
  private sequence = 0;
  public nextId(
    scope:
      | "instance"
      | "execution"
      | "task"
      | "transition"
      | "event"
      | "workflow-definition"
      | "workflow-version",
  ): string {
    this.sequence += 1;
    return `${scope}-${this.sequence}`;
  }
}

export class AdvancingClock {
  private current = new Date("2026-09-21T08:00:00.000Z").getTime();
  public now(): Date {
    const value = new Date(this.current);
    this.current += 1_000;
    return value;
  }
}

export async function loadWorkflow(): Promise<WorkflowDefinition> {
  const raw = await readFile(resolve(process.cwd(), "examples", "reimbursement.workflow.json"), "utf8");
  return JSON.parse(raw) as WorkflowDefinition;
}

export function createFixture(options?: { readonly allowWithdrawAfterTaskCompleted?: boolean }): {
  readonly facade: ApprovalFacade;
  readonly store: InMemoryApprovalStore;
} {
  const store = new InMemoryApprovalStore();
  const organization = new StaticOrganizationProvider((policy) => {
    if (policy.type === "MANAGER") return ["manager-1"];
    if (policy.type === "ROLE" && policy.value === "finance-approver") return ["finance-1"];
    return [];
  });
  const facade = new ApprovalFacade(
    store,
    {
      organizationProvider: organization,
      clock: new AdvancingClock(),
      ids: new SequentialIds(),
    },
    options?.allowWithdrawAfterTaskCompleted === undefined
      ? undefined
      : { withdrawalPolicy: { allowAfterTaskCompleted: options.allowWithdrawAfterTaskCompleted } },
  );
  return { facade, store };
}

export async function startHighValueExpense(facade: ApprovalFacade, businessId: string): Promise<string> {
  const instance = await facade.start({
    idempotencyKey: `expense:${businessId}:start`,
    definitionKey: "expense-approval",
    business: { type: "expense", id: businessId },
    applicantId: "employee-1",
    context: { amount: 6800 },
  });
  return instance.id;
}
