import { parseWorkflowDefinition } from "../../domain/workflow-validator.js";
import type {
  WorkflowDefinitionRecord,
  WorkflowDraftRecord,
  WorkflowVersionRecord,
} from "../../workflow-management/model.js";
import {
  readArray,
  readEnum,
  readInteger,
  readOptionalString,
  readRecord,
  readString,
} from "./json-reader.js";

export function parseWorkflowRecord(value: unknown, path = "workflowDefinition"): WorkflowDefinitionRecord {
  const record = readRecord(value, path);
  const description = readOptionalString(record["description"], `${path}.description`);
  const currentVersion = record["currentVersion"] === undefined || record["currentVersion"] === null
    ? undefined
    : readInteger(record["currentVersion"], `${path}.currentVersion`);
  return {
    id: readString(record["id"], `${path}.id`),
    key: readString(record["key"], `${path}.key`),
    name: readString(record["name"], `${path}.name`),
    ...(description === undefined ? {} : { description }),
    status: readEnum(record["status"], ["ACTIVE", "DISABLED"], `${path}.status`),
    ...(currentVersion === undefined ? {} : { currentVersion }),
    createdBy: readString(record["createdBy"], `${path}.createdBy`),
    createdAt: readString(record["createdAt"], `${path}.createdAt`),
    updatedAt: readString(record["updatedAt"], `${path}.updatedAt`),
  };
}

export function parseWorkflowDraft(value: unknown, path = "workflowDraft"): WorkflowDraftRecord {
  const record = readRecord(value, path);
  const publishedRevision = record["publishedRevision"] === undefined || record["publishedRevision"] === null
    ? undefined
    : readInteger(record["publishedRevision"], `${path}.publishedRevision`);
  return {
    definitionId: readString(record["definitionId"], `${path}.definitionId`),
    content: structuredClone(readRecord(record["content"], `${path}.content`)),
    revision: readInteger(record["revision"], `${path}.revision`),
    ...(publishedRevision === undefined ? {} : { publishedRevision }),
    updatedBy: readString(record["updatedBy"], `${path}.updatedBy`),
    updatedAt: readString(record["updatedAt"], `${path}.updatedAt`),
  };
}

export function parseWorkflowVersion(value: unknown, path = "workflowVersion"): WorkflowVersionRecord {
  const record = readRecord(value, path);
  return {
    id: readString(record["id"], `${path}.id`),
    definitionId: readString(record["definitionId"], `${path}.definitionId`),
    version: readInteger(record["version"], `${path}.version`),
    schemaVersion: readInteger(record["schemaVersion"], `${path}.schemaVersion`),
    content: parseWorkflowDefinition(record["content"]),
    contentHash: readString(record["contentHash"], `${path}.contentHash`),
    publishedBy: readString(record["publishedBy"], `${path}.publishedBy`),
    publishedAt: readString(record["publishedAt"], `${path}.publishedAt`),
  };
}

export function parseWorkflowVersions(value: unknown): readonly WorkflowVersionRecord[] {
  return readArray(value, "workflowVersions").map((item, index) =>
    parseWorkflowVersion(item, `workflowVersions[${index}]`),
  );
}
