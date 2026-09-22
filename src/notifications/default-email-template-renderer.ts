import type { EmailTemplateRenderer } from "../ports/email.js";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeLink(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "";
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export class DefaultEmailTemplateRenderer implements EmailTemplateRenderer {
  public async render(
    templateKey: "approval-task-created" | "approval-result",
    variables: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly subject: string; readonly html: string }> {
    const businessLabel = `${escapeHtml(variables["businessType"])} ${escapeHtml(variables["businessId"])}`;
    const businessUrl = safeLink(variables["businessUrl"]);
    const link = businessUrl ? `<p><a href="${escapeHtml(businessUrl)}">查看详情</a></p>` : "";
    if (templateKey === "approval-task-created") {
      return {
        subject: `待审批：${businessLabel}`,
        html: `<p>${escapeHtml(variables["recipientName"])}，您有一项新的审批任务。</p><p>${businessLabel}</p>${link}`,
      };
    }
    const resultText = variables["result"] === "APPROVED" ? "已通过" : "已驳回";
    return {
      subject: `审批${resultText}：${businessLabel}`,
      html: `<p>${escapeHtml(variables["recipientName"])}，您的申请${resultText}。</p><p>${businessLabel}</p>${link}`,
    };
  }
}
