# Boundry Continuity — Implementation Plan (grounded in the repositories as they exist)

Status: **plan, not implementation.** Nothing described as "to build" below exists yet.

> **Superseded in part (revision 4):** the product definition, milestones and next slice are now in
> [PRODUCT-PLAN.md](PRODUCT-PLAN.md) (interactive, outcome-directed development). This document's reality
> map, decisions D1–D5 and the M0.1 slice (§9) remain valid as the foundation.
Revision 3, 2026-11-16: decisions D1–D5 settled by the owner; evidence moved into M0; scoped review is
the baseline; workspace persistence is a hard M1 gate; next slice defined (§9).

Audit date: 2026-11-16. Commits inspected: appport `35a57ea`, authboundry `0c982e4`, appboundry `9f84020`,
feltkit `b0cfa6a`, appport-services `1295589`, compute `b8607ae`, pax `aab5039`, resolver `89881ef`,
boundry (site) `3a5400d`. FeltDB source (`rkendel1/feltdb`) was **not accessible**; it is consumed here only
as npm `@feltdb/core` (0.21.0 in FeltKit, 0.11.7 in AuthBoundry).

Evidence levels used throughout:
- **Verified** — run during this audit.
- **Tested** — test files exist in the repo covering it; not run here.
- **Code** — implementation exists; test coverage not confirmed.
- **Doc** — design/proposal only; no code.

---

## 1. Product definition

> **Boundry Continuity is a durable, agent-independent system for creating, executing, reviewing and
> verifying work.** Agents are replaceable participants. Work intent, knowledge, decisions, artifacts,
> authority and evidence are durable records owned by the customer. Boundry preserves continuity when
> agents change, and enables independent verification without trusting the originating agent's account
> of its own work.

Boundry is the **authority and evidence system for work**, not the owner of any agent workflow. It
stores records, enforces deterministic rules, assembles context, executes authorized operations and
records what happened. It does not ship an agent framework, prompt engine, workflow engine or
integration catalog.

Contract requirements that apply to every milestone:
- **Client neutrality.** No capability, record or test depends on a particular agent, model, harness or
  stack. Neutrality is claimed only after the same contract passes through **at least two genuinely
  different MCP clients**.
- **Evidence from the start.** No capability ships without a durable allow/deny record (M0). Later
  milestones enrich evidence; none introduces it.
- **Customer ownership.** Records, review methods and evidence are customer-owned and inspectable through
  the same capabilities agents use.
- **No EGM at runtime.** The Elephant–Goldfish Model was a design reference only; nothing from it is a
  dependency, packaged artifact or customer-facing requirement.
- **Boundary separation.** The control plane never runs customer code. Customer execution runs only on
  hosts designated for it.

