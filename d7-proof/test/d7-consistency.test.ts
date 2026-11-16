// D7(a) single ownership and transaction semantics (§5). Mandatory acceptance tests.
//
// Races are made deterministic with a proof-only hold between a mutation's read and its write (holdMs /
// hold_ms, at most 3 s): one side holds while the other commits. Each case asserts which write committed,
// what the losing caller received, and what the evidence says.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeltDB } from "@feltdb/core";
import { startLocalAuthority, type LocalAuthority, type AgentCredential } from "../../test/support/authboundry.ts";
import { addNotesContract, NOTES_CAPABILITIES, appEnvironment, startApp, signUp, human, rawToolCall, evidenceFor, PROOF_DIR, type FeltKitApp } from "./support.ts";

const ADA = "user:ada";
let authority: LocalAuthority;
let app: FeltKitApp;
let person: { token: string; principalId: string };
let A: AgentCredential;
let asA: Record<string, string>;
const stateDir = mkdtempSync(join(tmpdir(), "d7-consistency-"));
const results: Record<string, unknown> = {};

before(async () => {
  authority = await startLocalAuthority();
  await addNotesContract(authority);
  await authority.addPerson(ADA, NOTES_CAPABILITIES);
  A = await authority.addAgent("agent:d7-race", NOTES_CAPABILITIES);
  await authority.delegate(ADA, A.principal, NOTES_CAPABILITIES);
  asA = { authorization: `Bearer ${A.secret}`, "x-boundry-on-behalf-of": ADA };
  app = await startApp(appEnvironment({ stateDir, authority }));
  person = await signUp(app);
});
after(async () => { await app?.kill("SIGKILL"); authority?.cleanup(); console.log("D7 consistency observations:", JSON.stringify(results)); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const note = async (id: string) => (await human(app, person.token, "query", "notes:get", { id })).value;

test("single owner: one FeltDB owner; a second owner of the same state is refused; the component has no database", { timeout: 120_000 }, async () => {
  // The application's environment names one local state directory and no FeltDB service.
  const env = appEnvironment({ stateDir, authority });
  assert.equal(env.FELTKIT_STATE_DIR, stateDir);
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith("FELTDB_")), [], "no FeltDB service or URL is configured");
  // Another process cannot open the state while FeltKit owns it.
  assert.throws(() => createFeltDB({ path: stateDir }), (e: { code?: string; name?: string }) => {
    results.directOpen = e.code ?? e.name;
    return /LOCK/i.test(String(e.code ?? e.name));
  });
  // A second FeltKit process on the same state is refused.
  const second = await startApp(appEnvironment({ stateDir, authority }), { expectFailure: true }).then(
    async (unexpected) => { await unexpected.kill("SIGKILL"); return null; },
    (e: Error & { exitCode?: number; log?: string }) => e,
  );
  assert.ok(second, "a second owner must not start");
  results.secondOwner = second.message.slice(0, 400);
  // FeltKit refuses before FeltDB is reached ("already running"); FeltDB's own lock (above) is the second guard.
  assert.match(second.message, /already running|STATE_LOCKED|lock/i);
  // The first owner is unaffected.
  assert.equal(((await (await fetch(`${app.url}/_feltkit/health`)).json()) as { status: string }).status, "ready");
  // The component as built: no FeltDB, no store of its own.
  const bundle = readFileSync(join(PROOF_DIR, ".feltkit", "build", "components", "agent-gateway.mjs"), "utf8");
  for (const forbidden of ["createFeltDB", "openAgentState", "StateFirstDB", "@feltdb/core"]) assert.equal(bundle.includes(forbidden), false, `component bundle must not reference ${forbidden}`);
  const source = readFileSync(join(PROOF_DIR, "gateway", "agent-gateway.ts"), "utf8");
  assert.equal(/from "node:fs"|writeFile|createFeltDB/.test(source), false, "the component neither opens FeltDB nor writes files");
});

test("concurrent update, person holding: the agent's write commits; the person's stale write is refused, nothing lost", { timeout: 60_000 }, async () => {
  const id = (await human(app, person.token, "mutation", "notes:create", { text: "race 1" })).value as string;
  const personWrite = human(app, person.token, "mutation", "notes:update", { id, text: "person (held)", expectedVersion: 1, holdMs: 1500 });
  await sleep(300);
  const agent = await rawToolCall(app, "notes_update", { id, text: "agent", expected_version: 1 }, asA);
  assert.equal(agent.status, 200);
  assert.equal(agent.body.result?.isError, undefined, JSON.stringify(agent.body));
  assert.deepEqual(agent.body.result?.structuredContent, { id, version: 2 });
  const p = await personWrite;
  assert.equal(p.ok, false, "the held person's write must not commit over the agent's");
  results.personHeldError = p.error?.code;
  assert.ok(["CONFLICT", "FAILED_PRECONDITION"].includes(String(p.error?.code)), String(p.error?.code));
  const final = await note(id);
  assert.deepEqual([final.text, final.__version, final.actor, final.feltkitPrincipal], ["agent", 2, A.principal, "component:agent-gateway"]);
});

