import type {
  WorkflowDefinitionRecord,
  WorkflowDefinitionStatus,
  WorkflowDraftRecord,
  WorkflowVersionRecord,
} from "../workflow-management/model.js";

export interface CreateWorkflowDefinitionRecord {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  readonly createdBy: string;
  readonly occurredAt: string;
}

export interface SaveWorkflowDraftRecord {
  readonly definitionId: string;
  readonly expectedRevision: number;
  readonly content: Readonly<Record<string, unknown>>;
  readonly updatedBy: string;
  readonly occurredAt: string;
}

export interface PublishWorkflowDraftRecord {
  readonly versionId: string;
  readonly definitionId: string;
  readonly expectedRevision: number;
  readonly publishedBy: string;
  readonly occurredAt: string;
}

export interface WorkflowManagementStore {
  createDefinition(input: CreateWorkflowDefinitionRecord): Promise<WorkflowDefinitionRecord>;
  getDefinition(definitionId: string): Promise<WorkflowDefinitionRecord | undefined>;
  getDefinitionByKey(key: string): Promise<WorkflowDefinitionRecord | undefined>;
  getDraft(definitionId: string): Promise<WorkflowDraftRecord | undefined>;
  saveDraft(input: SaveWorkflowDraftRecord): Promise<WorkflowDraftRecord>;
  publishDraft(input: PublishWorkflowDraftRecord): Promise<WorkflowVersionRecord>;
  listVersions(definitionId: string): Promise<readonly WorkflowVersionRecord[]>;
  setDefinitionStatus(
    definitionId: string,
    status: WorkflowDefinitionStatus,
    updatedBy: string,
    occurredAt: string,
  ): Promise<WorkflowDefinitionRecord>;
}
