// D7(a) scenario (§4 of the authorization): one FeltKit application hosting the AuthBoundry-gated MCP gateway
// as an in-process component, exercised through two independent MCP clients (official TypeScript and Python
// SDKs), a person using FeltKit's own API, and FeltKit's live-query change stream.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalAuthority, type LocalAuthority, type AgentCredential } from "../../test/support/authboundry.ts";
import { startDriver, type CallResult, type Driver } from "../../test/support/processes.ts";
import { addNotesContract, NOTES_CAPABILITIES, appEnvironment, startApp, signUp, human, changeStream, evidenceFor, type FeltKitApp } from "./support.ts";

const ADA = "user:ada";
const GATEWAY = "component:agent-gateway";
let authority: LocalAuthority;
let app: FeltKitApp;
let person: { token: string; principalId: string };
const stateDir = mkdtempSync(join(tmpdir(), "d7-scenario-"));
const transcripts: Record<string, Array<Record<string, unknown>>> = {};
const noteIds: string[] = [];

before(async () => {
  authority = await startLocalAuthority();
  await addNotesContract(authority);
  await authority.addPerson(ADA, NOTES_CAPABILITIES);
  app = await startApp(appEnvironment({ stateDir, authority }));
});
after(async () => { await app?.kill("SIGKILL"); authority?.cleanup(); });

const call = (r: CallResult) => { assert.equal(r.ok, true, `transport failure: ${"error" in r ? r.error : ""}`); return r as Extract<CallResult, { is_error: boolean }>; };

test("1-2. the application and its agent-gateway component are healthy, and the component has no database", async () => {
  const h = (await (await fetch(`${app.url}/_feltkit/health`)).json()) as any;
  assert.equal(h.status, "ready");
  assert.equal(h.runtime, "ready");
  assert.equal(h.components["agent-gateway"].state, "ready");
  assert.deepEqual(h.components["agent-gateway"].routes, ["/agents/mcp/"]);
  // FeltKit's ComponentContext as the running component sees it: no db, no FeltDB handle.
  assert.equal(h.components["agent-gateway"].checks.context.detail, "component context offers: application,call,credential,derive,environment,log,model,name,work");
});

test("3. a person authenticates through FeltKit", async () => {
  person = await signUp(app);
  assert.match(person.principalId, /^acct_/);
});

