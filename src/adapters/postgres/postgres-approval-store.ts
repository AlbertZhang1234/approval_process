import postgres, { type Sql } from "postgres";
import { ApprovalError } from "../../domain/errors.js";
import { RpcApprovalStore } from "../rpc/rpc-approval-store.js";
import { PostgresRpcClient } from "./postgres-rpc-client.js";

export interface PostgresApprovalStoreOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly idleTimeoutSeconds?: number;
  readonly connectTimeoutSeconds?: number;
}

export class PostgresApprovalStore extends RpcApprovalStore {
  public constructor(
    private readonly sql: Sql,
    private readonly ownsClient = false,
  ) {
    super(new PostgresRpcClient(sql));
  }

  public async close(): Promise<void> {
    if (this.ownsClient) await this.sql.end();
  }
}

function validatePositiveInteger(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
    throw new ApprovalError("INVALID_COMMAND", `${field} must be a positive integer`);
  }
}

export function createPostgresApprovalStore(options: PostgresApprovalStoreOptions): PostgresApprovalStore {
  if (options.connectionString.trim().length === 0) {
    throw new ApprovalError("INVALID_COMMAND", "PostgreSQL connectionString is required");
  }
  validatePositiveInteger(options.maxConnections, "maxConnections");
  validatePositiveInteger(options.idleTimeoutSeconds, "idleTimeoutSeconds");
  validatePositiveInteger(options.connectTimeoutSeconds, "connectTimeoutSeconds");
  const sql = postgres(options.connectionString, {
    prepare: false,
    ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
    ...(options.idleTimeoutSeconds === undefined ? {} : { idle_timeout: options.idleTimeoutSeconds }),
    ...(options.connectTimeoutSeconds === undefined ? {} : { connect_timeout: options.connectTimeoutSeconds }),
  });
  return new PostgresApprovalStore(sql, true);
}

export function createPostgresApprovalStoreFromClient(sql: Sql): PostgresApprovalStore {
  return new PostgresApprovalStore(sql, false);
}
