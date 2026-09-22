import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalError } from "../src/domain/errors.js";
import { RpcApprovalStore } from "../src/adapters/rpc/rpc-approval-store.js";
import { SupabaseApiRpcClient } from "../src/adapters/supabase/supabase-api-rpc-client.js";

test("Supabase RPC client uses the private server key and approval_api profile", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fakeFetch: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new SupabaseApiRpcClient({
    url: "https://project-ref.supabase.co/",
    secretKey: "sb_secret_test-only",
    fetch: fakeFetch,
  });

  assert.deepEqual(await client.call("get_workflow_definition", { definitionId: "wf-1" }), { ok: true });
  assert.equal(capturedUrl, "https://project-ref.supabase.co/rest/v1/rpc/get_workflow_definition");
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get("apikey"), "sb_secret_test-only");
  assert.equal(headers.get("authorization"), "Bearer sb_secret_test-only");
  assert.equal(headers.get("content-profile"), "approval_api");
  assert.equal(capturedInit?.body, JSON.stringify({ p_input: { definitionId: "wf-1" } }));
});

test("Supabase adapter maps database markers without exposing the remote response", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ message: "APPROVAL:VERSION_CONFLICT", detail: "database details" }), {
      status: 400,
    });
  const store = new RpcApprovalStore(
    new SupabaseApiRpcClient({
      url: "http://localhost:54321",
      secretKey: "test-secret",
      fetch: fakeFetch,
    }),
  );

  await assert.rejects(
    store.getDraft("wf-1"),
    (error: unknown) =>
      error instanceof ApprovalError
      && error.code === "VERSION_CONFLICT"
      && error.message === "Approval data was modified concurrently",
  );
});

test("Supabase adapter rejects browser execution and insecure remote URLs", () => {
  assert.throws(
    () => new SupabaseApiRpcClient({ url: "http://example.com", secretKey: "secret" }),
    (error: unknown) => error instanceof ApprovalError && error.code === "INVALID_COMMAND",
  );
});
