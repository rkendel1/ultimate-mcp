// Fail-closed behaviour of the gateway, in-process, with a stub authority and an evidence store that
// fails on demand. These cases cannot be produced reliably against real services:
//   - evidence cannot be written for a refusal        → 503, never a silent refusal
//   - evidence cannot be written before an execution  → 503, nothing executes
//   - evidence cannot be written after an execution   → 503, the result is withheld
//   - AppPort is reached without an AuthBoundry allow → refused by the authorizer (defence in depth)
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeltDB, openAgentState, type StateFirstDB } from "@feltdb/core";
import type { Authority, AuthorityDecision } from "../src/authority.ts";
import { feltDbEvidence, type EvidenceRecord, type EvidenceStore } from "../src/evidence.ts";
import { createGateway, type Gateway } from "../src/gateway.ts";

const allow: AuthorityDecision = {
  outcome: "allow", allowed: true, decisionId: "stub-decision-1", reason: null, httpStatus: 200,
  principalId: "agent:stub", executor: { proven: true, agentCredentialId: "cred-1" }, onBehalfOf: null, delegationId: null,
};
const deny: AuthorityDecision = { ...allow, outcome: "deny", allowed: false, reason: "denied" };
const unavailable: AuthorityDecision = { ...deny, outcome: "unavailable", decisionId: null, principalId: null, executor: null, httpStatus: null, reason: "authorization could not be established: AuthBoundry unreachable" };

let db: StateFirstDB;
let real: EvidenceStore;
let server: Server;
let gateway: Gateway;
let url = "";
let decision: AuthorityDecision = allow;
/** Which evidence phases fail to write. */
const failing = new Set<EvidenceRecord["phase"]>();
const authority: Authority = { decide: async () => decision };
const flaky: EvidenceStore = {
  append: async (r) => { if (failing.has(r.phase)) throw new Error("evidence store unavailable"); await real.append(r); },
  get: (id) => real.get(id),
  list: (i) => real.list(i),
};

before(async () => {
  db = createFeltDB({ path: mkdtempSync(join(tmpdir(), "boundry-failclosed-")) });
  real = feltDbEvidence(db);
  gateway = createGateway({ db, authority, evidence: flaky });
  server = createServer((q, s) => { void gateway.handle(q, s); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/mcp`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.close();
});

async function callTool(args: Record<string, unknown> = { objective: "fail-closed" }) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer aga_stubstubstub.secret" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "work_task_create", arguments: args } }),
  });
  return { status: response.status, body: (await response.json()) as { result?: { isError?: boolean; structuredContent?: { task_id?: string } }; error?: { message: string } } };
}

const taskCount = async () => (await (await openAgentState(db)).listTasks({ limit: 1000 })).tasks.length;

test("a refusal whose evidence cannot be written is reported as a failure, not a refusal", async () => {
  decision = deny; failing.clear(); failing.add("outcome");
  const r = await callTool();
  assert.equal(r.status, 503);
  assert.match(String(r.body.error?.message), /^EVIDENCE_UNAVAILABLE/);
  assert.equal(r.body.result, undefined);
});

test("an allowed call whose authorization cannot be recorded does not execute", async () => {
  decision = allow; failing.clear(); failing.add("authorized");
  const before = await taskCount();
  const r = await callTool();
  assert.equal(r.status, 503);
  assert.match(String(r.body.error?.message), /^EVIDENCE_UNAVAILABLE/);
  assert.equal(await taskCount(), before, "nothing may execute without its authorization on record");
});

test("an executed call whose outcome cannot be recorded withholds its result", async () => {
  decision = allow; failing.clear(); failing.add("outcome");
  const before = await taskCount();
  const r = await callTool();
  assert.equal(r.status, 503);
  assert.equal(r.body.result, undefined, "no auditable success without its record");
  // The work did run (it cannot be undone); its authorized record says so, and the outcome is missing.
  assert.equal(await taskCount(), before + 1);
  const records = (await real.list({ limit: 100 })).records;
  const authorized = records.find((x) => x.phase === "authorized");
  assert.ok(authorized);
  assert.equal(records.some((x) => x.phase === "outcome" && x.correlation_id === authorized.correlation_id), false);
});

test("authority unavailable is recorded as a refusal with no decision id", async () => {
  decision = unavailable; failing.clear();
  const r = await callTool();
  assert.equal(r.status, 200);
  assert.equal(r.body.result?.isError, true);
  const [latest] = (await real.list({ limit: 1 })).records;
  assert.equal(latest?.authority.outcome, "unavailable");
  assert.equal(latest?.authority.decision_id, null);
  assert.equal(latest?.result.status, "refused");
});

test("AppPort refuses dispatch that did not come through an AuthBoundry allow", async () => {
  const response = await gateway.application.handleRequest(
    { protocol: "appport/1", type: "request", requestId: "direct-1", capability: { name: "work.task.create", version: 1 }, input: { objective: "bypass" } } as never,
    { transport: "test", principal: { id: "agent:stub", type: "service" } },
  );
  assert.equal((response as { ok: boolean }).ok, false);
  assert.equal((response as { error: { code: string } }).error.code, "FORBIDDEN");
});
