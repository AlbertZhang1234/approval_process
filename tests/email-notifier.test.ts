import assert from "node:assert/strict";
import test from "node:test";
import {
  ApprovalEmailNotifier,
  DefaultEmailTemplateRenderer,
  type DomainEvent,
  type EmailMessage,
  type EmailSender,
  type UserContactProvider,
} from "../src/index.js";
import { InMemoryApprovalStore } from "../src/adapters/in-memory/index.js";

test("task-created outbox event renders and sends an idempotent email", async () => {
  const sent: EmailMessage[] = [];
  const sender: EmailSender = {
    send: (message) => {
      sent.push(message);
      return Promise.resolve();
    },
  };
  const contacts: UserContactProvider = {
    getUserContact: (userId) =>
      Promise.resolve({ userId, displayName: "审批人", email: "approver@example.com" }),
  };
  const notifier = new ApprovalEmailNotifier(
    new InMemoryApprovalStore(),
    contacts,
    new DefaultEmailTemplateRenderer(),
    sender,
  );
  const event: DomainEvent = {
    id: "event-1",
    type: "approval.task.created",
    instanceId: "instance-1",
    business: { type: "expense", id: "EXP-1", url: "https://internal.example/expenses/EXP-1" },
    occurredAt: "2026-09-09T08:00:00.000Z",
    data: { taskId: "task-1", assigneeId: "manager-1", nodeId: "manager_review" },
  };

  await notifier.handle(event);

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.idempotencyKey, "event-1:email");
  assert.deepEqual(sent[0]?.to, ["approver@example.com"]);
  assert.match(sent[0]?.subject ?? "", /EXP-1/);
});

test("default email templates do not render unsafe links", async () => {
  const renderer = new DefaultEmailTemplateRenderer();
  const rendered = await renderer.render("approval-task-created", {
    recipientName: "审批人",
    businessType: "expense",
    businessId: "EXP-2",
    businessUrl: "javascript:alert(1)",
  });
  assert.doesNotMatch(rendered.html, /href=/);
});
