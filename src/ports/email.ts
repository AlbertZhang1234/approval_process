export interface EmailMessage {
  readonly idempotencyKey: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly html: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export interface EmailTemplateRenderer {
  render(
    templateKey: "approval-task-created" | "approval-result",
    variables: Readonly<Record<string, unknown>>,
  ): Promise<Pick<EmailMessage, "subject" | "html">>;
}

