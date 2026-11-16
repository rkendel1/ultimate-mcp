// D7(a) fail-closed evidence (§6), against the real FeltKit process.
//
// Faults are injected server-side only: the proof application reads D7_PROOF_FAULT from its own environment and
// fails the named evidence mutation (or the atomic update after staging its writes), so each failure travels
// FeltKit's real mutation path. No client can trigger them. Recovery is NOT tested: an authorized record left
// without an outcome stays that way (known gap, carried from M0.1, now narrower for state-only writes).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalAuthority, type LocalAuthority, type AgentCredential } from "../../test/support/authboundry.ts";
import { addNotesContract, NOTES_CAPABILITIES, appEnvironment, startApp, signUp, human, rawToolCall, evidenceFor, type FeltKitApp } from "./support.ts";

const ADA = "user:ada";
let authority: LocalAuthority;
let app: FeltKitApp | null = null;
let person: { token: string; principalId: string };
let A: AgentCredential;
let B: AgentCredential;
let asA: Record<string, string>;
let noteId = "";
const stateDir = mkdtempSync(join(tmpdir(), "d7-failclosed-"));

async function restart(fault?: string) {
  await app?.kill("SIGTERM");
  app = await startApp(appEnvironment({ stateDir, authority, ...(fault ? { fault } : {}) }));
  return app;
}

before(async () => {
  authority = await startLocalAuthority();
  await addNotesContract(authority);
  await authority.addPerson(ADA, NOTES_CAPABILITIES);
  A = await authority.addAgent("agent:d7-fault-a", NOTES_CAPABILITIES);
  B = await authority.addAgent("agent:d7-fault-b", NOTES_CAPABILITIES); // never delegated
  await authority.delegate(ADA, A.principal, NOTES_CAPABILITIES);
  asA = { authorization: `Bearer ${A.secret}`, "x-boundry-on-behalf-of": ADA };
  await restart();
  person = await signUp(app!);
  noteId = (await human(app!, person.token, "mutation", "notes:create", { text: "original" })).value as string;
});
after(async () => { await app?.kill("SIGKILL"); authority?.cleanup(); });

const note = async () => (await human(app!, person.token, "query", "notes:get", { id: noteId })).value;
const count = async () => (await evidenceFor(app!, person.token)).length;

test("authorization cannot be recorded → the update does not execute (503 EVIDENCE_UNAVAILABLE)", { timeout: 120_000 }, async () => {
  await restart("authorized-evidence");
  const before = { note: await note(), evidence: await count() };
  const r = await rawToolCall(app!, "notes_update", { id: noteId, text: "must not land", expected_version: before.note.__version }, asA);
  assert.equal(r.status, 503);
  assert.match(String(r.body.error?.message), /^EVIDENCE_UNAVAILABLE/);
  assert.equal(r.body.result, undefined);
  assert.deepEqual(await note(), before.note, "nothing executed");
  assert.equal(await count(), before.evidence, "nothing recorded (the authorized record failed and nothing ran)");
});

test("an outcome cannot be recorded → the result is withheld (503); the authorized record stands alone", { timeout: 120_000 }, async () => {
  await restart("outcome-evidence");
  const r = await rawToolCall(app!, "notes_get", { id: noteId }, asA);
  assert.equal(r.status, 503);
  assert.equal(r.body.result, undefined, "no result without its outcome on record");
  const records = await evidenceFor(app!, person.token);
  const orphan = records.find((x) => x.phase === "authorized" && x.tool === "notes_get" && !records.some((y) => y.phase === "outcome" && y.correlationId === x.correlationId));
  assert.ok(orphan, "the authorized record exists and has no outcome (no reconciliation exists: known gap)");
});

test("a refusal cannot be recorded → 503, never a silent refusal", { timeout: 120_000 }, async () => {
  // Still running with outcome-evidence failing. Agent B has no delegation: AuthBoundry denies.
  const r = await rawToolCall(app!, "notes_get", { id: noteId }, { authorization: `Bearer ${B.secret}`, "x-boundry-on-behalf-of": ADA });
  assert.equal(r.status, 503);
  assert.match(String(r.body.error?.message), /^EVIDENCE_UNAVAILABLE/);
  // And a missing credential, refused without asking anyone, also cannot be answered without its record.
  const none = await rawToolCall(app!, "notes_get", { id: noteId }, {});
  assert.equal(none.status, 503);
});

test("state and outcome commit atomically: a failure after both are staged leaves neither", { timeout: 120_000 }, async () => {
  await restart("atomic-update");
  const before = await note();
  const recordsBefore = await evidenceFor(app!, person.token);
  const r = await rawToolCall(app!, "notes_update", { id: noteId, text: "staged then failed", expected_version: before.__version }, asA);
  assert.equal(r.status, 200);
  assert.equal(r.body.result?.isError, true);
  assert.deepEqual(await note(), before, "the note change was not committed");
  const seen = new Set(recordsBefore.map((y) => `${y.correlationId}/${y.phase}`));
  const fresh = (await evidenceFor(app!, person.token)).filter((x) => !seen.has(`${x.correlationId}/${x.phase}`));
  const authorized = fresh.find((x) => x.phase === "authorized" && x.tool === "notes_update");
  assert.ok(authorized);
  const outcomes = fresh.filter((x) => x.phase === "outcome" && x.correlationId === authorized.correlationId);
  assert.equal(outcomes.length, 1, "exactly one outcome: the failure, recorded separately");
  assert.equal(outcomes[0]!.record.result.status, "failed", "the staged 'completed' outcome did not survive the aborted transaction");
  assert.equal(outcomes[0]!.record.result.feltkit_error, "UNAVAILABLE");
});

test("AuthBoundry unavailable → refused and recorded, with no invented decision id", { timeout: 120_000 }, async () => {
  await restart();
  authority.stop();
  try {
    const r = await rawToolCall(app!, "notes_get", { id: noteId }, asA);
    assert.equal(r.status, 200);
    assert.equal(r.body.result?._meta?.["dev.appport/error"]?.code, "AUTHORITY_UNAVAILABLE");
  } finally {
    await authority.start();
  }
  const latest = (await evidenceFor(app!, person.token)).find((x) => x.phase === "outcome" && x.record?.authority?.outcome === "unavailable");
  assert.ok(latest);
  assert.equal(latest.record.authority.decision_id, null);
  assert.equal(latest.record.result.status, "refused");
});

test("with faults cleared, the same update succeeds and commits note and outcome together", { timeout: 120_000 }, async () => {
  const before = await note();
  const r = await rawToolCall(app!, "notes_update", { id: noteId, text: "finally", expected_version: before.__version }, asA);
  assert.deepEqual(r.body.result?.structuredContent, { id: noteId, version: before.__version + 1 });
  const after = await note();
  const outcome = (await evidenceFor(app!, person.token)).find((x) => x.phase === "outcome" && x.record?.result?.reference === `note:${noteId}@${after.__version}`);
  assert.ok(outcome, "the outcome references exactly the committed version");
  assert.equal(outcome.record.authority.decision_id, after.authorityDecisionId);
});
