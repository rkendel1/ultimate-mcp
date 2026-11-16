# D7(a) Proof Report — the Agent Gateway as a FeltKit Runtime Component

Date: 2026-11-16. Branch `claude/loving-archimedes-ppxpwl`.
Proof commit: **`b872a83a0fe68bf89c32c1d963409bf95de9a2f1`**. Starting point `f8c3e47`; M0.1 baseline `b5e8ce5`, unchanged.
Owner decisions applied: **Q1** (FeltKit roles = surface ceiling, AuthBoundry = per-invocation authority, both
required) and **Q2 = C0** (component-asserted actor, recorded separately from FeltKit's principal and
AuthBoundry's principal).

## Disposition

**D7(a) is proven, within the limits stated in §8.** All mandatory acceptance criteria in the authorization
(§4 scenario, §5 single ownership and transactions, §6 fail-closed evidence) pass.
- **Committed tree verified:** **18 of 18** tests pass on a clean detached checkout of the proof commit, with
  dependencies installed from its lockfiles and the working tree clean before and after
  ([evidence/d7-integration-test-run.txt](evidence/d7-integration-test-run.txt)).
- **Development run:** the transcript taken before the commit has the same results
  ([evidence/d7-integration-dev-run.txt](evidence/d7-integration-dev-run.txt)).
- **The suite can fail:** two deliberately planted defects were each caught (§6).

No FeltKit change was made or needed. The published `@feltdb/feltkit` 0.3.29 extension point (runtime
components) was sufficient.

---

## 1. Revisions and versions

| Item | Version | Resolution / identity |
|---|---|---|
| FeltKit | `@feltdb/feltkit` **0.3.29** (published) | `sha512-uIzW4Xtq…+uOQ==` (d7-proof/package-lock.json). Unpublished 0.3.30 not used |
| FeltDB | `@feltdb/core` 0.21.0 | `sha512-jEYrJI3F…z99g==`; one copy, shared by FeltKit and the proof |
| AppPort | core 1.7.1, mcp 1.3.8, protocol 1.5.0, schema 1.1.6, sdk 1.8.1 (FeltKit's) | one `@appport/core`, deduplicated |
| MCP TypeScript SDK | `@modelcontextprotocol/sdk` 1.32.2 | |
| MCP Python SDK | `mcp` 2.3.0 | reused virtualenv (not in git by design) |
| AuthBoundry | `rkendel1/authboundry` `0c982e4a9b37fed5393a0d7b659e420235b15d39` | local debug build of `target/debug/authboundry`, sha256 `7663b0272317ffbe…` |
| Node / Python | v22.23.4 / 3.13.18 | |
| Component build | `.feltkit/build/components/agent-gateway.mjs` | sha256 `7dfe6e971448…`, identical in the development and clean runs |

Full integrity strings are in the clean-run transcript header.

---

## 2. Architecture and request flow

```
 Person (FeltKit account)                          Agent (any MCP client)
   │ POST /api/{query,mutation}/notes:*               │ POST /agents/mcp/   Authorization: Bearer aga_…
   │ Bearer <FeltKit session>                         │ x-boundry-on-behalf-of: user:ada
   ▼                                                  ▼
 ┌──────────────────────── one process: `feltkit start` (FeltKit 0.3.29) ─────────────────────────────┐
 │ FeltKit identity → principal acct_…, role member     component "agent-gateway" (routes /agents/mcp/) │
 │                                                       1 AuthBoundry /authorize/check (src/authority.ts)
 │                                                       2 ctx.call evidence:recordAuthorized (before work)
 │                                                       3 AppPort dispatch → ctx.call notes:* as         │
 │                                                         FeltKit principal component:agent-gateway      │
 │                                                         (role "gateway" = the surface ceiling)         │
 │                                                       4 outcome: atomic in notes:updateFromAgent, or   │
 │                                                         ctx.call evidence:recordOutcome               │
 │                  │                                                   │                               │
 │                  └──── runtime.call → FeltKit functions (one set of rules) ──┘                         │
 │                        notes:create · notes:get · notes:update · notes:updateFromAgent ·              │
 │                        evidence:recordAuthorized · evidence:recordOutcome · evidence:list             │
 │                                   │ one atomic FeltDB transaction per mutation                       │
 │                        FeltDB (one instance, owner.lock in FELTKIT_STATE_DIR)                        │
 └────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                          ▲
                        AuthBoundry (local, separate process): identity and per-call authority for agents
```

| Function | Access (role) | Additional check |
|---|---|---|
| `notes:create` | `notes.create` (member only) | caller type must be `user` |
| `notes:get` | `notes.read` (member, gateway) | — |
| `notes:update` | `notes.write` (member only) | caller type `user`; `expectedVersion` must equal current |
| `notes:updateFromAgent` | `notes.agentWrite` (gateway only) | caller must be `component:agent-gateway`; `expectedVersion`; writes note **and** outcome evidence in one mutation |
| `evidence:recordAuthorized` / `recordOutcome` | `evidence.write` (gateway only) | caller must be `component:agent-gateway`; writes `feltkitPrincipal` from `ctx.auth` |
| `evidence:list` | `evidence.read` (member only) | — |

Reuse: the component imports M0.1's `src/authority.ts` (the AuthBoundry client) and `src/evidence.ts` helpers
**unchanged**. It adapts M0.1's request flow to the component interface. There is no second authorization
implementation and no second store.

---

## 3. Reproduce

```bash
# once: AuthBoundry (as in M0.1) and the Python driver
(cd ../authboundry && npm ci --omit=dev --ignore-scripts && cargo build --bin authboundry)
python3 -m venv test/clients/.venv && test/clients/.venv/bin/pip install mcp==2.3.0
# the proof
npm ci                                  # repository root: MCP TypeScript client + M0.1 harness deps
cd d7-proof && npm ci
env -u FELTDB_URL -u FELTDB_MODE -u FELTDB_NAMESPACE -u FELTDB_APPLICATION_ID -u FELTDB_ENVIRONMENT npm test
```

`npm test` runs `feltkit build`, then three suites. Each suite starts:
- a fresh local AuthBoundry;
- the application with `node node_modules/@feltdb/feltkit/bin/feltkit.js start --port 0 --host 127.0.0.1`
  (production mode), in a fresh `FELTKIT_STATE_DIR` temp directory, with the environment listed in the
  transcript header.

Processes are stopped by the suites (SIGTERM or SIGKILL). Set `AUTHBOUNDRY_SRC` / `AUTHBOUNDRY_BIN` /
`BOUNDRY_TEST_PYTHON` if paths differ. The test support also deletes any `FELTDB_*` variable from its own
process.

---

## 4. Scenario results (authorization §4)

Run through the TypeScript client and the Python client with separate agents; the comparable observations
were identical (`both MCP clients observe the same behaviour`).

| # | Step | Result |
|---|---|---|
| 1 | Start a real FeltKit app with the component mounted | ✅ `feltkit start`, production, port 0 |
| 2 | Application and component health | ✅ `status: ready`, `runtime: ready`, `agent-gateway: ready` on `/agents/mcp/`; the component's context offers `application, call, credential, derive, environment, log, model, name, work`, with no database |
| 3 | A person authenticates through FeltKit | ✅ account sign-up → session; principal `acct_…` |
| 4 | Person creates a note via `/api/mutation/notes:create` | ✅ version 1; actor = the person, basis `feltkit_session` |
| 5 | Agent A reads it through MCP | ✅ same text and version |
| 6 | Agent A updates it through MCP at version 1 | ✅ `{ id, version: 2 }` |
| 7 | Person reads it via `/api/query/notes:get` | ✅ the agent's text, version 2 |
| 8 | The person's live query receives the change | ✅ FeltKit's `/api/events` stream (opened before step 6) delivered a `change` for `notes`. This is the mechanism `useQuery` re-runs on; no browser rendered it |
| 9 | Three identities, separately recorded | ✅ §7 |
| 10 | `notes_create` through MCP | ✅ AuthBoundry **allowed** it (delegated); FeltKit **refused** it (`FORBIDDEN`, recorded as `feltkit_error: FORBIDDEN`); no note created |
| 11 | Revoke Agent A's delegation | ✅ next call refused (`FORBIDDEN`, AuthBoundry `deny`) |
| 12 | Restore the delegation | ✅ next update succeeds (version 3). Revoking the credential then refuses the next call (`UNAUTHORIZED`) |
| 13 | SIGKILL and restart the FeltKit process | ✅ every note and the whole evidence list identical before and after |

---

## 5. Single ownership and transactions (authorization §5)

| Criterion | Result |
|---|---|
| One FeltDB instance, created by FeltKit's runtime | ✅ the app's environment names one `FELTKIT_STATE_DIR` and no `FELTDB_*` service or URL |
| The component has no FeltDB access | ✅ its runtime context has no database (step 2). Its built bundle contains no `createFeltDB`, `openAgentState`, `StateFirstDB` or `@feltdb/core`. Its source neither imports `node:fs` nor writes files |
| Only one owner holds the state directory | ✅ opening it directly while FeltKit runs → `STATE_LOCKED` |
| A second process cannot own it | ✅ a second `feltkit start` exits 1: "The production environment is already running … Two processes on one environment would mean two FeltDB instances on the same state." The first owner stays `ready` |
| No second database service or writer | ✅ no `FELTDB_URL`; all writes are FeltKit functions |
| Person holding, agent commits | ✅ the agent's write committed (version 2). The person's held write was refused by FeltKit's transaction fence with **`CONFLICT`**. Final state = the agent's write. Nothing lost |
| Agent holding, person commits | ✅ the person's write committed (version 2). The agent's held write was refused: FeltKit's fence raised `CONFLICT`, the component's `ctx.call` retried, and the application's version check refused the retry with **`FAILED_PRECONDITION`**. Evidence: an `authorized` record and exactly one `failed` outcome, and no `completed` outcome |
| Stale read, both directions | ✅ a person who read version 1 cannot overwrite an agent's version 2 (`FAILED_PRECONDITION`), and an agent who read version 2 cannot overwrite a person's version 3 |
| Same runtime for both doors | ✅ FeltKit's own view of each writer, `feltkitPrincipal` from `ctx.auth`, is the person's account for people and `component:agent-gateway` for the agent; only the component wrote agent evidence |

Both doors therefore get the same fences: FeltKit's per-mutation transaction (the read-version fence →
`CONFLICT`) and the application's explicit `expectedVersion` check (→ `FAILED_PRECONDITION`).

---

## 6. Fail-closed evidence (authorization §6)

Faults are injected **server-side**: the application reads `D7_PROOF_FAULT` from its own environment, and
the failure travels FeltKit's real mutation path. No client can trigger it.

| Case | Result |
|---|---|
| The authorized record cannot be written | ✅ `503 EVIDENCE_UNAVAILABLE`; the note unchanged; nothing recorded; nothing executed |
| The outcome record cannot be written | ✅ `503`, result withheld; the `authorized` record stands alone (**no reconciliation**, a known gap) |
| A refusal cannot be recorded | ✅ `503`, never a silent refusal (AuthBoundry deny, and missing credential) |
| **State and outcome atomic** | ✅ `notes:updateFromAgent` writes the note change and its `completed` outcome in **one** mutation. A failure injected after both were staged left **neither**: the note was unchanged, and the only outcome was the separately recorded `failed` (`feltkit_error: UNAVAILABLE`) |
| AuthBoundry unavailable | ✅ refused as `AUTHORITY_UNAVAILABLE`, recorded with `decision_id: null` |
| Faults cleared | ✅ the same update commits; its outcome references exactly the committed version (`note:<id>@<n>`) and the note's `authorityDecisionId` |

**Effect on M0.1's gap:** for state-only agent writes, "executed without an outcome" can no longer happen,
because the change and its outcome commit together. For reads, refusals and effects outside FeltDB, an
`authorized` record can still be left without an outcome when the outcome write fails. Recovery is **not**
tested, and nothing here is exactly-once execution.

**Planted defects (suite sensitivity):**
1. The outcome is no longer written with the change → step 9 fails in both client scenarios, and so does
   the "faults cleared" check.
2. The component takes a claimed `x-boundry-principal` header as the actor → "a claimed identity never
   becomes the actor" fails.

Both were restored; the rebuilt component hash equals the tested one.

---

## 7. Identity provenance (C0)

An agent update as stored and read back by the person (from a development smoke run of this code):

```json
{
  "text": "from agent",
  "actor": "agent:smoke",
  "actorBasis": "component_asserted_after_authboundry",
  "feltkitPrincipal": "component:agent-gateway",
  "authorityDecisionId": "boundry-continuity-decision-1794796630-6ee47d86ff41ba9a",
  "__version": 2
}
```

The matching evidence record:
- `feltkitPrincipal: "component:agent-gateway"`, written by the evidence function from `ctx.auth`.
- `record.caller`: `authenticated_principal_id: "agent:smoke"`, `authentication:
  "authboundry_agent_credential"`, plus the agent credential id.
- `record.application_actor: { id: "agent:smoke", basis: "component_asserted_after_authboundry" }`.
- `record.authority`: outcome `allow`, the same decision id, delegation id, `on_behalf_of: "user:ada"`.
- `record.executor: { service: "component:agent-gateway", identity_basis: "feltkit_declared_component" }`.

| Identity | Value | Established by |
|---|---|---|
| AuthBoundry principal | `agent:smoke` | AuthBoundry, from the presented credential (possession only, not which software or person held it) |
| FeltKit principal | `component:agent-gateway` | FeltKit, from the declared component identity (`ctx.auth`) |
| Application actor | `agent:smoke` | **asserted by the component** after AuthBoundry's allow; accepted by the function only because FeltKit identified the caller as the gateway component |

FeltKit does **not** authenticate the agent; its own activity names the component. A person's change is
recorded with actor = FeltKit principal = the account, basis `feltkit_session`, and no AuthBoundry
decision (D6 is not implemented).

Substitution attempts (all refused or ignored, tested):
- claims in `x-boundry-principal`, `x-principal-id` and `_meta`;
- an `actor` field in tool arguments (rejected by the input schema);
- a person calling `notes:updateFromAgent` or `evidence:recordAuthorized` directly (`FORBIDDEN` by FeltKit
  roles).

---

## 8. Failures, caveats, untested behaviour

During development (all fixed before the commit; none affects the result):
- FeltKit's `s` exposes `enum` / `unknown`, not `enumeration` / `unknownSchema`.
- One assertion expected the word "lock" in the second-owner refusal. FeltKit refuses earlier, with "already
  running", and the assertion now accepts FeltKit's actual message.

Caveats:
1. **C0 attribution:** FeltKit's activity and `ctx.auth` name the component, not the agent. Native agent
   attribution (C1) would need a FeltKit change; it was not pursued.
2. **The gateway-only check inside functions** (`ctx.auth` = `component:agent-gateway`) is a second guard. It
   was not exercised on its own, because FeltKit's role ceiling refuses non-gateway callers first.
3. **Proof-only seams:** `holdMs` / `hold_ms` (race timing, max 3 s) and `D7_PROOF_FAULT` exist only in this
   disposable application and must not carry into the Build Core.
4. **Duplicated flow:** the component re-expresses M0.1's gateway flow for the component interface; the
   AuthBoundry client and evidence helpers are shared. One gateway core should be extracted before product
   use; that is not done here.
5. **Same process:** the component shares the application's event loop and memory. Behaviour under load was
   not tested.
6. `tools/list` needs no credential, refusals are MCP tool errors, and evidence visibility is application-wide
   (person-only here). These are the same limitations as M0.1.
7. The AuthBoundry application from the M0.1 harness was reused (`boundry-continuity`), with a contract version
   1.1.0 adding `notes.*`. The harness itself is unchanged.
8. **Live query:** proven through FeltKit's change stream, which `useQuery` consumes; no browser UI was rendered.

Untested:
- `feltkit dev` (only production `feltkit start`);
- machine or power loss;
- crash between a FeltKit commit and its HTTP response;
- multiple instances;
- hosted AuthBoundry;
- real agent products (only the two SDK clients);
- reconciliation of authorized-without-outcome records.

---

## 9. What D7 now settles, and what it does not

**Settled:**
- A FeltKit 0.3.29 application can host the AuthBoundry-gated agent surface **in-process**, with:
  - one FeltDB owner;
  - one set of functions and transaction rules for people and agents;
  - independent authentication for each door;
  - FeltKit roles as the agent surface's ceiling, and AuthBoundry as per-call authority;
  - durable, separately attributed evidence that fails closed.
- No FeltKit change is required.

**Not settled:**
- D6 (a person's decision authority through AuthBoundry);
- F3 (verification runner);
- any Build Session or Build Core behaviour;
- C1;
- production hosting.
