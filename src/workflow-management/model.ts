import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from "../contracts/workflow.js";

export type WorkflowDefinitionStatus = "ACTIVE" | "DISABLED";

export interface WorkflowDraftContent {
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
}

export interface WorkflowDefinitionRecord {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  readonly status: WorkflowDefinitionStatus;
  readonly currentVersion?: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowDraftRecord {
  readonly definitionId: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly revision: number;
  readonly publishedRevision?: number;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export interface WorkflowVersionRecord {
  readonly id: string;
  readonly definitionId: string;
  readonly version: number;
  readonly schemaVersion: number;
  readonly content: WorkflowDefinition;
  readonly contentHash: string;
  readonly publishedBy: string;
  readonly publishedAt: string;
}

export interface WorkflowValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}