async function scenario(driver: Driver) {
  const p = driver.name === "typescript" ? "ts" : "py";
  const t: Array<Record<string, unknown>> = [];
  const A: AgentCredential = await authority.addAgent(`agent:d7-${p}-a`, NOTES_CAPABILITIES);
  const asA = { authorization: `Bearer ${A.secret}`, "x-boundry-on-behalf-of": ADA };
  const delegation = await authority.delegate(ADA, A.principal, NOTES_CAPABILITIES);

  // 4. A person creates a note through FeltKit's mutation endpoint.
  const created = await human(app, person.token, "mutation", "notes:create", { text: `note for ${p}` });
  assert.equal(created.ok, true, JSON.stringify(created.error));
  const id = created.value as string;
  noteIds.push(id);

  // 5. Agent A reads it through MCP.
  let r = call(await driver.call(app.mcpUrl, "notes_get", { id }, asA));
  assert.equal(r.is_error, false);
  assert.equal(r.structured?.note.text, `note for ${p}`);
  assert.equal(r.structured?.note.__version, 1);
  assert.equal(r.structured?.note.actor, person.principalId);
  t.push({ step: 5, is_error: r.is_error, version: r.structured?.note.__version });

  // 8 (opened before the change). The person's live-query stream.
  const live = changeStream(app, person.token);
  await live.opened;

  // 6. Agent A updates it through MCP, at the version it read.
  r = call(await driver.call(app.mcpUrl, "notes_update", { id, text: `updated by ${A.principal}`, expected_version: 1 }, asA));
  assert.equal(r.is_error, false, String(r.code));
  assert.deepEqual(r.structured, { id, version: 2 });
  t.push({ step: 6, is_error: r.is_error, version: r.structured?.version });

  // 7. The person reads the update through FeltKit's query endpoint.
  const read = await human(app, person.token, "query", "notes:get", { id });
  assert.equal(read.ok, true);
  assert.equal(read.value.text, `updated by ${A.principal}`);
  assert.equal(read.value.__version, 2);

  // 8. The person's live query was told the notes collection changed.
  assert.equal(await live.waitFor("notes"), true, "the live-query stream must announce the agent's change");
  live.close();
  t.push({ step: 8, live_change: true });

  // 9. Provenance: three identities, never collapsed.
  assert.equal(read.value.actor, A.principal, "application actor = the agent, as asserted by the component");
  assert.equal(read.value.actorBasis, "component_asserted_after_authboundry");
  assert.equal(read.value.feltkitPrincipal, GATEWAY, "FeltKit principal = the component, from ctx.auth");
  assert.match(String(read.value.authorityDecisionId), /decision/);
  const all = await evidenceFor(app, person.token);
  const outcome = all.find((x) => x.phase === "outcome" && x.tool === "notes_update" && x.record?.authority?.decision_id === read.value.authorityDecisionId);
  assert.ok(outcome, "the update's outcome evidence exists, committed with the change");
  assert.equal(outcome.feltkitPrincipal, GATEWAY);
  assert.equal(outcome.record.caller.authenticated_principal_id, A.principal, "AuthBoundry principal (credential possession)");
  assert.equal(outcome.record.caller.authentication, "authboundry_agent_credential");
  assert.deepEqual(outcome.record.application_actor, { id: A.principal, basis: "component_asserted_after_authboundry" });
  assert.equal(outcome.record.result.status, "completed");
  assert.equal(outcome.record.result.reference, `note:${id}@2`);
  const authorized = all.find((x) => x.phase === "authorized" && x.correlationId === outcome.correlationId);
  assert.ok(authorized, "authorization was recorded before execution");
  assert.ok(authorized.recordedAt <= outcome.recordedAt);
  assert.equal(authorized.feltkitPrincipal, GATEWAY);
  t.push({ step: 9, identities: "separate" });

  // 10. notes:create through MCP: AuthBoundry allows (delegated), FeltKit refuses the component's principal.
  const before = await evidenceFor(app, person.token);
  r = call(await driver.call(app.mcpUrl, "notes_create", { text: "agent tries to create" }, asA));
  assert.equal(r.is_error, true);
  assert.equal(r.code, "FORBIDDEN");
  const createOutcome = (await evidenceFor(app, person.token)).find((x) => x.phase === "outcome" && x.tool === "notes_create" && !before.some((b) => b.correlationId === x.correlationId));
  assert.ok(createOutcome);
  assert.equal(createOutcome.record.authority.outcome, "allow", "AuthBoundry allowed it");
  assert.equal(createOutcome.record.result.status, "failed");
  assert.equal(createOutcome.record.result.feltkit_error, "FORBIDDEN", "FeltKit's role ceiling refused it");
  t.push({ step: 10, is_error: r.is_error, code: r.code });

  // 11. Revoking the delegation stops the next call.
  await authority.revokeDelegation(delegation);
  r = call(await driver.call(app.mcpUrl, "notes_get", { id }, asA));
  assert.equal(r.code, "FORBIDDEN");
  const revoked = (await evidenceFor(app, person.token)).find((x) => x.phase === "outcome" && x.tool === "notes_get" && x.record?.result?.status === "refused" && x.record?.caller?.authenticated_principal_id === A.principal);
  assert.ok(revoked);
  assert.equal(revoked.record.authority.outcome, "deny");
  t.push({ step: 11, code: r.code });

  // 12. A restored delegation works again.
  await authority.delegate(ADA, A.principal, NOTES_CAPABILITIES);
  r = call(await driver.call(app.mcpUrl, "notes_update", { id, text: `restored ${A.principal}`, expected_version: 2 }, asA));
  assert.equal(r.is_error, false, String(r.code));
  assert.deepEqual(r.structured, { id, version: 3 });
  t.push({ step: 12, is_error: r.is_error, version: r.structured?.version });

  //    ... and revoking the credential stops it again.
  await authority.revokeCredential(A.id);
  r = call(await driver.call(app.mcpUrl, "notes_get", { id }, asA));
  assert.equal(r.code, "UNAUTHORIZED");
  t.push({ step: "12b", code: r.code });

  transcripts[driver.name] = t;
}

for (const name of ["typescript", "python"] as const) {
  test(`4-12. scenario through the ${name} MCP client`, { timeout: 300_000 }, async () => {
    const driver = startDriver(name);
    try { await scenario(driver); } finally { driver.close(); }
  });
}

test("both MCP clients observe the same behaviour", () => {
  assert.ok(transcripts.typescript && transcripts.python);
  assert.deepEqual(transcripts.python, transcripts.typescript);
});

test("13. after a SIGKILL restart of the FeltKit process, notes and evidence are unchanged", { timeout: 120_000 }, async () => {
  const notesBefore = await Promise.all(noteIds.map((id) => human(app, person.token, "query", "notes:get", { id })));
  const evidenceBefore = await evidenceFor(app, person.token);
  assert.ok(evidenceBefore.length > 10);
  await app.kill("SIGKILL");
  app = await startApp(appEnvironment({ stateDir, authority }));
  const notesAfter = await Promise.all(noteIds.map((id) => human(app, person.token, "query", "notes:get", { id })));
  assert.deepEqual(notesAfter.map((n) => n.value), notesBefore.map((n) => n.value));
  const evidenceAfter = await evidenceFor(app, person.token);
  assert.deepEqual(evidenceAfter, evidenceBefore);
});
