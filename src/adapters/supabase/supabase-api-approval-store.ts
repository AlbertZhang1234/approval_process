import { RpcApprovalStore } from "../rpc/rpc-approval-store.js";
import {
  SupabaseApiRpcClient,
  type SupabaseApiRpcClientOptions,
} from "./supabase-api-rpc-client.js";

export class SupabaseApiApprovalStore extends RpcApprovalStore {
  public constructor(options: SupabaseApiRpcClientOptions) {
    super(new SupabaseApiRpcClient(options));
  }
}

export function createSupabaseApiApprovalStore(
  options: SupabaseApiRpcClientOptions,
): SupabaseApiApprovalStore {
  return new SupabaseApiApprovalStore(options);
}

