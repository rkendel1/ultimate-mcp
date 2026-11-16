# Boundry — Interactive, Outcome-Directed Development: Product Plan

Status: **plan for review. Nothing beyond the approved M0.1 scope is built.**
Revision 4, 2026-11-16. Supersedes the product definition and milestones in
[IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md); its reality map, decisions D1–D5 and the M0.1 slice
remain valid. Review isolation in [CONTINUITY-AND-VERIFICATION.md](CONTINUITY-AND-VERIFICATION.md)
becomes one verification method here.

Evidence levels: **Verified** (run in this work), **Tested** (repo tests exist, not run here),
**Code**, **Doc**, **Missing**. Sources: FeltKit `b0cfa6a`, `@feltdb/core` 0.21.0 (published build),
AuthBoundry `0c982e4`, AppPort `35a57ea`, compute `b8607ae`, this repo's probes.

---

## 1. Product definition

> **Boundry helps people build what they actually intend to build.**
> It manages development as an interactive, durable process in which humans establish direction,
> agents perform authorized work, Boundry detects drift and brings meaningful decisions to the human,
> and outcomes are verified against the evolving intent.
>
> *Tell Boundry what you want to build. Work alongside it as it builds. Stay in control of what gets
> decided and delivered.*

The primary experience is a **Build Session**: a persistent, interactive build of an intended outcome,
owned by people, worked on by replaceable agents. The infrastructure already planned (authority,
evidence, MCP, execution) serves that experience; it is not the product.

Boundry always keeps six states apart, and never lets a later one rewrite an earlier one:

| State | Where it lives | Changes by |
|---|---|---|
| Originally intended | Baseline version 1 | Never changes |
| Subsequently decided | Decision records (append-only) | A human decision |
| Currently intended | Latest baseline version | Only a human decision creates a new version |
| Actually implemented | Work checkpoints citing commits and artifacts | Agents' work |
| Verified | Evaluations of a criterion **version** at a commit, with receipts | Verification runs, not claims |
| Accepted | A human acceptance decision naming baseline version and evaluations | A human |

A pass recorded against criterion v1 is not a pass for v2. Changing intent leaves earlier work
unverified against the new version until it is verified again.

---

## 2. What exists today, and what does not

### Reusable as-is
| Need | Existing | Level |
|---|---|---|
| Human-facing app: data, functions, live UI | FeltKit app model (`app.collection/query/mutation/action`), React hooks `useQuery` (live over SSE), `useMutation`, `useAction`; example apps with Vite + React UIs (`examples/tasks`, `examples/invoices`) | Tested (125 test files) |
| Human accounts and sign-in | FeltKit accounts, sessions, Google/GitHub/OIDC with PKCE | Tested |
| Work items and continuation | FeltDB agent state: tasks, immutable checkpoints, scoped memory, leased handoffs, context assembly | **Verified** (`probes/feltdb-continuity.mjs`) |
| Versioned constraints and acceptance criteria, drift evaluations | FeltDB architecture invariants: immutable versioned declarations, verification methods (`automated-test`, `human-review`, …), advisory evaluations `PASS / DRIFT / UNKNOWN`, `UNKNOWN` never promoted to `DRIFT` | **Verified** (`probes/feltdb-invariants.ts`) |
| Agent identity and per-call authority | AuthBoundry agent credentials, delegations, `/authorize/check` deriving the principal from the credential | **Verified** (M0.1 harness against the real server) |
| Agent MCP surface with durable evidence | M0.1 gateway (this repo) | Code, type-checked; tests pending |
| Execution receipts | compute `run --json` / sessions: execution id, exit status, output, SHA-256 receipts | Tested |
| Approving an exact operation | FeltKit approval rules: only a person approves, the proposer can't approve, the approval binds to an input digest, proposals expire (`runtime/approval-rules.ts`) | Tested (`approval-binding`, `approval-required`) |

