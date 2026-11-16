# Boundry Universal — Implementation Plan (grounded in the repositories as they exist)

Status: **plan, not implementation.** Nothing described as "to build" below exists yet.
Audit date: 2026-11-16. Commits inspected: appport `35a57ea`, authboundry `0c982e4`, appboundry `9f84020`,
feltkit `b0cfa6a`, appport-services `1295589`, compute `b8607ae`, pax `aab5039`, resolver `89881ef`,
boundry (site) `3a5400d`. FeltDB source (`rkendel1/feltdb`) was **not accessible**; it is consumed here only
as npm `@feltdb/core` (0.21.0 in FeltKit, 0.11.7 in AuthBoundry).

Evidence levels used throughout:
- **Verified** — I built/ran it in this audit.
- **Tested** — test files exist in the repo covering it; not run by me.
- **Code** — implementation exists; test coverage not confirmed.
- **Doc** — design/proposal only; no code.

---

## 1. Bottom line

The spec's thesis holds up against the code, but its component map does not. Most of Universal already
exists as separate, contract-shaped pieces. **Universal is a composition problem, not a platform build.**

The smallest coherent architecture is:

> **Boundry Universal = a FeltKit application** (FeltDB state, AppPort capabilities, AuthBoundry authority,
> durable invocations, audit, MCP surface — all already integrated) **+ a new `compute` ExecutionAdapter**
> (FeltKit's existing extension point) **+ a small `universal.*` capability set.**

Three things in the spec are wrong about the platform and must change before building:

1. **PAX is not an evidence plane.** It is a project-inspection CLI. Its own boundary doc says it does not
   "produce execution receipts" and "does not hold state" (`pax/docs/PAX_BOUNDARY.md:97,106`).
2. **Intent does not exist as code.** FeltKit's own audit says so (`feltkit/docs/M1-AGENT-FOUNDATION-AUDIT.md:111`).
3. **AppBoundry cannot host a Universal Computer.** It runs packaged WASM artifacts with no shell,
   processes, or filesystem (`appboundry/docs/architecture/execution-model.md`). **`compute` is the
   execution plane.**

And one hard gap the spec under-weights: **AuthBoundry is not an OAuth authorization server.** No
authorize/token endpoint, PKCE, dynamic client registration, or protected-resource metadata exists. This
decides how M0 authenticates (see D2).

**Client neutrality.** No capability, record or test may depend on a particular agent, model, harness or stack. Every exit test runs against each supported client; Claude Code is only the first one verified, because it accepts static bearer headers today (D2).

**Revision 2026-11-16 — continuity and independent verification.** The product also covers the
durable lifecycle of work: Intent, Knowledge, Decisions, Work and Verification, with continuity
(handoff) and independent review as distinct context operations. Continuity already exists in
FeltDB agent state (verified); independent verification does not exist anywhere and is new work.
See [CONTINUITY-AND-VERIFICATION.md](CONTINUITY-AND-VERIFICATION.md).

---

## 2. Reality map

| Spec role | Actual owner | What exists | Level | Decision |
|---|---|---|---|---|
| Capability contracts | **AppPort** `@appport/protocol`, `@appport/core` 1.7.1 | Versioned capabilities, JSON-schema I/O, `effect` (observation/consequential), idempotency, timeouts, RFC 8785 digests, pluggable `Authorizer` | Tested | **Reuse as-is.** Universal defines no contract format. |
| MCP gateway | **AppPort** `@appport/mcp` 1.3.8 | Stateless Streamable HTTP handler; 1 tool per capability; host supplies caller; fail-closed when no caller; idempotency/timeout via `_meta` | **Verified** (built; 68/68 tests pass) | **Reuse.** No new MCP server code. |
| MCP gateway (alt) | **FeltKit** `packages/sdk/src/server/mcp.ts` | Hand-rolled JSON-RPC, POST-only; tools filtered by `authority.mayInvoke`; bearer = FeltKit session or AppPort API key | Code | Consolidate onto `@appport/mcp` (see W-F3). |
| Authority | **AuthBoundry** (Rust; hosted `api.authboundry.com`) | Human/agent/service principals; delegations with resource scope, chains, expiry; `POST /_authboundry/authorize/check` reloads state per check, fails closed; agent credentials (`aga_`, 1h TTL, rotation, theft-revokes-family); revocation effective next request | Tested (≈240 server integration tests + conformance suite) | **Reuse.** Gateway acts as the application's enforcement point. |
| Authority ↔ AppPort | AuthBoundry `createAuthBoundryAuthorizer`; FeltKit `runtime/authboundry.ts` | Both call `/authorize/check` per invocation, fail closed, return `decision_id` | Tested | **Reuse FeltKit's path.** |
| OAuth 2.1 for MCP clients | — | **Nothing.** AuthBoundry is an OAuth *client* of GitHub/Google only | — | **Gap → D2.** Belongs in AuthBoundry, not Universal. |
| Per-operation human approval | FeltKit invocations `awaiting_approval` + Studio approval | Consequential agent proposals wait for human approval | Code/Tested | Reuse. AuthBoundry has none at invocation time. |
| Durable state | **FeltDB** `@feltdb/core` | collections, `transaction` with `requireAbsent`/`ifVersion`, `updateIfVersion`, query, watch | Used by every repo; source not audited | Reuse via FeltKit. |
| Jobs / long-running work | **FeltKit** `runtime/invocations.ts` | accept → running (lease, claim token) → awaiting_approval / completed / failed / cancelled; replay on duplicate accept; CAS cancel; recovery sweep; durable idempotency (`IDEMPOTENCY_OUTCOME_UNKNOWN` instead of blind re-run); outbox | Tested | **Reuse — this is the job system.** |
| Jobs (alternatives rejected) | AppPort `OperationRunner`; appport-services Jobs | OperationRunner: memory store, no owner/tenant. Services Jobs: no cancel, no result, no enqueue idempotency, takeover may duplicate side effects | Tested | **Do not use** for Universal jobs. |
| Execution boundary | **FeltKit** `runtime/execution-host.ts` `ExecutionAdapter` | Narrow adapter: environment descriptor + `dispatch` via the outbox; control plane owns attempts, leases, fencing, evidence. Only `managed` adapter exists; others "register the same interface; none is built here" | Code | **Build the `compute` adapter here.** |
| Universal Computer | **compute** (Rust) + `@compute/appport` | Sessions: create/exec(`--detach`,`--timeout`)/input/stop/resume/claim/destroy/fork, logs/events, file read/write/list; durable environments (repos, packages, processes) reconciled as jobs; container provider (docker/podman, caps dropped, cpu/mem/pids limits) CI-tested on real Docker; Firecracker microVM (terminal, suspend, vsock-only egress) CI-tested on KVM; SHA-256 receipts, optionally signed; ~60 `compute.*` AppPort capabilities | Tested | **Reuse as execution plane.** |
| Computer gaps | compute | Interactive PTY only on microVM; egress enforced only on microVM; `persistent_storage:false` on all providers; credential custody "not production-grade"; daemon (`compute start`) does not host sessions — `compute serve` targets do; `@compute/appport` is `private: true` | Code/Doc | See W-C*. |
| Browser | — | **Nothing usable.** `browser-agent-runtime` is a WebLLM research repo; compute uses Playwright only to test its own UI | — | **Build** as a session image + capabilities (W-B1). |
| Secrets | appport-services protocols + FeltKit custody; Resolver vault | `credential-ref:` only in records; material released only inside an authorized effect (`gateway.withSecret`); Resolver AES-256-GCM vault with audited reveal; compute egress can broker credential headers | Tested | Reuse refs + effect-scoped release. Resolver↔custody integration is **Doc only** (`resolver/docs/appport-services-integration.md:15`). |
| Evidence | Distributed: AuthBoundry decision evidence; appport-services `EffectEvidence`; FeltKit `_feltkit_audit`; compute receipts; AppPort nested-invocation evidence | Each records its own slice; none joins them; none signed except optional compute receipts; FeltKit audit explicitly "not tamper-evident against whoever operates the FeltDB instance" | Tested | **Build the join** (W-U4), owned by Universal in FeltDB. |
| PAX | **pax** CLI | `pax test/build/... --json` → `pax.execution-result.v1` (status, exit code, test counts); project observations | Code | Use as the **`development.run` result format**, not as evidence. |
| Resolver | **resolver** | `ref://` model/secret/endpoint/agent/value, revisioned, audited | Tested; deployment unverified | Not needed for M0–M2. Later: credential binding. |
| Intent | — | No code | — | **Remove from plan.** |
| n8n | — | — | — | M6, optional, licensing review first. |
| Hosting | appboundry `deploy/boundry/compose.yml` (shared Hetzner) | FeltDB control/managed, intent, portal, authboundry. Header: **"Customer workloads do NOT run here."** `SERVER-PLAN.md:3`: **"Nothing here has been run on the server."** | Doc | **Conflict → D1.** |

---

## 3. Architecture after the audit

```
 Claude Code / ChatGPT / Codex
          │  MCP Streamable HTTP (POST)
          ▼
 ┌─────────────────────────── boundry-universal (this repo) ───────────────────────────┐
 │ FeltKit application                                                                 │
 │   MCP surface ........ @appport/mcp createMcpHandler (projection of the manifest)   │
 │   Caller ............. bearer → AuthBoundry principal (agent credential, D2)        │
 │   Authority .......... FeltKit runtime/authboundry.ts → /_authboundry/authorize/check│
 │   Capabilities ....... universal.*  (curated, see §5)                               │
 │   Jobs ............... FeltKit invocations (durable, cancel, approval, recovery)     │
 │   Evidence join ...... universal_evidence collection (W-U4)                          │
 │   Execution .......... ExecutionAdapter "compute"  ──────────────┐                   │
 │   State .............. FeltDB (one instance)                     │                   │
 └──────────────────────────────────────────────────────────────────┼───────────────────┘
                                                                    ▼
                                        compute serve  (container provider; microVM where KVM)
                                        sessions · environments · files · receipts · egress gateway
```

The four planes in the spec map onto existing owners as follows: **Interface** = `@appport/mcp`;
**Control** = FeltKit + AuthBoundry + FeltDB; **Execution** = compute; **Evidence** = a Universal-owned
join over records the other systems already write. No new registry, auth system, job system, or MCP
server is introduced.

---

## 4. Decisions needed before code

**D1 — Where do Universal Computers run?**
The spec says "shared Hetzner, no new infrastructure." The shared host's compose file says customer
workloads do not run there, and its server plan has not been executed. A Universal Computer *is* a
customer workload (arbitrary code, network). Options:
- (a) Control plane on the shared host; `compute serve` on the existing dedicated staging execution host
  (`appboundry/deploy/staging-host`). **Recommended** — if that host exists; I could not verify it.
- (b) Run `compute serve` on the shared host. Violates its own stated boundary. Not recommended.
- (c) New host with KVM for microVM isolation. Needed eventually for enforced egress and PTY.

**D2 — How does an MCP client authenticate in M0?**
- (a) **Recommended for M0:** an AuthBoundry agent credential (`aga_…`) sent as a static
  `Authorization: Bearer` header. Claude Code supports static headers for HTTP MCP servers. This is real,
  per-agent, short-lived, rotatable and revocable today. Cost: manual credential issuance; ~1h TTL means
  rotation friction for long sessions (needs verifying against the 7-day family renewal).
- (b) Build an OAuth 2.1 authorization server (PKCE, RFC 9728 protected-resource metadata, RFC 7591
  DCR, RFC 8707 audience) **in AuthBoundry**. Required for ChatGPT and for self-service onboarding. Real
  work; schedule as M5. Do not put it in Universal — that would duplicate the authority boundary.

**D3 — Tool shape exposed over MCP.**
`@appport/mcp` projects one tool per capability. The spec wants meta-tools. Recommendation: **both,
from the same manifest** — a curated direct set (~15 P0 tools, below) so clients' per-tool approval
UX works, plus `universal.capabilities.search/describe/invoke` as AppPort capabilities for the long tail.
`invoke` dispatches through `context.invoke`, which is exactly the path for which AppPort already emits
invocation evidence (`appport/packages/core/src/invocation.ts`). Risk to accept knowingly: a generic
`invoke` tool weakens client-side per-tool approval; mitigate by requiring server-side approval for
consequential capabilities reached through it.

**D4 — Build on FeltKit (preview, 0.3.30) or directly on AppPort server?**
Recommended: FeltKit, because it already integrates AuthBoundry, FeltDB, durable invocations, audit,
approval and the execution adapter boundary — rebuilding those is the duplication the spec forbids.
Verify with the M0 spike; if FeltKit blocks, fall back to `@appport/server` + the same packages.

---

## 5. Initial `universal.*` capability set (P0)

Each is a thin AppPort capability delegating to an existing contract. Names are proposals.

| Capability | Delegates to | Effect |
|---|---|---|
| `universal.computer.create / inspect / list / stop / resume / destroy` | `compute.session.*` (via adapter) | consequential / observation |
| `universal.terminal.execute` (sync ≤ timeout; else returns job) | `compute session exec [--detach] [--timeout]` | consequential |
| `universal.terminal.process.inspect / stop` | compute environment processes; cancel/signal | observation / consequential |
| `universal.files.list / read / write` | `compute session file list/read/write` | observation / consequential |
| `universal.files.search / move / delete` | `terminal.execute` (`rg`, `mv`, `rm`) inside the session | — |
| `universal.git.clone / status / diff / branch / commit` | `terminal.execute` with git in the image; clone token via egress credential brokering | — |
| `universal.development.run` | `pax test/build --json` inside the session → `pax.execution-result.v1` | consequential |
| `universal.jobs.get / cancel / result` | FeltKit invocations | observation / consequential |
| `universal.evidence.get` | Universal evidence join (W-U4) | observation |
| `universal.capabilities.search / describe / invoke` | AppPort manifest + `context.invoke` | — |

Git, search, move, delete are deliberately **not** new services — they are commands in a session.
They become first-class capabilities only for authority granularity (e.g. grant `git.status` without
`terminal.execute`). Note: if an agent holds `terminal.execute`, it can do anything the session can;
fine-grained grants only mean something for agents that lack it. That is an inherent property of giving
an agent a shell, and the authority UI must say so.

---

## 6. Work items by repository

### This repo — `boundry-universal` (`rkendel1/ultimate-mcp`)
- **W-U1** FeltKit app skeleton; one FeltDB instance; AuthBoundry application + check credential.
- **W-U2** `universal.*` capabilities (§5) with schemas, effects, idempotency.
- **W-U3** MCP route via `@appport/mcp createMcpHandler`; `context()` maps verified bearer → principal.
- **W-U4** Evidence join: one `universal_evidence` record per invocation, written in the invocation's
  transaction: principal, agent (executor proof), capability@version + digest, args digest (args stored
  only if classified safe), AuthBoundry `decision_id`, FeltKit invocation id, compute receipt digest,
  outcome, artifact refs. Refusals recorded durably (FeltKit currently sends them only to the pruned
  activity log). `universal.evidence.get` reads it.
- **W-U5** Acceptance suite (§8).

### FeltKit
- **W-F1** `compute` ExecutionAdapter on the existing `ExecutionAdapter` interface.
- **W-F2** Accept an AuthBoundry agent credential as MCP bearer, with executor proof (verify current
  behavior first; `mcp.ts` accepts FeltKit session or AppPort API key today).
- **W-F3** Replace hand-rolled `server/mcp.ts` with `@appport/mcp` (removes duplicate protocol code;
  optional for M0).
- **W-F4** Durable record of refused calls.

### compute
- **W-C1** Publish `@compute/appport` (currently `private: true`) or consume it from source.
- **W-C2** Deploy `compute serve` with the container provider on the D1 host; token auth; locked
  network (custom Docker network with no default route, egress only through `compute-egress`), since
  container egress is otherwise advisory (`compute/docs/egress.md:50-58`).
- **W-C3** Workspace persistence: confirm what survives stop/resume and host loss
  (`persistent_storage:false` today); define the guarantee honestly before claiming "environment
  survives the agent."
- **W-C4** Default session image: git, ripgrep, node, python, pax; Playwright + Chromium for W-B1.

### AuthBoundry
- **W-A1** Model Universal grants on what exists: capability strings (`universal.files.write`) + resource
  scope (`{type:"environment", id}`). No new hierarchy needed for MVP; environment/operation become
  resource attributes. Confirm `ResourceScope.is_subset_of` covers it.
- **W-A2** Implement the batch eligibility read (`docs/CAPABILITY-ELIGIBILITY.md`, currently proposal)
  so `tools/list` can be filtered per caller.
- **W-A3 (M5)** OAuth 2.1 authorization server for MCP (D2b).

### AppPort
- **W-P1** Put `capabilityDigest` into the projected tool's `_meta` (small; digests exist).
- **W-P2 (M6)** Inbound bridge: external MCP server → AppPort capabilities (does not exist).

### Not touched
PAX (used as a CLI inside sessions), Resolver (later), AppBoundry (hosting pipeline only), appport-services
Jobs (not used for Universal jobs).

---

## 7. Milestones (re-sequenced to the real dependency order)

**M0 — One agent, one capability, real authority** *(W-U1, W-U3, W-F2, W-A1)*
Spike FeltKit as the host. One observation capability (`universal.environments.list`).
Exit: an MCP client connects with an agent credential, lists and invokes; revoking the credential or the
delegation in AuthBoundry makes the **next** call fail; a call with no/invalid bearer is refused;
evidence record exists for allow and deny.

**M1 — Universal Computer** *(W-F1, W-C1–C4, terminal/files/git capabilities)*
Exit: an MCP client, through Boundry only, creates a computer, clones a repo, edits a file, runs tests
(`pax test --json`), commits on a branch; disconnects; reconnects and finds the workspace intact.

**M2 — Work records and independent verification** *(see CONTINUITY-AND-VERIFICATION.md §9)*
`universal.work.*` over FeltDB agent state; WorkIntent, WorkDecision, ReviewRun, ReviewerExecution,
Finding, Resolution; `verification.assemble`; constructed review via FeltKit generation.
Exit: **AT-1** (cross-agent continuation) and **AT-2** (independent review, human resolution,
durable decisions readable by a third agent) pass.

**M3 — Jobs and evidence** *(W-U4, W-F4, jobs capabilities)*
Exit: a long-running command continues after client disconnect; `jobs.cancel` actually stops the process
(verified by process absence, not status); every invocation, including refusals, has an inspectable
evidence record joined to the AuthBoundry decision and compute receipt.

**M4 — Browser and first integrations** *(W-C4 Playwright, GitHub via egress credential brokering, HTTP)*
Exit: an agent logs into an authorized test app in a session browser and returns a screenshot artifact;
GitHub token never appears in tool output or model context (asserted by test).

**M5 — Authority and product surface** *(W-A2, W-A3, approvals, console)*
Exit: ChatGPT connects via OAuth; tool lists are filtered per caller; consequential capabilities can be
set to require approval; an admin can do all of this without internal APIs.

**M6 — Extension** *(W-P2, n8n after licensing review)*

---

## 8. Acceptance tests mapped to owners

| Test | Owner / existing coverage |
|---|---|
| MCP client connects, lists, calls | `@appport/mcp` protocol + http tests (verified passing) + new Universal E2E |
| Unauthorized invocation rejected | AppPort fail-closed + AuthBoundry deny; new Universal E2E |
| Cross-tenant access rejected | AppPort "isolates tenants" tests + AuthBoundry L0 isolation conformance; new E2E across two orgs |
| Revocation effective next request | AuthBoundry `revocation_takes_effect_on_the_next_request`; new E2E through MCP |
| Environment isolation | compute container-engine CI; new test: session A cannot read session B |
| Timeout enforced / cancel stops process | compute tests; new E2E asserting the process is gone |
| Client disconnect, job continues | FeltKit invocations + compute `--detach`; new E2E |
| Recovery without duplicate side effects | FeltKit `IDEMPOTENCY_OUTCOME_UNKNOWN` semantics; new E2E with crash injection |
| Secrets never in model context | new test scanning all tool results/evidence for injected secret values |
| Provider replacement | swap container ↔ microVM provider; same `universal.*` contract passes |
| Real repository task | M1 exit test |
| **AT-1** Cross-agent continuation | FeltDB agent state (verified locally, `probes/`); new E2E across two clients and principals |
| **AT-2** Independent review → human resolution → durable decisions read by a third agent | New; see CONTINUITY-AND-VERIFICATION.md §8 |

---

## 9. Unknowns and risks (stated, not resolved)

- **FeltDB** source and hosted status not audited; the whole control plane depends on it.
- **Nothing in the stack is verified operationally** by this audit. The site itself says so
  (`boundry/content/stack.json` → `evidence.notYet`). The shared Hetzner server plan is unexecuted.
  `api.authboundry.com` is referenced as hosted; I did not call it.
- **FeltKit is preview (0.3.30).** M0 is a spike precisely to test this dependency.
- **Agent credential TTL (1h)** vs long agent sessions — verify renewal ergonomics for MCP clients.
- **Workspace durability** is weaker than the spec's promise until W-C3 defines it.
- **Container egress** is not enforced without W-C2 network lockdown; microVM needs KVM hardware.
- **Shell access dominates fine-grained grants** (see §5 note).
- **ChatGPT** requires D2b (OAuth); Claude Code does not.
- MCP spec evolution: `@appport/mcp` does not pin a protocol version (SDK ^1.31.0 negotiates). Pin the SDK
  version in Universal and add a conformance test per supported revision.
