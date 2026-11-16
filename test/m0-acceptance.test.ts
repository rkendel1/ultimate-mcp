// M0 acceptance tests: the standalone gateway against the REAL AuthBoundry server and REAL FeltDB
// persistence, driven through two independent MCP client implementations (official TypeScript SDK
// and official Python SDK). Every call's durable evidence is checked, not just its response.
//
// Requires: AuthBoundry built locally (AUTHBOUNDRY_SRC / AUTHBOUNDRY_BIN, see test/support/authboundry.ts)
// and the Python driver's virtualenv (test/clients/.venv with `mcp==2.3.0`).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeltDB, openAgentState } from "@feltdb/core";
import { startLocalAuthority, APPLICATION, type LocalAuthority } from "./support/authboundry.ts";
import { startDriver, startGateway, type CallResult, type Driver, type GatewayProcess } from "./support/processes.ts";
import { EVIDENCE_COLLECTION, type EvidenceRecord } from "../src/evidence.ts";

let authority: LocalAuthority;
let gateway: GatewayProcess;
const stateDir = mkdtempSync(join(tmpdir(), "boundry-gateway-"));
const transcripts: Record<string, Array<{ step: string; is_error: boolean | null; code: string | null; transport_ok: boolean }>> = {};
const createdTasks: Array<{ task_id: string; expected_creator: string }> = [];
const evidenceSeen = new Set<string>();
let readerHeaders: Record<string, string> = {};

const ADA = "user:ada";
const obo = { "x-boundry-on-behalf-of": ADA };
const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

before(async () => {
  authority = await startLocalAuthority();
  await authority.addPerson(ADA);
  gateway = await startGateway({ stateDir, authorityUrl: authority.url, applicationId: APPLICATION, checkCredential: authority.checkCredential });
});

after(async () => {
  await gateway?.kill("SIGKILL");
  authority?.cleanup();
});

function call(r: CallResult) {
  assert.equal(r.ok, true, `transport/protocol failure: ${"error" in r ? r.error : ""}`);
  return r as Extract<CallResult, { is_error: boolean }>;
}

/** Newest-first evidence, read through MCP by an agent holding evidence.list. */
async function evidence(driver: Driver, headers: Record<string, string>): Promise<EvidenceRecord[]> {
  const r = call(await driver.call(gateway.url, "evidence_list", { limit: 100 }, headers));
  assert.equal(r.is_error, false, `evidence.list refused: ${r.code}`);
  const records = (r.structured as { records: EvidenceRecord[] }).records;
  for (const rec of records) evidenceSeen.add(rec.id);
  return records;
}

/** The outcome record of the most recent call to `tool` (calls in a scenario are sequential). */
async function lastOutcome(driver: Driver, tool: string): Promise<EvidenceRecord> {
  const records = await evidence(driver, readerHeaders);
  const found = records.find((r) => r.phase === "outcome" && r.tool === tool);
  assert.ok(found, `no outcome record for ${tool}`);
  return found;
}