### Reusable with extension
| Need | Existing | Gap |
|---|---|---|
| AuthBoundry as authority for agents inside a FeltKit app | FeltKit app MCP/AppPort calls are authorized by FeltKit roles (`runtime/authority.ts:139-150`). The platform server adds AuthBoundry *on top of* roles, naming the principal from FeltKit's session, so the executor is only asserted (`platform/platform.ts:231-236`) | Agents use the M0.1 gateway; it must share the app's state (D7) |
| Human decisions attributable through AuthBoundry | FeltKit humans are FeltKit accounts; `ctx.authority.decide` asks AuthBoundry as the app's executor `onBehalfOf` a person (`application-authority.ts:60-105`) | Human identity binding (D6) |
| Recording a rationale with an approval | Approve takes no note; reject and platform decide do (`agent.ts:948`) | A decision record carries the rationale (new) |

### Missing (nothing in any repo)
Build Session; outcome model and baseline snapshots; agent questions with alternatives answered by a
person; human answers as durable decision records; drift observations with classification and
lifecycle; corrective-work proposals; verification of arbitrary (non-FeltKit) repositories; any
end-user screens for the above. FeltKit's `DecisionSpec` is a model choosing among options, not a
person answering a question (`agent.ts:205-226`). FeltDB `Intent` and `Proposal` are specific to
FeltDB application contracts and are not reused.

---

## 3. Architecture

```
  People (browser)                                   Agents (any MCP client)
        │ FeltKit session                                   │ AuthBoundry agent credential
        ▼                                                   ▼
 ┌──────────────── Boundry application (FeltKit, one process) ─────────────────────────┐
 │ UI: Build view · Questions · Outcome Integrity · History (React, live queries)       │
 │ Human functions (FeltKit mutations)          Agent capabilities (M0.1 gateway, /mcp) │
 │        │  authority: AuthBoundry for human decisions (D6)   authority: AuthBoundry    │
 │        └───────────────┬──────────────────────────────────────┘                      │
 │              Build core (one module: every rule, used by both surfaces)              │
 │   sessions · outcomes · baselines · work · questions · decisions · drift · evidence  │
 │                          │ FeltDB (one instance)                                     │
 │ Verifier (deterministic): runs declared acceptance checks at a commit via compute,   │
 │   records receipts and PASS/DRIFT/UNKNOWN evaluations                                │
 └───────────────────────────────────────────────────────────────────────────────────────┘
```

Rules that hold everywhere:
- **One build core.** All state rules live in one module over FeltDB. FeltKit mutations (people) and
  gateway capabilities (agents) both call it; neither surface re-implements a rule.
- **Two front doors, two identity sources, one authority.** People authenticate through FeltKit; agents
  through AuthBoundry credentials. AuthBoundry decides authority for both (D6 for people).
- **Decision capabilities do not exist on the agent surface.** Recording a decision, changing a
  baseline, accepting an outcome or changing a security/authority boundary are human-surface functions
  only. Agents can recommend; no grant or delegation can make an agent's recommendation a decision.
- **The UI is a projection.** Every screen reads durable records; nothing is stored only in the UI.
- **Boundry runs no inference.** Drafting requirements, implementing, judging ambiguity and semantic
  review are done by agents through MCP. Boundry's own logic is deterministic: rules, assembly,
  verification runs, status computation.

---

## 4. Domain model

| Record | Built on | Status | Purpose |
|---|---|---|---|
| `BuildSession` | new (FeltDB collection) | Missing | The ongoing build: title, owners (human principals), participants, repository reference, state (`active / paused / delivered / abandoned`) |
| `Outcome` | new, thin | Missing | An intended result; groups its acceptance criteria; state `proposed / active / verified / accepted / delivered / superseded` (derived where possible, §6) |
| Acceptance criterion, constraint | FeltDB architecture invariant, `scope` = session id, `category` = `acceptance` or `constraint` | Reuse (verified) | Versioned declaration plus how it is verified |
| `OutcomeBaseline` | new, append-only | Missing | Snapshot: version n = the set of {outcome, criterion id, criterion version} active, created by a decision id. v1 is the original intent |
| Work | FeltDB agent task / checkpoint / handoff, `scope.project` = session id | Reuse (verified) | What is being done, by whom; checkpoints cite commits and the baseline version worked from |
| Agent technical choice | FeltDB checkpoint `decisions[]` | Reuse | Reversible, routine choices with rationale; never shown as a human decision |
| `BuildQuestion` | new | Missing | Issue, why it matters, evidence refs, affected outcomes and criteria, alternatives with consequences, optional recommendation (by whom), blocking (task ids or none), required authority, impact fields, state |
| `BuildDecision` | new, append-only | Missing | Question, chosen direction, rationale, rejected alternatives, evidence refs **with versions at decision time**, decided by (human principal), AuthBoundry decision id, resulting changes (baseline version, tasks) |
| Verification evaluation | FeltDB invariant evaluation (`PASS / DRIFT / UNKNOWN` per criterion version) + compute receipt | Reuse | What was verified, at which commit, by which method |
| `DriftObservation` | new, over evaluations | Missing | Discrepancy with provenance, affected outcomes, severity, evidence, classification (`accidental / accepted_deviation / proposed_intent_change / unverified`), state, corrective task |
| Invocation evidence | M0.1 evidence store | Code | Who did what, under which AuthBoundry decision |

