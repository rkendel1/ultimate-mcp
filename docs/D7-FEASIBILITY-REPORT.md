# D7 Feasibility Report — Hosting the Agent Gateway Inside a FeltKit Application

Status: **read-only investigation. Nothing implemented. For review and a separate authorization decision.**
Date: 2026-11-16. Starting point: this repository at `b5e8ce5` (M0.1 closeout, unchanged).

Labels: **Verified** = run during this investigation · **Code** = read in source, not run ·
**Inference** = reasoned from code, not demonstrated · **Unknown**.

---

## 1. Executive conclusion

**D7(a) appears feasible with FeltKit's existing public extension point and no FeltKit change, with one
attribution caveat that needs an owner decision. Not yet proven: the decisive proof (§6) has not been
run.**

FeltKit already has **runtime components** (`feltkit({ components })`, `defineComponent` from
`@feltdb/feltkit/server`):
- They run **inside the FeltKit process**.
- They own declared route prefixes, and those routes reach them **before** any FeltKit identity
  handling: "the component authenticates its own traffic".
- They have **no database handle**. They act only by calling the application's own functions through
  the runtime, as one declared principal.

A gateway built as a component would therefore:
- share the single FeltDB owner and the same transaction semantics as the people-facing application;
- authenticate agents independently through AuthBoundry;
- be structurally unable to act as a person.

**The caveat:** inside FeltKit, every call from the component runs as the *component's* principal. The
agent's AuthBoundry identity reaches application functions only as data the component passes in. That
is explicit in-process attribution, not FeltKit-native agent identity. If FeltKit itself must carry the
agent as the acting principal (in its activity log and `ctx.auth`), that is a FeltKit change and needs
the owner's approval (§5).

This also corrects the earlier plan's reasoning, recorded separately in §8: the authority structure of
D7(a) and D7(c) is the same; they differ in process boundary, credentials and lifecycle.

---

## 2. What was inspected

| Item | Revision | Note |
|---|---|---|
| FeltKit source | `rkendel1/feltkit` `b0cfa6aefd7dafd7546c446113506b33dfcc69ab` (2026-11-14), `@feltdb/feltkit` **0.3.30** | Source of truth for this report |
| FeltKit published | npm `@feltdb/feltkit` **0.3.29** (latest published; 0.3.30 is unpublished) | The facts this report depends on were checked in 0.3.29's build too: component dispatch before FeltKit's own routes (`dist/server/index.js:768`), and the component principal rule (`dist/component.js:68`). `defineComponent` is exported there. |
| FeltDB | `@feltdb/core` 0.21.0 (FeltKit requires `>=0.21.0 <1.0.0`) | Published build only; source not accessible |
| This project | M0.1 gateway, `b5e8ce5` | Does not depend on FeltKit today |

