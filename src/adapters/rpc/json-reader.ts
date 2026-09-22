import { ApprovalError } from "../../domain/errors.js";

function invalid(path: string): never {
  throw new ApprovalError("PERSISTENCE_ERROR", `Approval database returned invalid data at '${path}'`);
}

export function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid(path);
  return value as Record<string, unknown>;
}

export function readArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) return invalid(path);
  return value;
}

export function readString(value: unknown, path: string): string {
  if (typeof value !== "string") return invalid(path);
  return value;
}

export function readOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return readString(value, path);
}

export function readInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value)) return invalid(path);
  return value as number;
}

export function readEnum<const T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) return invalid(path);
  return value as T;
}