`FeedbackResponse` is not needed: a person's answer **is** a `BuildDecision`. Questions can carry
comments later if review shows a need.

Prioritising questions uses explicit fields people can see (`impact`, `reversible`, `blocking`,
`affects_accepted_outcome`), sorted by a stated rule. No invented score.

---

## 5. Who decides what (enforced, not advisory)

| Situation | Behaviour | Enforcement |
|---|---|---|
| Routine work within constraints | Agent proceeds | Agent capabilities |
| Reversible technical choice | Agent decides, records rationale | Checkpoint `decisions[]` |
| Material ambiguity, scope change, change to an accepted outcome | Agent asks | `question.ask`; only a human function creates a new baseline |
| Conflict with an explicit constraint | Affected work stops; ask | Drift rule marks affected tasks `blocked` (FeltDB task status) |
| Security or authority boundary change | Explicit human approval | Not on the agent surface; AuthBoundry grants are human-administered |
| Valuable improvement found | Recommendation with alternatives | `question.ask` with `recommendation` |
| Failing test or defect | Agent corrects within scope | Corrective task inside the current baseline; no question |
| Insufficient evidence | Criterion stays unverified | Status is computed from evaluations, never set by an agent |

Which situations are material is judged by agents (that is reasoning). What happens next is
deterministic.

---

## 6. Status and the Outcome Integrity view

Status values are computed from records, never entered:
- **Criterion status at baseline version n:** the latest evaluation of the criterion version in
  baseline n, per required verification method. All `PASS` → `verified`; any `DRIFT` → `drift`;
  otherwise `unverified`.
- **Outcome:** `verified` when all its criteria in the current baseline are verified; `accepted` when a
  human acceptance decision names that baseline version and those evaluation ids.
- **The only progress figure shown:** "k of m acceptance criteria verified at baseline vN", with each
  criterion linking to its evaluations and receipts.

Outcome Integrity view: per outcome and criterion, the current version, the previous versions, the
latest evaluation per method with its commit and receipt, open drift, open questions and decisions
that changed it.

---

## 7. Drift detection and corrective action

Deterministic rules (Boundry runs them; no inference):
1. **Claimed without evidence:** a task completed against a criterion that is not `verified` at the
   current baseline.
2. **Superseded intent:** work whose checkpoint cites a baseline version older than the current one
   for a criterion that changed.
3. **Verification failure:** a declared automated check fails at the commit the agent cited → `DRIFT`.
4. **Constraint failure:** a constraint's automated check fails.
5. **Unowned change:** a commit in the session's repository not cited by any task (scope expansion
   signal; classified by a person or an agent as accidental or proposed change).

