import { commandFingerprint } from "../application/command-fingerprint.js";
import type { WorkflowDefinition } from "../contracts/workflow.js";
import { ApprovalError } from "../domain/errors.js";
import { parseWorkflowDefinition } from "../domain/workflow-validator.js";
import type { Clock, IdGenerator } from "../ports/platform.js";
import type { WorkflowManagementStore } from "../ports/workflow-management-store.js";
import type {
  WorkflowDefinitionRecord,
  WorkflowDefinitionStatus,
  WorkflowDraftRecord,
  WorkflowValidationResult,
  WorkflowVersionRecord,
} from "./model.js";

export interface CreateWorkflowCommand {
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  readonly operatorId: string;
}

export interface SaveWorkflowDraftCommand {
  readonly definitionId: string;
  readonly expectedRevision: number;
  readonly content: unknown;
  readonly operatorId: string;
}

export interface PublishWorkflowDraftCommand {
  readonly definitionId: string;
  readonly expectedRevision: number;
  readonly operatorId: string;
}

function nonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new ApprovalError("INVALID_COMMAND", `${field} is required`);
}

const WORKFLOW_KEY_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;

function parseDraftContent(value: unknown): Readonly<Record<string, unknown>> {
  commandFingerprint(value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApprovalError("INVALID_COMMAND", "Draft content must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record["nodes"]) || !Array.isArray(record["edges"])) {
    throw new ApprovalError("INVALID_COMMAND", "Draft content must contain nodes and edges arrays");
  }
  return structuredClone(record);
}

export class WorkflowManager {
  public constructor(
    private readonly store: WorkflowManagementStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  public createDefinition(command: CreateWorkflowCommand): Promise<WorkflowDefinitionRecord> {
    nonEmpty(command.key, "key");
    nonEmpty(command.name, "name");
    nonEmpty(command.operatorId, "operatorId");
    if (!WORKFLOW_KEY_PATTERN.test(command.key)) {
      throw new ApprovalError("INVALID_COMMAND", "key must match ^[a-z][a-z0-9-]{2,63}$");
    }
    if (command.name.length > 100) throw new ApprovalError("INVALID_COMMAND", "name must not exceed 100 characters");
    if (command.description !== undefined && command.description.length > 500) {
      throw new ApprovalError("INVALID_COMMAND", "description must not exceed 500 characters");
    }
    const occurredAt = this.clock.now().toISOString();
    return this.store.createDefinition({
      id: this.ids.nextId("workflow-definition"),
      key: command.key,
      name: command.name,
      ...(command.description === undefined ? {} : { description: command.description }),
      createdBy: command.operatorId,
      occurredAt,
    });
  }

  public getDraft(definitionId: string): Promise<WorkflowDraftRecord> {
    nonEmpty(definitionId, "definitionId");
    return this.requireDraft(definitionId);
  }

  public saveDraft(command: SaveWorkflowDraftCommand): Promise<WorkflowDraftRecord> {
    nonEmpty(command.definitionId, "definitionId");
    nonEmpty(command.operatorId, "operatorId");
    if (!Number.isInteger(command.expectedRevision) || command.expectedRevision < 0) {
      throw new ApprovalError("INVALID_COMMAND", "expectedRevision must be a non-negative integer");
    }
    return this.store.saveDraft({
      definitionId: command.definitionId,
      expectedRevision: command.expectedRevision,
      content: parseDraftContent(command.content),
      updatedBy: command.operatorId,
      occurredAt: this.clock.now().toISOString(),
    });
  }

  public async validateDraft(definitionId: string): Promise<WorkflowValidationResult> {
    try {
      await this.loadDraftDefinition(definitionId);
      return { valid: true, errors: [] };
    } catch (error) {
      if (error instanceof ApprovalError && error.code === "INVALID_WORKFLOW") {
        return { valid: false, errors: [error.message] };
      }
      throw error;
    }
  }

  public async publishDraft(command: PublishWorkflowDraftCommand): Promise<WorkflowVersionRecord> {
    nonEmpty(command.definitionId, "definitionId");
    nonEmpty(command.operatorId, "operatorId");
    if (!Number.isInteger(command.expectedRevision) || command.expectedRevision < 0) {
      throw new ApprovalError("INVALID_COMMAND", "expectedRevision must be a non-negative integer");
    }
    const { draft } = await this.loadDraftDefinition(command.definitionId);
    if (draft.revision !== command.expectedRevision) {
      throw new ApprovalError("VERSION_CONFLICT", "Workflow draft was modified concurrently");
    }
    return this.store.publishDraft({
      versionId: this.ids.nextId("workflow-version"),
      definitionId: command.definitionId,
      expectedRevision: command.expectedRevision,
      publishedBy: command.operatorId,
      occurredAt: this.clock.now().toISOString(),
    });
  }

  public listVersions(definitionId: string): Promise<readonly WorkflowVersionRecord[]> {
    nonEmpty(definitionId, "definitionId");
    return this.store.listVersions(definitionId);
  }

  public setStatus(
    definitionId: string,
    status: WorkflowDefinitionStatus,
    operatorId: string,
  ): Promise<WorkflowDefinitionRecord> {
    nonEmpty(definitionId, "definitionId");
    nonEmpty(operatorId, "operatorId");
    if (status !== "ACTIVE" && status !== "DISABLED") {
      throw new ApprovalError("INVALID_COMMAND", "status must be ACTIVE or DISABLED");
    }
    return this.store.setDefinitionStatus(definitionId, status, operatorId, this.clock.now().toISOString());
  }

  private async loadDraftDefinition(
    definitionId: string,
  ): Promise<{ readonly definition: WorkflowDefinition; readonly draft: WorkflowDraftRecord }> {
    nonEmpty(definitionId, "definitionId");
    const [definition, draft] = await Promise.all([
      this.store.getDefinition(definitionId),
      this.requireDraft(definitionId),
    ]);
    if (definition === undefined) {
      throw new ApprovalError("WORKFLOW_NOT_FOUND", `Workflow definition '${definitionId}' was not found`);
    }
    const candidate = {
      key: definition.key,
      name: definition.name,
      version: 1,
      ...(definition.description === undefined ? {} : { description: definition.description }),
      ...draft.content,
    };
    return { definition: parseWorkflowDefinition(candidate), draft };
  }

  private async requireDraft(definitionId: string): Promise<WorkflowDraftRecord> {
    const draft = await this.store.getDraft(definitionId);
    if (draft === undefined) throw new ApprovalError("WORKFLOW_NOT_FOUND", `Workflow draft '${definitionId}' was not found`);
    return draft;
  }
}
