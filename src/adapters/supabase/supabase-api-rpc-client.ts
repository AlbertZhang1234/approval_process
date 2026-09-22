import { ApprovalError } from "../../domain/errors.js";
import type { ApprovalRpcClient, ApprovalRpcFunction } from "../rpc/rpc-client.js";

export interface SupabaseApiRpcClientOptions {
  readonly url: string;
  readonly secretKey: string;
  readonly timeoutMilliseconds?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export class SupabaseApiRpcClient implements ApprovalRpcClient {
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly timeoutMilliseconds: number;

  public constructor(private readonly options: SupabaseApiRpcClientOptions) {
    if (typeof window !== "undefined") {
      throw new ApprovalError("INVALID_COMMAND", "Supabase approval adapter may only run on the server");
    }
    if (options.secretKey.trim().length === 0) {
      throw new ApprovalError("INVALID_COMMAND", "Supabase secretKey is required");
    }
    if (
      options.timeoutMilliseconds !== undefined
      && (!Number.isInteger(options.timeoutMilliseconds) || options.timeoutMilliseconds < 1)
    ) {
      throw new ApprovalError("INVALID_COMMAND", "timeoutMilliseconds must be a positive integer");
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(options.url);
    } catch {
      throw new ApprovalError("INVALID_COMMAND", "Supabase url is invalid");
    }
    if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "localhost" && parsedUrl.hostname !== "127.0.0.1") {
      throw new ApprovalError("INVALID_COMMAND", "Supabase url must use HTTPS outside local development");
    }
    if (parsedUrl.username.length > 0 || parsedUrl.password.length > 0) {
      throw new ApprovalError("INVALID_COMMAND", "Supabase url must not contain credentials");
    }
    this.baseUrl = parsedUrl.toString().replace(/\/$/, "");
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 15_000;
  }

  public async call(
    functionName: ApprovalRpcFunction,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const response = await this.fetchImplementation(`${this.baseUrl}/rest/v1/rpc/${functionName}`, {
      method: "POST",
      headers: {
        apikey: this.options.secretKey,
        authorization: `Bearer ${this.options.secretKey}`,
        "content-type": "application/json",
        accept: "application/json",
        "content-profile": "approval_api",
        "accept-profile": "approval_api",
      },
      body: JSON.stringify({ p_input: input }),
      signal: AbortSignal.timeout(this.timeoutMilliseconds),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Supabase approval RPC failed (${response.status}): ${body.slice(0, 2_000)}`);
    }
    return body.length === 0 ? null : JSON.parse(body);
  }
}