Semantic drift (code does something the outcome didn't intend, with no failing check) is reported by
agents as advisory evaluations or questions, through the same records.

Corrective loop: observation → evidence and affected outcomes shown → corrective task proposed. If the
fix stays inside the current baseline (rule 1, 3, 4), the task is created and offered to agents
without asking. If it implies changing intent (classification `proposed_intent_change`), it becomes a
question. A criterion leaves `drift` only through a new `PASS` at the current version. Boundry never
edits a baseline to match the code.

---

## 8. The FeltKit application

Screens (React, FeltKit live queries; every screen reads durable records):
1. **Start a build:** outcome statement, initial criteria and constraints (people can add; agents can
   propose via questions). Creates baseline v1.
2. **Build view (central):** open questions first (blocking ones on top), then outcomes with computed
   status, active work and who holds it, recent decisions and drift.
3. **Question:** issue, evidence, alternatives and consequences, recommendation and who made it; the
   person chooses or writes a direction plus rationale → decision; shows resulting changes.
4. **Outcome Integrity:** §6.
5. **History:** baseline versions side by side, decisions, drift and their resolutions, in time order.
6. **Accept:** accept an outcome at a baseline version, naming the evaluations relied on.

Studio stays an operator tool; it cannot host application screens.

---

## 9. Decisions needed before the slice

> **Owner directions, 2026-11-16 (recorded; not implementation authorization):**
> - **D6:** FeltKit authenticates the person; AuthBoundry establishes whether that person has authority
>   to make the decision; both identities are preserved in the record.
> - **D7:** investigate the smallest FeltKit change that hosts the gateway with one FeltDB. Do not
>   implement it without the FeltKit repository owner's approval. No second authority; do not assume
>   Managed FeltDB solves it.
> - **D8:** non-production compute only; no customer execution on the shared Boundry platform host; no
>   durable-workspace claim before the persistence gate passes.
>
> **Review of revision 4, acknowledged, to be incorporated in revision 5 (P1 not approved yet):**
> verification bound to one exact implementation (repository, commit, criterion and baseline versions,
> check definition and environment); a real identity-binding contract for D6 proven end to end; a
> minimal shared-process proof for D7 before any application work; `unverified / superseded / drift /
> unattributed` kept distinct; a consistency contract for decisions, baselines and work (atomic or
> idempotent transitions, concurrency checks, reconciliation of external decisions); an honest local
> verification boundary; acceptance bound to a commit or artifact digest; starting a build from a rough
> outcome; question blocking limited to the asking agent's own or authorized tasks; the Build Core as
> the only place state transitions happen.

**D6 — Human identity for decisions.** AuthBoundry is not an OIDC issuer, so FeltKit cannot use it
for sign-in today, and under `agent_required` AuthBoundry refuses a check that merely names a human.
- (a) **Recommended for the slice:** FeltKit authenticates the person (FeltKit account or OIDC); an
  operator binds that account to an AuthBoundry human principal; each decision asks AuthBoundry as the
  application's executor **on behalf of** that principal (`ctx.authority.decide`, existing), which
  requires the person's live delegation to the application. The record states both facts:
  identity established by FeltKit, authority decided by AuthBoundry (decision id).
- (b) Later: AuthBoundry as the identity provider for people (OIDC issuer or session introspection),
  so identity and authority both come from AuthBoundry. Requires AuthBoundry work.

**D7 — One process, one FeltDB.** A local FeltDB store has one owner (`owner.lock`), and FeltKit has
no way to mount another request handler (`app.ts` offers collections, functions, events, surfaces,
integrations). Options:
- (a) **Recommended:** a small FeltKit extension that mounts an external request handler at a path,
  with the app's FeltDB instance; the M0.1 gateway runs there. Contained change, needs the FeltKit
  owner's approval.
- (b) Both processes use one Managed FeltDB over HTTP. Unverified; adds a hosted dependency.
- (c) The gateway calls the FeltKit app as a trusted service. Rejected: FeltKit roles plus gateway
  assertions would make two authorities.

**D8 — Where verification runs for the slice.** Verification executes the customer's code. Until an
execution host exists (D1) and the persistence gate passes, verification runs only on a
non-production machine via compute's local runner, producing receipts. No customer-facing hosting.

---

## 10. Milestones

Two tracks. Product slices depend on named foundation items only.

**Foundation (infrastructure)**
| | Item | State |
|---|---|---|
| F0 | M0.1 authority and evidence gateway (approved scope) | In progress; tests and report pending |
| F1 | Shared process and state (D7) | Decision |
| F2 | Human decision authority (D6a) | Decision; uses existing `ctx.authority` |
| F3 | Verifier: run declared checks at a commit via compute locally; receipts → evaluations | New, small |
| F4 | Workspace persistence gate (unchanged from the earlier plan) | Required before Boundry-hosted computers |
| F5 | OAuth / client onboarding; AuthBoundry as human identity provider (D6b) | Later |

**Product (user-visible)**
| | Item | Depends on |
|---|---|---|
| P1 | **Interactive build loop slice** (§11) | F0, F1, F2, F3 |
| P2 | Rules 2 and 5, multiple sessions, participants, question comments | P1 |
| P3 | Scoped independent review as a verification method | P1 |
| P4 | Boundry-hosted workspaces for agents | F4, D1 |
| P5 | Browser and selected integrations | P1 |

No console polish, integration catalogue or extra workflows before P1 passes.

---

## 11. Smallest end-to-end slice: P1, the interactive build loop

**Scope:** one Build Session, one repository (a small real project with real tests, on a
non-production machine), one person (Ada), two agent principals on two different MCP clients, one
outcome with three acceptance criteria and one constraint, drift rules 1, 3 and 4.

**Agent capabilities** (M0.1 gateway, AuthBoundry-gated, evidenced): `build.session.get`,
`build.outcomes.list` (criteria, versions, computed status), `work.task.list / claim / checkpoint /
complete` (checkpoint cites commit and baseline version), `build.question.ask / get`,
`build.decisions.list`, `build.drift.list`.

**Human functions** (FeltKit, AuthBoundry-authorized per D6a): `session.create`, `criterion.add /
revise` (only via a decision once the baseline exists), `question.answer` → decision,
`drift.classify`, `outcome.accept`.

**Deterministic jobs:** verifier on `work.task.complete` (F3); drift rules on each new evaluation and
checkpoint; corrective task creation for in-baseline drift.

**Acceptance test (automated where possible; scripted agents make real commits; one run also
recorded with two real agent clients):**
1. Ada starts a session in the app with an outcome, three criteria (each with an automated check)
   and one constraint → baseline v1.
2. Agent A (client 1) reads the outcomes over MCP and claims the first task.
3. A makes real commits and checkpoints them.
4. A hits an ambiguity and asks a question with two alternatives, consequences and a recommendation,
   marking one task blocked; A continues on an unaffected task meanwhile.
5. The question appears in Ada's Build view with its evidence.
6. Ada chooses an alternative with a rationale in the app.
7. A `BuildDecision` records it with Ada's principal and AuthBoundry decision id; baseline v2 revises
   one criterion; v1 remains readable; the earlier pass on that criterion now counts as unverified.
8. Agent B (client 2, no access to A's conversation) claims the blocked task, reads the decision over
   MCP and implements it.
9. A seeded discrepancy (a commit violating a criterion) makes the verifier record `DRIFT`.
10. Boundry shows the evidence and affected outcome and creates a corrective task inside the baseline.
11. An agent fixes it; the verifier records `PASS` at the new commit; status becomes verified only then.
12. Ada inspects the history (v1 vs v2, the decision, the drift and its resolution) and accepts the
    outcome at v2, naming the evaluations. An agent attempting any decision, baseline change or
    acceptance is refused and recorded.

---

## 12. Risks

- **Human identity (D6).** In the slice, people's identity comes from FeltKit and their authority from
  AuthBoundry. That is a split until D6b; every decision record says which system established what.
- **One owner of state (D7).** Without the FeltKit extension, people and agents cannot share one local
  FeltDB store. The fallback (Managed FeltDB) is unverified.
- **Decisions vs recommendations.** Enforced by keeping decision functions off the agent surface. A
  delegation in AuthBoundry cannot widen the agent surface; this needs a test, not just a convention.
- **Self-reported progress.** Agents' completion claims never change status; only verifier evaluations
  do. Checks Boundry cannot run stay `UNKNOWN` until a person reviews them (`human-review`).
- **Executing customer code.** The verifier runs repository code; local, non-production only until D1
  and F4. compute's process runner is not a sandbox.
- **Reusing invariants for acceptance criteria.** The semantics fit (versioned declaration, verification
  methods, evaluations), but the name is "architecture invariant" and its optional authorization gate
  must be wired to AuthBoundry-gated functions. If the fit proves wrong in P1, criteria get their own
  records with the same pattern.
- **AuthBoundry resource scoping per session** (capability + `{type: build_session, id}`) is unverified.
- **FeltKit is preview (0.3.30)** and gains one extension (D7a).
- **Materiality is judged by agents.** A poorly behaved agent may not ask. Drift rules 1, 3 and 4 catch
  the verifiable cases; the rest relies on review (P3) and people reading the history.