The implementation is a composition of existing Boundry products: **a FeltKit application** (FeltDB state,
AppPort capabilities, AuthBoundry authority, durable invocations, audit) **+ a `compute` ExecutionAdapter**
(FeltKit's existing extension point) **+ a small, curated capability set**, plus three genuinely new
pieces: verification records, verification context assembly, and the evidence join.

Corrections to the original spec, from the audit:
1. **PAX is not an evidence plane.** It is a project-inspection CLI that "does not produce execution
   receipts" and "does not hold state" (`pax/docs/PAX_BOUNDARY.md:97,106`). It is the result format for
   running tests.
2. **Intent does not exist as code** (`feltkit/docs/M1-AGENT-FOUNDATION-AUDIT.md:111`). Removed.
3. **AppBoundry cannot host a computer.** It runs packaged WASM only. `compute` is the execution plane.
4. **AuthBoundry is not an OAuth authorization server.** M0 uses agent bearer credentials (D2).

See [CONTINUITY-AND-VERIFICATION.md](CONTINUITY-AND-VERIFICATION.md) for the work lifecycle, the two
context operations and review isolation.

---

## 2. Reality map

| Role | Actual owner | What exists | Level | Decision |
|---|---|---|---|---|
| Capability contracts | **AppPort** `@appport/protocol`, `@appport/core` 1.7.1 | Versioned capabilities, JSON-schema I/O, `effect` (observation/consequential), idempotency, timeouts, RFC 8785 digests, pluggable `Authorizer` | Tested | **Reuse as-is.** No new contract format. |
| MCP endpoint | **AppPort** `@appport/mcp` 1.3.8 | Stateless Streamable HTTP handler; 1 tool per capability; host supplies caller; fail-closed when no caller | **Verified** (68/68 tests) | **Reuse.** |
| MCP endpoint (FeltKit) | **FeltKit** `server/mcp.ts` | Hand-rolled JSON-RPC, POST-only; tools filtered per caller; bearer = FeltKit session token or AppPort API key only. Not an AuthBoundry agent credential | Code | M0 slice decides (§9). |
| Authority | **AuthBoundry** | Human/agent/service principals; delegations with resource scope; `POST /_authboundry/authorize/check` reloads state per check, fails closed; agent credentials (`aga_`, 1h TTL, rotation); revocation effective next request | Tested (≈240 server integration tests + conformance) | **Reuse.** |
| Authority ↔ FeltKit | FeltKit `runtime/authboundry.ts`, `application-authority.ts` | Per-call check, fail closed, `decision_id`, executor proof. Forwards an agent credential **FeltKit itself holds** (`local-authority.ts`), never one presented by the client | Tested | Extend: forward the client's credential (W-F2). |
| OAuth 2.1 for MCP clients | — | Nothing; AuthBoundry is an OAuth client of GitHub/Google only | — | M5, in AuthBoundry. |
| Human approval | FeltKit invocations `awaiting_approval` | Consequential proposals wait for a person | Tested | Reuse. |
| Durable state | **FeltDB** `@feltdb/core` | Collections, transactions with `requireAbsent`/`ifVersion`, query, watch | Used everywhere; source not audited | Reuse via FeltKit. |
| Continuity | **FeltDB** agent state | Tasks, immutable checkpoints, scoped memory, leased handoffs, bounded context assembly | **Verified** (cross-process handoff, `probes/`) | Reuse. |
| Jobs | **FeltKit** `runtime/invocations.ts` | Leases, CAS cancel, replay, approval wait, recovery sweep, durable idempotency | Tested | Reuse. AppPort `OperationRunner` and appport-services Jobs rejected (memory-only / no cancel). |
| Execution boundary | **FeltKit** `ExecutionAdapter` | Narrow adapter via the outbox; only `managed` exists | Code | Build `compute` adapter. |
| Computer | **compute** + `@compute/appport` | Sessions (create/exec with `--detach`/`--timeout`/stop/resume/claim/destroy), file read/write/list, environments reconciled as jobs, container provider CI-tested on real Docker, microVM CI-tested on KVM, SHA-256 receipts, ~60 `compute.*` capabilities | Tested | Reuse. |
| Workspace durability | compute | Container workspace = **host directory bind-mounted at `/workspace`** (`containers.rs:24-30,242`), so it should survive container death and stop/resume on the same host, but not host loss. All providers report `persistent_storage:false` = no storage outlives the host. Running computers can be replaced with their workspace exported; a lost/failed/stopped one "has no workspace to preserve" (`docs/computers.md:332-348`) | Code/Doc; **same-host survival not yet tested** | **Hard M1 gate** (§8). |
| Browser | — | Nothing offered to sessions | — | M4. |
| Secrets | appport-services refs + FeltKit custody; Resolver vault | `credential-ref:` only; material released inside authorized effects; compute egress brokers headers | Tested | Reuse; Resolver↔custody is Doc only. |
| Evidence | AuthBoundry decisions; appport-services `EffectEvidence`; FeltKit `_feltkit_audit`; compute receipts | Each records its own slice; nothing joins them. FeltKit records **refused** calls only in the best-effort, pruned `_feltkit_activity` log | Tested | Minimal durable record in **M0**; join in **M3**. |
| Hosting | appboundry `deploy/boundry/compose.yml` (shared Hetzner) | Platform services only. "Customer workloads do NOT run here." Server plan not yet executed | Doc | D1. |

---

## 3. Architecture

```
 Any MCP client (any agent, model or stack)
          │  MCP Streamable HTTP, Authorization: Bearer <AuthBoundry agent credential>
          ▼
 ┌──────────────── Boundry Continuity (this repo): one FeltKit application ────────────────┐
 │ MCP surface ........ curated direct tools, one per capability (D3)                       │
 │ Authority .......... AuthBoundry /authorize/check per call, client credential forwarded  │
 │ Evidence ........... invocation record per call, allow AND deny (M0); joined later (M3)  │
 │ Work + continuity .. FeltDB agent state                                                  │
 │ Verification ....... review runs, findings, resolutions, decisions (M2)                  │
 │ Jobs ............... FeltKit invocations                                                 │
 │ State .............. one FeltDB instance                                                 │
 │ Execution .......... compute ExecutionAdapter ──────────────┐                            │
 └─────────────────────────────────────────────────────────────┼────────────────────────────┘
        control plane: never runs customer code                │
                                                               ▼
                         compute serve on a host designated for customer execution (D1)
```

---

## 4. Decisions (settled 2026-11-16)

| | Decision | Consequence |
|---|---|---|
| **D1** Hosting | No new host now. The shared Boundry host runs platform services only; **no customer workloads on it**. Do not assume a dedicated staging execution host exists. | M0 needs no compute host. M1's persistence proofs run on a non-production machine with Docker (local or CI), as compute's own container-engine CI already does. **No customer-facing release of the computer until an execution host is designated.** |
| **D2** Authentication | Static AuthBoundry agent bearer credentials, **M0 spike only**. | Recorded gaps: no OAuth (M5); 1h TTL with 7-day family renewal must be handled by the client or an operator; manual issuance. |
| **D3** Tool shape | Curated direct capabilities with per-capability authorization. `search`/`describe` added when the catalog needs them. **Generic `invoke` deferred** until its authority and approval semantics are proven. | Client-side per-tool approval stays meaningful. |
| **D4** Host framework | FeltKit, subject to the M0 spike. **Fallback:** host `@appport/mcp` + `@appport/core` with AuthBoundry's `createAuthBoundryAuthorizer` and FeltDB directly in this repo, reusing the same contracts. | §9 states what the spike must show. |
| **D5** Name | **Boundry Continuity.** "Universal" retired as the product name. | Capability names are domain names (`work.*`, `computer.*`), not product names. |

---

## 5. Capability set

Domain-named, curated, direct. Each is a thin AppPort capability over an existing contract.

| Capability | Milestone | Delegates to | Effect |
|---|---|---|---|
| `work.task.create` | M0 | FeltDB `createTask` | consequential |
| `evidence.list` / `evidence.get` | M0 | Invocation evidence records | observation |
| `computer.create / inspect / list / stop / resume / destroy` | M1 | `compute.session.*` via adapter | mixed |
| `terminal.execute` | M1 | `compute session exec [--timeout]` | consequential |
| `files.list / read / write` | M1 | `compute session file *` | mixed |
| `git.status / diff / commit / branch / clone` | M1 | commands in the session | mixed |
| `work.task.* / checkpoint / handoff.* / resume`, `knowledge.*`, `intent.*`, `decision.*` | M2 | FeltDB agent state + new records | mixed |
| `review.*` (assemble, read bundle, submit finding, resolve) | M2 | New verification records | mixed |
| `jobs.get / cancel / result` | M3 | FeltKit invocations + compute `--detach` | mixed |
| `capabilities.search / describe` | when the catalog needs it | AppPort manifest | observation |
| ~~`capabilities.invoke`~~ | deferred (D3) | — | — |

A grant of `terminal.execute` dominates finer grants in the same session: an agent with a shell can do
anything the session can. The authority UI must say so.

---

## 6. Work items by repository

**This repo (`rkendel1/ultimate-mcp`, product: Boundry Continuity)**
- **W-U1** FeltKit app; one FeltDB instance; AuthBoundry application + check credential.
- **W-U2** Capabilities (§5).
- **W-U3** MCP route; client bearer → AuthBoundry principal with executor proof.
- **W-U4a (M0)** Invocation evidence: one append-only record per call (allow, deny, error):
  correlation id, timestamp, caller principal, executor proof (`proven` / `asserted`), credential id
  (never the credential), capability@version, AuthBoundry `decision_id` / outcome / reason, outcome, error
  code. Written for refusals before the response is returned. No arguments or results stored.
- **W-U4b (M3)** Evidence join: compute receipts, artifact and tree digests, nested invocations, test
  results, approvals, cross-system provenance.
- **W-U5** Acceptance suite, including a two-client conformance run.

**FeltKit**
- **W-F1 (M1)** `compute` ExecutionAdapter.
- **W-F2 (M0)** Accept an AuthBoundry agent credential as the MCP bearer and forward it as
  `x-authboundry-agent-credential` so the executor is `proven`.
- **W-F3** Replace hand-rolled `server/mcp.ts` with `@appport/mcp` (optional; removes duplicate protocol code).
- **W-F4 (M0)** Durable refusal records (today refusals reach only the pruned activity log).

**compute**
- **W-C1 (M1)** Publish `@compute/appport` (`private: true` today) or consume from source.
- **W-C2 (before any customer release)** Locked network for container sessions; egress only through `compute-egress`.
- **W-C3 (M1 gate)** Workspace persistence proofs (§8 M1).
- **W-C4 (M1/M4)** Session image: git, ripgrep, node, python, pax; Playwright later.

**AuthBoundry**
- **W-A1 (M0)** Grants as capability strings + resource scope (`{type:"environment", id}`). Confirm
  `ResourceScope.is_subset_of` covers it.
- **W-A2 (M5)** Batch eligibility read for per-caller tool lists (proposal today).
- **W-A3 (M5)** OAuth 2.1 authorization server for MCP.

**AppPort**
- **W-P1** `capabilityDigest` in projected tool `_meta`.

---

## 7. Milestones

Order changed by the review: authority and evidence first, then the hardest unresolved technical risk
(persistent execution state), then the work lifecycle. Console polish and integrations come last.

| | Milestone | Depends on |
|---|---|---|
| **M0** | Authority and evidence | AuthBoundry (local), FeltDB, FeltKit. **No compute host.** |
| **M1** | Persistent computer | M0; Docker on a non-production machine (D1) |
| **M2** | Durable work and independent review | M0 (M1 for AT-1's workspace step) |
| **M3** | Execution evidence and durable jobs | M1 |
| **M4** | Browser and selected integrations | M2 |
| **M5** | Onboarding and broader client support | M0–M2 |

---

## 8. Exit criteria

Every exit test runs through MCP only, automated, and against the client set named in the milestone.

**M0 — Authority and evidence** (clients: two independent MCP client implementations, e.g. the official
TypeScript SDK client and the official Python SDK client)
1. A client with a granted agent credential calls `work.task.create`; the task exists in FeltDB with that
   principal as actor; an `allow` evidence record exists with AuthBoundry's `decision_id` and executor `proven`.
2. The same call without the grant is refused; a `deny` record exists with AuthBoundry's reason.
3. No or invalid bearer → refused; a record exists with caller unknown.
4. Revoking the agent credential → the **next** call is refused and recorded.
5. Revoking the delegation → the next call is refused and recorded.
6. AuthBoundry unreachable → refused (fail closed), recorded with outcome `authority_unavailable`.
7. Evidence is append-only: no capability updates or deletes a record; a direct second write of the same id
   is refused by FeltDB (`requireAbsent`).
8. Process restart → all records still readable through `evidence.list`.
9. Steps 1–8 pass identically through both clients.

**M1 — Persistent computer** (hard gate: **no workspace-continuity claim before items 3–7 pass**)
1. `computer.create`, `files.write`, `terminal.execute`, `git.commit` work through MCP.
2. A test suite runs in the session; its `pax.execution-result.v1` is returned.
3. Files and git state survive `computer.stop` → `computer.resume`; tree digest (files + `.git`) equal before and after.
4. The container process is killed externally; the workspace is recovered; tree digest equal.
5. The compute serve process is killed and restarted; the computer is reachable again; tree digest equal.
6. The client disconnects; a **different** client and principal reconnect and find the same tree digest.
7. Host or storage loss is simulated (workspace directory removed); the product reports the computer as
   `lost` and makes **no** claim that the workspace survived. Documented guarantee: same-host durability only.
8. Two sessions cannot read each other's workspace.

**M2 — Durable work and independent review**: AT-1 and AT-2 (scoped) in CONTINUITY-AND-VERIFICATION.md
§8, run with at least two distinct agent clients. AT-2C (constructed) is optional for M2.

**M3 — Execution evidence and durable jobs**
1. A detached command continues after client disconnect; its result is retrievable later.
2. `jobs.cancel` stops the process, verified by process absence, not status.
3. Crash mid-job → recovery without duplicate side effects (`IDEMPOTENCY_OUTCOME_UNKNOWN` semantics).
4. Each invocation's evidence joins its AuthBoundry decision, compute receipt, artifact digests and test results.

**M4 — Browser and selected integrations**
1. A session browser completes a task in an authorized test app and returns a screenshot artifact.
2. Injected credentials never appear in any tool result or evidence record (scanned by test).

**M5 — Onboarding and broader client support**
1. OAuth sign-in from at least one client that cannot use static headers.
2. Per-caller tool lists; approval for designated operations; administration without internal APIs.
3. Client conformance suite published and passing for every supported client.

---

## 9. Smallest next implementation slice: M0.1

**Goal:** prove the trust boundary (identity → authority → execution → durable evidence) with one real
capability, two MCP clients and no compute host. Nothing else.

**In scope**
- FeltKit application in this repo; local FeltDB file store.
- AuthBoundry run locally from its own `compose.yaml` (no shared host, no hosted tenant).
- One consequential capability, `work.task.create` (useful later: it is the first step of AT-1), and the
  read capabilities `evidence.list` / `evidence.get`.
- Client agent credential accepted as bearer and forwarded to AuthBoundry (W-F2).
- Invocation evidence for allow, deny and error (W-U4a, W-F4).
- M0 exit tests 1–9, automated, with the TypeScript and Python MCP SDK clients.

**Out of scope:** compute, browser, review records, jobs, OAuth, console, search/describe, any deployment.

**Spike questions the slice must answer (D4)**
1. Can FeltKit's MCP path accept a client-presented AuthBoundry agent credential and get executor `proven`
   with a change confined to W-F2? If it needs broader FeltKit surgery → take the documented fallback
   (`@appport/mcp` + AuthBoundry authorizer + FeltDB in this repo).
2. Can a refusal be recorded durably **before** the response returns, inside FeltKit's pipeline?
3. Does AuthBoundry's local compose stack issue an agent credential and delegation that the check endpoint
   honors end to end?

**Changes outside this repo:** W-F2 and W-F4 are FeltKit changes (a branch and PR on `rkendel1/feltkit`,
with its owner's approval). No changes to AuthBoundry, AppPort or compute in this slice.

**Done means:** the M0 exit tests pass in CI for both clients, and a short report in `docs/` states what
was proven, what failed, and which D4 path was taken.

---

## 10. Unknowns and risks

- **Persistent execution state is the largest unresolved technical risk.** Same-host survival is
  plausible from the code and untested; cross-host survival does not exist.
- **No execution host is designated** (D1). M1 can be proven, but not offered to customers.
- **FeltDB** source and hosted status not audited.
- **Nothing is verified operationally**; the shared server plan is unexecuted.
- **FeltKit is preview (0.3.30)**; M0.1 is the spike.
- **Agent credential TTL (1h)** vs long sessions; renewal must be handled outside the MCP client today.
- **Container egress** is not enforced without W-C2; microVMs need KVM hardware.
- **Shell grants dominate finer grants** (§5).
- MCP protocol evolution: pin the SDK version and run conformance per supported revision.
