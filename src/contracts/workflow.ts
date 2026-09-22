export type WorkflowNodeType = "START" | "APPROVAL" | "CONDITION" | "END";
export type ApprovalMode = "ANY" | "ALL";
export type EmptyAssigneePolicy = "ERROR" | "SKIP" | "AUTO_APPROVE";
export type SelfApprovalPolicy = "ALLOW" | "SKIP" | "REQUIRE_OTHER";

export type AssigneePolicyType =
  | "USER"
  | "ROLE"
  | "DEPARTMENT_ROLE"
  | "MANAGER"
  | "REQUEST_FIELD"
  | "PROVIDER";

export interface AssigneePolicy {
  readonly type: AssigneePolicyType;
  readonly value: string;
}

export interface BasicWorkflowNode {
  readonly id: string;
  readonly name: string;
  readonly type: "START" | "CONDITION" | "END";
}

export interface ApprovalWorkflowNode {
  readonly id: string;
  readonly name: string;
  readonly type: "APPROVAL";
  readonly config: {
    readonly mode: ApprovalMode;
    readonly assignees: readonly AssigneePolicy[];
    readonly emptyAssigneePolicy: EmptyAssigneePolicy;
    readonly selfApprovalPolicy: SelfApprovalPolicy;
  };
}

export type WorkflowNode = BasicWorkflowNode | ApprovalWorkflowNode;

export type ConditionOperator =
  | "EQ"
  | "NE"
  | "GT"
  | "GTE"
  | "LT"
  | "LTE"
  | "IN"
  | "NOT_IN"
  | "EXISTS";

export interface PredicateCondition {
  readonly field: string;
  readonly operator: ConditionOperator;
  readonly value?: unknown;
}

export type WorkflowCondition =
  | PredicateCondition
  | { readonly all: readonly WorkflowCondition[] }
  | { readonly any: readonly WorkflowCondition[] }
  | { readonly not: WorkflowCondition };

export interface WorkflowEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly priority?: number;
  readonly default?: boolean;
  readonly condition?: WorkflowCondition;
}

export interface WorkflowDefinition {
  readonly key: string;
  readonly name: string;
  readonly version: number;
  readonly description?: string;
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
}

export interface BusinessReference {
  readonly type: string;
  readonly id: string;
  readonly url?: string;
}

