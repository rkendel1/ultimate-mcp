// Probe: can FeltDB's architecture-invariant service hold a versioned constraint baseline and
// advisory PASS / DRIFT / UNKNOWN evaluations, with history preserved when the declaration changes?
// Run from the repository root after `npm install`: node probes/feltdb-invariants.ts
import { createFeltDB, createArchitectureInvariantService } from "@feltdb/core";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";

const db = createFeltDB({ path: mkdtempSync(join(tmpdir(), "felt-inv-")) });
const svc = createArchitectureInvariantService(db as never, {
  scope: { tenantId: "t1", applicationId: "build-demo" }, actor: { kind: "human", id: "user:ada" }, source: "probe",
});
const inv = await svc.invariants.create({ id: "no-plaintext-secrets", name: "No plaintext secrets",
  description: "Credentials are never written to logs or records.", category: "constraint", severity: "high", scope: "application",
  verification: [{ method: "automated-test", reference: "test:secrets-scan" }, { method: "human-review" }], references: [] });
console.log("created", inv.id, "v" + inv.version, inv.status, "digest", inv.declaration_digest.slice(0, 16));
const e1 = await svc.evaluations.record({ invariantId: inv.id, invariantVersion: 1, evaluator: "agent:a", result: "DRIFT",
  explanation: "logger prints Authorization header", evidence: ["file:src/log.ts#L12"] });
console.log("evaluation", e1.result, "by", e1.evaluator);
const upd = await svc.invariants.update(inv.id, { description: "Credentials are never written to logs, records or tool output." });
console.log("updated to v" + upd.version);
const v1 = await svc.invariants.version(inv.id, 1);
console.log("v1 still readable:", JSON.stringify(v1.description));
const e2 = await svc.evaluations.record({ invariantId: inv.id, invariantVersion: 2, evaluator: "agent:b", result: "UNKNOWN", explanation: "no scan run yet" });
const evals = await svc.evaluations.list({ invariantId: inv.id });
console.log("evaluations:", evals.evaluations?.map((e: any) => `v${e.invariant_version}:${e.result}`) ?? Object.keys(evals));
try { await svc.evaluations.record({ invariantId: inv.id, invariantVersion: 1, evaluator: "x", result: "MAYBE" as never, explanation: "bad" }); console.log("BAD RESULT ACCEPTED"); }
catch (e: any) { console.log("invalid result refused:", e.code ?? e.message); }
await db.close();
