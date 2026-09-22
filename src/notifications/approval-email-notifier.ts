import { ApprovalError } from "../domain/errors.js";
import type { DomainEvent } from "../domain/model.js";
import type { EmailSender, EmailTemplateRenderer } from "../ports/email.js";
import type { UserContactProvider } from "../ports/organization.js";
import type { ApprovalStore } from "../ports/store.js";

export class ApprovalEmailNotifier {
  public constructor(
    private readonly store: ApprovalStore,
    private readonly contacts: UserContactProvider,
    private readonly templates: EmailTemplateRenderer,
    private readonly sender: EmailSender,
  ) {}

  public async handle(event: DomainEvent): Promise<void> {
    if (event.type === "approval.task.created") {
      const assigneeId = event.data["assigneeId"];
      if (typeof assigneeId !== "string") {
        throw new ApprovalError("INVALID_COMMAND", "Task-created event has no assigneeId");
      }
      const contact = await this.contacts.getUserContact(assigneeId);
      if (contact === undefined) {
        throw new ApprovalError("ASSIGNEE_NOT_FOUND", `No email contact found for '${assigneeId}'`);
      }
      const content = await this.templates.render("approval-task-created", {
        recipientName: contact.displayName,
        businessType: event.business.type,
        businessId: event.business.id,
        businessUrl: event.business.url ?? "",
        nodeId: event.data["nodeId"],
      });
      await this.sender.send({
        idempotencyKey: `${event.id}:email`,
        to: [contact.email],
        ...content,
      });
      return;
    }

    if (event.type !== "approval.instance.approved" && event.type !== "approval.instance.rejected") return;
    const instance = await this.store.getInstance(event.instanceId);
    if (instance === undefined) {
      throw new ApprovalError("INSTANCE_NOT_FOUND", `Instance '${event.instanceId}' was not found for notification`);
    }
    const contact = await this.contacts.getUserContact(instance.applicantId);
    if (contact === undefined) {
      throw new ApprovalError("ASSIGNEE_NOT_FOUND", `No email contact found for '${instance.applicantId}'`);
    }
    const result = event.type === "approval.instance.approved" ? "APPROVED" : "REJECTED";
    const content = await this.templates.render("approval-result", {
      recipientName: contact.displayName,
      businessType: event.business.type,
      businessId: event.business.id,
      businessUrl: event.business.url ?? "",
      result,
    });
    await this.sender.send({
      idempotencyKey: `${event.id}:email`,
      to: [contact.email],
      ...content,
    });
  }
}