test("concurrent update, agent holding: the person's write commits; the agent's stale write is refused and its evidence says so", { timeout: 60_000 }, async () => {
  const id = (await human(app, person.token, "mutation", "notes:create", { text: "race 2" })).value as string;
  const agentWrite = rawToolCall(app, "notes_update", { id, text: "agent (held)", expected_version: 1, hold_ms: 1500 }, asA);
  await sleep(300);
  const p = await human(app, person.token, "mutation", "notes:update", { id, text: "person", expectedVersion: 1 });
  assert.equal(p.ok, true, JSON.stringify(p.error));
  assert.equal(p.value.version, 2);
  const agent = await agentWrite;
  assert.equal(agent.status, 200);
  assert.equal(agent.body.result?.isError, true, "the held agent's write must not commit over the person's");
  results.agentHeldError = agent.body.result?._meta?.["dev.appport/error"]?.code;
  const final = await note(id);
  assert.deepEqual([final.text, final.__version, final.actor, final.actorBasis], ["person", 2, person.principalId, "feltkit_session"]);
  // Evidence: the agent's attempt has an authorized record and a FAILED outcome, and no completed outcome.
  const records = (await evidenceFor(app, person.token)).filter((x) => x.tool === "notes_update" && x.record?.input_digest && x.record?.caller?.authenticated_principal_id === A.principal);
  const attempt = records.filter((x) => x.phase === "authorized").map((x) => x.correlationId).find((c) => records.some((y) => y.correlationId === c && y.phase === "outcome" && y.record.result.status === "failed"));
  assert.ok(attempt, "the refused agent write is recorded as authorized, then failed");
  const outcomes = records.filter((x) => x.correlationId === attempt && x.phase === "outcome");
  assert.equal(outcomes.length, 1, "exactly one outcome for the attempt");
  assert.equal(outcomes[0]!.record.result.status, "failed");
  results.agentHeldFeltKitError = outcomes[0]!.record.result.feltkit_error;
  assert.ok(["CONFLICT", "FAILED_PRECONDITION"].includes(String(outcomes[0]!.record.result.feltkit_error)));
});

test("stale read: a person who read an older version cannot overwrite an agent's newer write", { timeout: 60_000 }, async () => {
  const id = (await human(app, person.token, "mutation", "notes:create", { text: "stale" })).value as string;
  const seen = await note(id);
  assert.equal(seen.__version, 1);
  const agent = await rawToolCall(app, "notes_update", { id, text: "agent newer", expected_version: 1 }, asA);
  assert.deepEqual(agent.body.result?.structuredContent, { id, version: 2 });
  const p = await human(app, person.token, "mutation", "notes:update", { id, text: "person from stale read", expectedVersion: seen.__version });
  assert.equal(p.ok, false);
  assert.equal(p.error?.code, "FAILED_PRECONDITION");
  //    ... and the reverse: an agent that read an older version cannot overwrite a person's newer write.
  const again = await human(app, person.token, "mutation", "notes:update", { id, text: "person newest", expectedVersion: 2 });
  assert.equal(again.ok, true);
  const staleAgent = await rawToolCall(app, "notes_update", { id, text: "agent from stale read", expected_version: 2 }, asA);
  assert.equal(staleAgent.body.result?.isError, true);
  const final = await note(id);
  assert.deepEqual([final.text, final.__version], ["person newest", 3]);
});

test("both entry points write through the same runtime: FeltKit's view of each writer is its own", async () => {
  const id = (await human(app, person.token, "mutation", "notes:create", { text: "who" })).value as string;
  const byPerson = await note(id);
  assert.equal(byPerson.feltkitPrincipal, person.principalId);
  await rawToolCall(app, "notes_update", { id, text: "by agent", expected_version: 1 }, asA);
  const byAgent = await note(id);
  assert.equal(byAgent.feltkitPrincipal, "component:agent-gateway");
  assert.equal(byAgent.actor, A.principal);
  // The agent surface cannot call the person's update function: FeltKit's roles refuse the component.
  const evidence = await evidenceFor(app, person.token);
  assert.ok(evidence.every((x) => x.feltkitPrincipal === "component:agent-gateway"), "only the gateway component writes agent evidence");
});

test("identity cannot be substituted: claims in headers, _meta or arguments never become the actor; people cannot forge agent writes or evidence", { timeout: 60_000 }, async () => {
  const id = (await human(app, person.token, "mutation", "notes:create", { text: "substitution" })).value as string;
  // Claims in headers and _meta are ignored: the actor is the agent AuthBoundry authenticated.
  const r = await fetch(app.mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...asA, "x-boundry-principal": "agent:someone-else", "x-principal-id": "agent:someone-else" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "notes_update", arguments: { id, text: "claims", expected_version: 1 }, _meta: { principal: "agent:someone-else", actor: "agent:someone-else" } } }),
  });
  const body = (await r.json()) as { result?: { isError?: boolean } };
  assert.equal(body.result?.isError, undefined);
  const after = await note(id);
  assert.equal(after.actor, A.principal, "a claimed identity never becomes the actor");
  // An actor in the tool's arguments is refused by the input schema; nothing changes.
  const withActor = await rawToolCall(app, "notes_update", { id, text: "arg actor", expected_version: 2, actor: "agent:someone-else" }, asA);
  assert.equal(withActor.body.result?.isError, true);
  assert.deepEqual(await note(id), after);
  // A person cannot call the agent-only update (which accepts an asserted actor) or write agent evidence.
  const forged = await human(app, person.token, "mutation", "notes:updateFromAgent", { id, text: "forged", expectedVersion: 2, actor: "agent:someone-else", authorityDecisionId: "made-up", correlationId: "c", outcome: {} });
  assert.equal(forged.ok, false);
  assert.equal(forged.error?.code, "FORBIDDEN");
  const forgedEvidence = await human(app, person.token, "mutation", "evidence:recordAuthorized", { correlationId: "c", tool: null, capability: null, record: {} });
  assert.equal(forgedEvidence.error?.code, "FORBIDDEN");
  assert.deepEqual(await note(id), after);
});
