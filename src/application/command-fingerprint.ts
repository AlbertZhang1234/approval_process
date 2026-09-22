import { createHash } from "node:crypto";
import { ApprovalError } from "../domain/errors.js";

function canonicalize(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ApprovalError("INVALID_COMMAND", `${path} must contain a finite number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new ApprovalError("INVALID_COMMAND", `${path} contains a circular reference`);
    seen.add(value);
    const result = `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new ApprovalError("INVALID_COMMAND", `${path} contains a circular reference`);
    seen.add(value);
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], `${path}.${key}`, seen)}`);
    seen.delete(value);
    return `{${entries.join(",")}}`;
  }
  throw new ApprovalError("INVALID_COMMAND", `${path} contains a non-JSON value`);
}

export function commandFingerprint(command: unknown): string {
  const canonical = canonicalize(command, "command", new Set<object>());
  return createHash("sha256").update(canonical).digest("hex");
}