Tests run (FeltKit's own; FeltKit checkout left unmodified):

| Suite | Result |
|---|---|
| `test/component-authority.test.ts` | **3/3 pass** (Verified) |
| `test/components.test.ts` | **6/6 pass** once this environment's ambient `FELTDB_*` variables are unset. With them set, 2 tests fail with FeltKit's own configuration guard: "Both FELTDB_URL and FELTKIT_STATE_DIR are set for production". That is an environment artifact, not a component defect (Verified) |

The covered behaviours include:
- a component may act only as its own identity or an application agent, never as a person;
- authority = declared roles + granted membership, with revocation effective on the next call;
- a built component is served on the application's port, as its principal, and its health joins the
  application's;
- component routes answer any Host in development, while FeltKit's own routes stay loopback-only.

---

## 3. Runtime and state-ownership map

| Question | Answer | Evidence | Label |
|---|---|---|---|
| How is the process started? | `startServer(options)` builds one HTTP handler for the runtime, or attaches to a server `feltkit start` already opened | `packages/sdk/src/server/index.ts:51-77, 190` | Code |
| Who owns FeltDB? | The runtime, exactly once: `runtime/instance.ts` is "the only place in FeltKit that calls `createFeltDB`"; across processes FeltDB's `owner.lock` refuses a second owner | `runtime/instance.ts:4-19, 210-212` | Code |
| How are routes registered? | A fixed dispatch in one handler: component routes first, then `/_feltkit/health`, `/api/*`, `/mcp`, `/appport*`, `/_feltkit*`, the frontend. Applications cannot add routes except through components | `server/index.ts:804-900` | Code |
| Can external handlers be mounted? | **Yes, as components.** `ComponentDeclaration { entry, routes, websocket?, required?, principal: { id, roles }, credentials?, network? }`; `ComponentInstance { request?, upgrade?, health, close? }` | `component.ts:20-36, 110-118`; `server/components.ts:162-190` | Code + Verified (tests) |
| Is a component in-process? | Yes: "Runs an application's runtime components inside its FeltKit process"; loaded from source in development (tsx) or from the build (`.feltkit/build/components/<name>.mjs`) in production | `server/components.ts:1-12, 211-232` | Code + Verified |
| What can a component reach? | `ctx.call(fn, args, { tenant? })` runs an application function through `runtime.call` **as the component's declared principal**, re-resolved each call (revocation applies next call). Also `ctx.credential(id)` (declared credential ids only), `ctx.derive`, `ctx.model()` and durable `ctx.work`. **No FeltDB handle.** | `server/components.ts:95-148` | Code + Verified |
| What identity may a component use? | Only `component:<name>` or a declared app agent; "a component may not act as a person or another principal" | `component.ts:172-176` | Code + Verified |
| Authentication on component routes | None by FeltKit; the component authenticates its own traffic. FeltKit's identity path (sessions, cookies, `auth.authenticate` hook) is never applied | `server/index.ts:809-811` | Code |
| Transaction semantics | A mutation's writes are buffered and committed as **one** atomic FeltDB transaction. Inserts are `requireAbsent`; updates and deletes are `ifVersion`-fenced; reads by id become preconditions; `find`/`query` reads are fenced against phantoms. A conflict → `CONFLICT`, nothing written. `ctx.call` retries `CONFLICT` up to 4 times (safe: nothing was written) | `runtime/data.ts:1-27`; `server/components.ts:109-115` | Code |
| Human requests | `/api/{query,mutation,action}/<fn>` → `runtime.call(fn, args, { principal })`, principal from a FeltKit session, cookie, or the app's `auth.authenticate` hook | `server/index.ts:207-231, 312-339` | Code |
| Errors and isolation | A component's thrown error becomes a 500 for that request; a component that fails to start is reported failed and does not stop the app; health = runtime + required components; components close in reverse order on shutdown | `server/components.ts:76-90, 162-176, 192-219` | Code + Verified (health) |
| Request isolation between components and the app | Same process and event loop: a component that blocks the event loop or leaks memory affects the whole application | — | Inference |

Two related facts rule out simpler paths:
- **`auth.authenticate` hook** (`server/index.ts:225-229, 283-288`): an app can supply its own identity
  function, but only for requests **without** `Authorization: Bearer`. A bearer token is always resolved
  as a FeltKit session or API key and refused if it is neither (`:211-214, 270-281`). The resulting
  principal is still authorized by FeltKit roles, and the hook does not know which capability is called,
  so it cannot carry an AuthBoundry per-capability decision.
- **FeltKit's own `/mcp`**: authorized by FeltKit roles, and it accepts only FeltKit sessions or API keys
  (established in M0.1).

---

## 4. D7(a) — the seven questions

| # | Question | Answer | Label |
|---|---|---|---|
| 1 | Can the handler use the application's FeltDB without constructing another? | **Yes, indirectly and only that way.** A component has no FeltDB handle; every read and write goes through application functions on the runtime's single instance. The M0.1 gateway's direct `createFeltDB` and evidence store would be replaced by calls to application functions. | Code |
| 2 | Same authoritative state and transaction mechanisms as normal operations? | **Yes.** `ctx.call` → `runtime.call`, the same path as `/api/mutation`; one atomic FeltDB transaction per mutation, with the same fences. | Code |
| 3 | Can human UI mutations and MCP mutations reach the same Build Core? | **Yes**, if the Build Core *is* the application's functions: people call them via `/api/mutation/<fn>`, the component via `ctx.call(<fn>)`. | Code + Inference |
| 4 | Independent AuthBoundry authentication, without inheriting or spoofing a FeltKit human session? | **Yes for authentication**: component routes bypass FeltKit identity entirely, so the M0.1 AuthBoundry check runs unchanged in the component (the check credential can come from `ctx.credential`, FeltKit custody, instead of an environment variable). **No spoofing**: the component cannot use a person's identity. **But** see the attribution caveat (§5). | Code + Verified (principal rule) |
| 5 | Different capabilities for human and agent callers? | **Yes, by construction.** Functions declare an `access` permission. The component's principal holds only the roles the app grants it, so human-only functions refuse it. A human-only function can additionally require `ctx.auth` principal type `user`. | Code + Verified (roles) |
| 6 | Lifecycle, error and request-isolation guarantees? | **Mostly.** Startup failure is reported without stopping the app; per-request errors are contained; components close on shutdown; health is joined. **Not isolated** from the app's event loop and memory (same process). In development, component routes answer any Host. | Code + Verified + Inference |
| 7 | Public extension point, private API, or FeltKit change? | **Public extension point**, present in published 0.3.29 and in 0.3.30. A FeltKit change is needed **only** if the owner requires FeltKit-native agent identity (§5, C1). | Code + Verified |

### How the M0.1 gateway would map (proposed, not implemented)

| M0.1 piece | As a component |
|---|---|
| HTTP + MCP handler (`@appport/mcp`) | `ComponentInstance.request` on a route such as `/agents/mcp/` |
| AuthBoundry decision per call | unchanged; check credential via `ctx.credential` |
| Evidence store (direct FeltDB) | application mutations, e.g. `evidence:recordAuthorized` / `evidence:recordOutcome`, via `ctx.call` |
| Capability handlers | `ctx.call` into the same application functions people use |
| Fail closed | unchanged: if an evidence `ctx.call` throws, nothing executes or the result is withheld |

**A possible improvement, not available in M0.1:** for effects that live entirely in FeltDB, the effect
and its outcome evidence could be written by **one** mutation, in one atomic transaction. That would
close M0.1's "authorized without outcome" gap for state-only operations (Inference; needs the proof).

---

## 5. The attribution caveat, and the FeltKit change it may require

Inside FeltKit, a component's calls run as the component's principal. For a call from agent `agent:a`,
authenticated by AuthBoundry:

| Layer | Who it names | Basis |
|---|---|---|
| AuthBoundry decision | `agent:a` (authenticated principal), decision id | credential possession, as in M0.1 |
| FeltKit `ctx.auth` / activity log | `component:<name>` | FeltKit's declared component identity |
| Application record (`actor`) | `agent:a` | **asserted by the component**, trusted by the function only when `ctx.auth` is that component |

Nothing silently substitutes an identity: all three can be recorded. But FeltKit's own activity log
would show the component, not the agent. Two options:

- **C0 (no FeltKit change):** functions on the agent surface take `actor` and `authority_decision_id`
  as arguments, and refuse unless `ctx.auth` is the gateway component. Records state "actor asserted by
  component after AuthBoundry authentication". This is the same structure as M0.1's evidence: separate
  fields, nothing collapsed.
- **C1 (FeltKit change, owner approval required):** a component may call a function *on behalf of* an
  externally authenticated principal, with an attestation (issuer, decision id) that FeltKit records and
  exposes in `ctx.auth`. The function then sees the agent natively, and FeltKit's activity log names it.
  This is a new FeltKit capability, not an existing one.

**Recommendation:** run the decisive proof with C0. Propose C1 to the FeltKit owner only if the proof or
the product requires FeltKit-native agent attribution.

Two-layer authorization in D7(a), stated plainly:
- FeltKit roles decide which functions the gateway **surface** may reach at all. This is static,
  declared by the application, and is what keeps human-only functions unreachable.
- AuthBoundry decides which **agent** may invoke which capability now.
- Both must allow. The roles set a ceiling for the surface; they never grant an agent anything
  AuthBoundry denied.

Whether this layering is acceptable under "AuthBoundry is the authority for agents" is a decision for
the owner (§7, Q1).

---

## 6. Alternatives compared

| | D7(a) In-process component | D7(b) Managed FeltDB over HTTP | D7(c) Gateway calls FeltKit as a trusted service |
|---|---|---|---|
| State ownership | One process, one FeltDB owner (the runtime) | One FeltDB server; **two writers** (FeltKit app and gateway) | One process owns FeltDB (FeltKit); the gateway owns none |
| Rules (Build Core) | One implementation: application functions | **Two** unless the gateway re-implements none and calls FeltKit, which makes it (c) | One implementation: application functions |
| Agent authentication | AuthBoundry, in the component | AuthBoundry, in the gateway | AuthBoundry, in the gateway |
| FeltKit-level identity | component principal; agent asserted (C0) | gateway writes directly; FeltKit's rules are bypassed | service principal (API key); agent asserted over the network |
| Transactions | FeltKit mutation transactions, fenced | Raw FeltDB transactions from the gateway. FeltKit's own fences are documented to detect commits made through its Writer, not other writers (`data.ts:21-24`), so direct gateway writes can slip past FeltKit's read fences | FeltKit mutation transactions, fenced |
| Operational dependencies | none new | a hosted FeltDB service, its credentials and network (operational status unverified; FeltKit's Managed e2e tests are skipped without it) | a second process, a service credential, a network hop, two deployments |
| Failure modes | shared event loop and memory | gateway writes while FeltKit is down; split brain over rules; live queries miss external writes | network partition between gateway and app; service credential leak gives app-level access |
| Platform changes | none (C0); optional C1 | none in code, but a hosted service | none |
| Preserves intended architecture | **Yes**, if Q1 accepts the two-layer authorization | **No**: two writers, rules outside the Build Core | **Yes** for state and rules; weaker trust boundary than (a) |

Not chosen for ease: (a) and (c) have the same authority structure. (a) is preferred because it removes
a network trust boundary, a service credential and a second deployment, with no loss.

---

## 7. Smallest decisive proof (specified, **not run**)

A real FeltKit application in this repository (not a mock), with one collection `notes`
(`text`, `version`, `updated_by_actor`) and three functions:
- `notes:create` (human only);
- `notes:updateFromAgent(id, text, actor, authority_decision_id)` (gateway component only);
- `notes:get` (both).

Plus one component, `agent-gateway`, on `/agents/mcp/`, with the M0.1 AuthBoundry check and evidence
written through application mutations.

| # | Step | Pass criterion | Existing API? |
|---|---|---|---|
| 1 | Start the app (`feltkit build` + `feltkit start`) against a local state dir, ambient `FELTDB_*` cleared | `/_feltkit/health` = `ready`, component `ready` | Yes |
| 2 | Component mounted with an AuthBoundry-authenticated MCP handler (local AuthBoundry, as M0.1) | a call without a credential is refused and recorded | Yes (components + M0.1 code) |
| 3 | A person signs in (FeltKit account) and calls `notes:create` via `/api/mutation` | record exists, `updated_by_actor` = person | Yes |
| 4 | Agent reads it through MCP (`notes_get`) | same id, text and version | Yes (`ctx.call`) |
| 5 | Agent updates it through MCP | version +1; actor = AuthBoundry-authenticated agent; AuthBoundry decision id recorded; FeltKit activity names the component (C0) | Yes |
| 6 | Person reads it via `/api/query` (and a live `useQuery` subscription receives the change) | sees the agent's update | Yes |
| 7 | Restart the app process (SIGKILL, then start) | record, versions and evidence intact | Yes |
| 8 | Agent invokes `notes:create` (human-only) through MCP | refused by FeltKit roles; refusal recorded; nothing written | Yes |
| 9a | Same database: no `createFeltDB` outside FeltKit's runtime in this repository's app code; one `owner.lock` holder; a second process opening the state dir is refused | asserted by test | Yes |
| 9b | Same transaction semantics: a person's update and an agent's update to the same note, racing on the same version | exactly one commits per version; the other gets `CONFLICT` (and the component's retry re-reads); no lost update | Yes |
| 9c | Same fences: an agent's write and a person's mutation that read the same record | the stale one is refused | Yes |
| 10 | Revoking the agent's delegation or credential in AuthBoundry | next MCP call refused | Yes |

Acceptance: all steps pass through two MCP clients (as M0.1), with transcripts committed from a clean
checkout. **Everything above is possible with existing FeltKit APIs.** Only C1 would need a FeltKit
change, and the proof does not need it.

---

## 8. Corrections to record separately (not applied to PRODUCT-PLAN.md)

1. PRODUCT-PLAN.md §9 says FeltKit "has no way to mount another request handler". **That is wrong.**
   Runtime components are that mechanism (public, in 0.3.29 and 0.3.30). D7(a) is "use components",
   not "a small FeltKit extension".
2. PRODUCT-PLAN.md rejects D7(c) because "FeltKit roles plus gateway assertions would make two
   authorities". D7(a) has the same two-layer structure in-process. The real differences are the
   network boundary, the service credential and a second deployment. Both should be judged on Q1.
3. M0.1 reproduction: this environment sets `FELTDB_*` variables. M0.1 explicitly passes a local path,
   which FeltDB resolves as local mode (Verified: data written to that path). But the store picked up
   ambient namespace, application and environment labels. Future test harnesses should clear
   `FELTDB_*`. M0.1's results are unaffected.

---

## 9. Questions requiring owner decisions

- **Q1 (architecture owner):** is two-layer authorization acceptable for the agent surface: FeltKit roles
  as a static surface ceiling, AuthBoundry as the per-agent, per-call authority, both required?
- **Q2 (architecture owner):** is C0 attribution (agent asserted by the in-process component after
  AuthBoundry authentication, recorded beside FeltKit's component identity) acceptable for P1? Or must
  FeltKit natively carry the agent (C1)?
- **Q3 (FeltKit owner, only if Q2 = C1):** accept a component "call on behalf of an externally
  authenticated principal, with attestation" capability?
- **Q4 (FeltKit owner):** confirm components are intended for long-lived, authenticated agent surfaces,
  not only provider webhooks (the code comment's example). Confirm their support status for 0.3.x.
- **Q5:** which FeltKit version P1 pins: published 0.3.29, or 0.3.30 once published.

## 10. Unknowns

- Behaviour of a long-running MCP component under load in the same event loop as the app (untested).
- Whether FeltKit's activity and audit records for component calls are sufficient evidence alongside
  the gateway's own records (needs the proof's output).
- Managed FeltDB's operational status (D7(b)); not contacted.
- Whether `ctx.call`'s automatic `CONFLICT` retry interacts correctly with gateway evidence ids (each
  retry is one logical invocation; needs the proof).

## 11. Recommendation

Authorize the **decisive proof in §7 with C0**: a real FeltKit application in this repository using a
runtime component, no FeltKit changes and no P1 work. Decide Q1 and Q2 before or alongside it.
- If the proof passes and Q1/Q2 are accepted, D7(a) is settled.
- If Q2 requires C1, take the specific FeltKit change in §5 to the FeltKit owner.
- Reject D7(b) for the Build Core architecture: it creates a second writer outside FeltKit's rules and
  fences.
- Keep D7(c) only as a fallback if components prove unsuitable (for example under load); it preserves
  state and rules, with a weaker trust boundary.
