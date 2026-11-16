// Probe: does FeltDB agent state support cross-agent continuation from durable state alone,
// and what does a context bundle expose (i.e. what a "fresh" reviewer would inherit)?
import { createFeltDB, openAgentState } from "@feltdb/core";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const path = mkdtempSync(join(tmpdir(), "felt-"));
const db1 = createFeltDB({ path });
const s1 = await openAgentState(db1.unsafeRaw ? db1.unsafeRaw() : db1);
const { task } = await s1.createTask({ objective: "Design webhook delivery", actor: "agent:claude-code", constraints: ["at-least-once"], pendingWork: ["draft spec"] });
await s1.checkpoint(task.task_id, { actor: "agent:claude-code", summary: "Drafted spec v1", completed: ["draft spec"], pendingWork: ["review"],
  decisions: ["Use outbox for delivery (assumed DB supports CAS)"], evidence: [{ kind: "external", uri: "repo://docs/designs/webhooks.md", digest: "sha256:abc" }] });
await s1.remember({ taskId: task.task_id, kind: "assumption", content: "Consumers dedupe by event id", source: { actor: "agent:claude-code" } });
const h = await s1.createHandoff(task.task_id, { from: "agent:claude-code", to: "agent:codex", note: "please continue", actor: "agent:claude-code" }).catch(e => ({ err: e.code + " " + e.message }));
console.log("handoff:", JSON.stringify(h).slice(0, 300));
if (db1.close) await db1.close();
// "Different process / different agent": reopen from disk only.
const db2 = createFeltDB({ path });
const s2 = await openAgentState(db2.unsafeRaw ? db2.unsafeRaw() : db2);
if (h.handoff_id) {
  const c = await s2.claimHandoff(h.handoff_id, { claimant: "agent:codex" }).catch(e => ({ err: e.code + " " + e.message }));
  console.log("claim:", JSON.stringify(c).slice(0, 200));
  if (c.leaseId) await s2.acceptHandoff(h.handoff_id, { claimant: "agent:codex", leaseId: c.leaseId }).catch(e => console.log("accept err", e.code, e.message));
}
const owner = (await s2.getTask(task.task_id)).task.owner;
const bundle = await s2.resume(task.task_id, { actor: owner, maxBytes: 20000 }).catch(e => ({ err: e.code + " " + e.message }));
console.log("owner after handoff:", owner);
console.log("bundle keys:", Object.keys(bundle));
console.log("bundle:", JSON.stringify(bundle, null, 1).slice(0, 1800));