async function scenario(driver: Driver) {
  const p = driver.name === "typescript" ? "ts" : "py";
  const transcript: (typeof transcripts)[string] = [];
  const step = (name: string, r: CallResult) => {
    transcript.push({ step: name, transport_ok: r.ok, is_error: "is_error" in r ? r.is_error : null, code: "code" in r ? r.code : null });
    return r;
  };
  const A = await authority.addAgent(`agent:${p}-a`);
  const B = await authority.addAgent(`agent:${p}-b`);
  const reader = await authority.addAgent(`agent:${p}-reader`);
  await authority.delegate(ADA, reader.principal, ["evidence.list", "evidence.get"]);
  readerHeaders = { ...bearer(reader.secret), ...obo };
  const asA = { ...bearer(A.secret), ...obo };

  // 1. Discovery.
  const listed = step("list", await driver.list(gateway.url)) as { ok: true; tools: string[] };
  assert.deepEqual(listed.tools, ["evidence_get", "evidence_list", "work_task_create"]);

  // 2. Authenticated, but no delegation: AuthBoundry denies, with a durable decision id.
  let r = call(step("no-delegation", await driver.call(gateway.url, "work_task_create", { objective: "x" }, asA)));
  assert.equal(r.is_error, true); assert.equal(r.code, "FORBIDDEN");
  let ev = await lastOutcome(driver, "work_task_create");
  assert.equal(ev.result.status, "refused");
  assert.equal(ev.authority.outcome, "deny");
  assert.match(String(ev.authority.decision_id), /decision/);
  assert.equal(ev.authority.principal_id, A.principal);
  assert.equal(ev.caller.authenticated_principal_id, A.principal);

  // 3. Delegated: allowed, executed, attributed to A, with authorized + outcome records.
  const delegation = await authority.delegate(ADA, A.principal, ["work.task.create"]);
  r = call(step("allowed", await driver.call(gateway.url, "work_task_create", { objective: `M0 ${p}` }, asA)));
  assert.equal(r.is_error, false);
  assert.equal(r.structured?.created_by, A.principal);
  assert.equal(r.structured?.owner, A.principal);
  createdTasks.push({ task_id: String(r.structured?.task_id), expected_creator: A.principal });
  ev = await lastOutcome(driver, "work_task_create");
  assert.equal(ev.result.status, "completed");
  assert.equal(ev.result.reference, `task:${r.structured?.task_id}`);
  assert.equal(ev.authority.outcome, "allow");
  assert.equal(ev.authority.delegation_id, delegation);
  assert.equal(ev.on_behalf_of, ADA);
  assert.equal(ev.caller.authentication, "authboundry_agent_credential");
  assert.deepEqual(ev.executor, { service: "boundry-continuity", identity_basis: "asserted_by_configuration" });
  const allowedOutcome = ev;
  const authorized = (await evidence(driver, readerHeaders)).find((x) => x.phase === "authorized" && x.correlation_id === allowedOutcome.correlation_id);
  assert.ok(authorized, "an allowed invocation must have an authorized record committed before execution");
  assert.equal(authorized.authority.decision_id, allowedOutcome.authority.decision_id);
  assert.ok(authorized.recorded_at <= allowedOutcome.recorded_at);

  // 4. Missing credential: refused without asking anyone, and recorded.
  r = call(step("missing-credential", await driver.call(gateway.url, "work_task_create", { objective: "x" }, { ...obo })));
  assert.equal(r.code, "UNAUTHORIZED");
  ev = await lastOutcome(driver, "work_task_create");
  assert.equal(ev.caller.credential, "none");
  assert.equal(ev.authority.asked, false);
  assert.equal(ev.authority.decision_id, null);

  // 5. Malformed credential.
  r = call(step("malformed-credential", await driver.call(gateway.url, "work_task_create", { objective: "x" }, { authorization: "Basic dXNlcjpwYXNz", ...obo })));
  assert.equal(r.code, "UNAUTHORIZED");
  ev = await lastOutcome(driver, "work_task_create");
  assert.equal(ev.caller.credential, "malformed");
  assert.equal(ev.authority.asked, false);

  // 6. Well-formed but unknown credential: AuthBoundry rejects it; no decision id is invented.
  r = call(step("invalid-credential", await driver.call(gateway.url, "work_task_create", { objective: "x" }, { ...bearer("aga_0000000000000000.notarealsecret"), ...obo })));
  assert.equal(r.code, "UNAUTHORIZED");
  ev = await lastOutcome(driver, "work_task_create");
  assert.equal(ev.authority.outcome, "unauthenticated");
  assert.equal(ev.authority.reason, "invalid_agent_credential");
  assert.equal(ev.authority.decision_id, null);
  assert.equal(ev.caller.authenticated_principal_id, null);

  // 7. Credential substitution: A authenticates and claims to be B in every place a request can.
  r = call(step("substitution-claims", await driver.call(gateway.url, "work_task_create", { objective: "claims B" },
    { ...asA, "x-boundry-principal": B.principal, "x-principal-id": B.principal, "x-authboundry-agent-credential": B.secret },
    { principal: B.principal, "dev.boundry/principal": B.principal })));
  assert.equal(r.is_error, false);
  assert.equal(r.structured?.created_by, A.principal, "a claimed identity must never be attributed");
  createdTasks.push({ task_id: String(r.structured?.task_id), expected_creator: A.principal });
  ev = await lastOutcome(driver, "work_task_create");
  assert.equal(ev.caller.authenticated_principal_id, A.principal);
  assert.equal(ev.authority.principal_id, A.principal);
  //    ... and in the capability's own input:
  r = call(step("substitution-argument", await driver.call(gateway.url, "work_task_create", { objective: "arg claims B", actor: B.principal }, asA)));
  assert.equal(r.is_error, true);
  ev = await lastOutcome(driver, "work_task_create");
  assert.equal(ev.result.status, "failed");
  assert.equal(ev.result.reference, null);
  assert.equal(ev.caller.authenticated_principal_id, A.principal);
  //    ... and B, holding no delegation, cannot borrow A's by claiming to be A:
  r = call(step("substitution-other-agent", await driver.call(gateway.url, "work_task_create", { objective: "B claims A" },
    { ...bearer(B.secret), ...obo, "x-boundry-principal": A.principal })));
  assert.equal(r.code, "FORBIDDEN");
  ev = await lastOutcome(driver, "work_task_create");
  assert.equal(ev.authority.principal_id, B.principal);

  // 8. Revoking the delegation stops the next call.
  await authority.revokeDelegation(delegation);
  r = call(step("delegation-revoked", await driver.call(gateway.url, "work_task_create", { objective: "x" }, asA)));
  assert.equal(r.code, "FORBIDDEN");
  ev = await lastOutcome(driver, "work_task_create");
  assert.equal(ev.authority.outcome, "deny");
  assert.ok(ev.authority.decision_id);

  // 9. Revoking the credential stops the next call, even with a live delegation.
  await authority.delegate(ADA, A.principal, ["work.task.create"]);
  r = call(step("re-delegated", await driver.call(gateway.url, "work_task_create", { objective: `M0 ${p} again` }, asA)));
  assert.equal(r.is_error, false);
  createdTasks.push({ task_id: String(r.structured?.task_id), expected_creator: A.principal });
  await authority.revokeCredential(A.id);
  r = call(step("credential-revoked", await driver.call(gateway.url, "work_task_create", { objective: "x" }, asA)));
  assert.equal(r.code, "UNAUTHORIZED");
  ev = await lastOutcome(driver, "work_task_create");
  assert.equal(ev.authority.reason, "agent_credential_revoked");
  assert.equal(ev.authority.decision_id, null);

  // 10. evidence.get returns the stored record unchanged.
  r = call(step("evidence-get", await driver.call(gateway.url, "evidence_get", { id: allowedOutcome.id }, readerHeaders)));
  assert.equal(r.is_error, false);
  assert.deepEqual(r.structured?.record, allowedOutcome);

  // 11. AuthBoundry unavailable: refused as AUTHORITY_UNAVAILABLE, recorded, no decision id invented.
  authority.stop();
  r = call(step("authority-unavailable", await driver.call(gateway.url, "work_task_create", { objective: "x" }, { ...bearer(B.secret), ...obo })));
  assert.equal(r.code, "AUTHORITY_UNAVAILABLE");
  await authority.start();
  ev = await lastOutcome(driver, "work_task_create");
  assert.equal(ev.authority.asked, true);
  assert.equal(ev.authority.outcome, "unavailable");
  assert.equal(ev.authority.decision_id, null);
  assert.equal(ev.result.status, "refused");

  transcripts[driver.name] = transcript;
}

for (const name of ["typescript", "python"] as const) {
  test(`M0 scenario through the ${name} MCP client`, { timeout: 300_000 }, async () => {
    const driver = startDriver(name);
    try { await scenario(driver); } finally { driver.close(); }
  });
}

test("both clients observe equivalent authorization behaviour", () => {
  assert.ok(transcripts.typescript && transcripts.python, "both scenarios must have run");
  assert.deepEqual(transcripts.python, transcripts.typescript);
});

test("evidence survives a SIGKILL of the gateway, and the store refuses to overwrite a record", { timeout: 120_000 }, async () => {
  const driver = startDriver("typescript");
  try {
    const before = new Set((await evidence(driver, readerHeaders)).map((r) => r.id));
    assert.ok(before.size > 0);
    await gateway.kill("SIGKILL");
    gateway = await startGateway({ stateDir, authorityUrl: authority.url, applicationId: APPLICATION, checkCredential: authority.checkCredential });
    const afterIds = new Set((await evidence(driver, readerHeaders)).map((r) => r.id));
    for (const id of before) assert.ok(afterIds.has(id), `record ${id} lost across restart`);
  } finally { driver.close(); }

  // Stop the gateway (it owns the store's lock) and inspect FeltDB directly.
  await gateway.kill("SIGTERM");
  const db = createFeltDB({ path: stateDir });
  try {
    const collection = db.collection<Record<string, unknown>>(EVIDENCE_COLLECTION);
    const [someId] = [...evidenceSeen];
    const original = await collection.get(someId!);
    assert.ok(original);
    await assert.rejects(collection.insert({ ...original, id: someId, result: { status: "completed" } }, someId, { requireAbsent: true }), (e: { code?: string }) => e.code === "PRECONDITION_FAILED");
    assert.deepEqual(await collection.get(someId!), original, "the original record is untouched");
    // Every task exists and is attributed to the principal AuthBoundry authenticated, never a claimed one.
    const state = await openAgentState(db);
    for (const { task_id, expected_creator } of createdTasks) {
      const found = await state.getTask(task_id);
      assert.ok(found, `task ${task_id} missing`);
      assert.equal(found.task.created_by, expected_creator);
    }
  } finally {
    await db.close();
  }
});
