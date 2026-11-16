# Continuity and Independent Verification — Architecture Assessment

Status: **assessment and plan.** Companion to [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md).
Audit date: 2026-11-16. Inputs: `rkendel1/elephant-goldfish-model` at `403d888` (fork of `google/elephant-goldfish-model`),
inspected **as a design reference only** (see §2), `@feltdb/core@0.21.0` (published package; source repo not accessible),
`rkendel1/feltkit` at `b0cfa6a`.

Evidence levels as in the plan: **Verified** (ran it), **Tested** (repo tests exist), **Code**, **Doc**.

---

## 1. Conclusion

- **Continuity already exists in FeltDB and works.** `@feltdb/core` agent state (tasks, immutable
  checkpoints, scoped memory, leased handoffs, bounded context assembly) carried a task from one
  agent to another across a process restart, from durable state alone. **Verified** (`probes/feltdb-continuity.mjs`).
- **Independent verification does not exist anywhere in the stack**, and FeltDB's one context
  operation is the wrong one for it: the resumed bundle contains the originating agent's
  unratified `decisions` and its `assumption` memories. **Verified.** A reviewer loaded that way
  is not a Goldfish.
- **EGM is a method with weak durability.** Findings are free-text normalized into markdown;
  resolution decisions are held "in an internal memory checklist" (`skills/egm-resolve/SKILL.md:170`);
  isolation is proven only in test fixtures, and on cloud surfaces the probe returns UNKNOWN
  (`TESTING.md:126-129`). EGM itself states that child-written receipts cannot substitute for tool
  records (`TESTING.md:155-158`).
- **What Boundry adds** is not prompts. It is (1) a second context operation, verification
  assembly, that excludes originating context by construction; (2) durable Review, Finding,
  Resolution and Decision records with EGM's resolution rules enforced deterministically; and (3)
  isolation evidence that comes from the boundary, not from the reviewer's self-report.

---

## 2. EGM's role: reference only

**EGM is a design reference, not a dependency.** No EGM skill, prompt, rubric, file or harness
integration is used, packaged or referenced by Boundry. It informed which failure modes to design
for and which rules are worth enforcing. Boundry Continuity must work for **any** MCP-capable agent, model,
environment and stack; no part of the lifecycle may assume a particular harness.

| Layer | Owns | Examples |
|---|---|---|
| **Boundry primitives** | State, authority, context assembly, evidence, rule enforcement | Intent, Knowledge, Decisions, Work, Verification records; continuity vs verification assembly; isolation evidence |
| **Review method inputs** (data, not code) | What a reviewer is asked to check | Reviewer instructions and checklists stored as versioned artifacts the customer owns and edits; Boundry ships a minimal default set written for Boundry |
| **Agents** (any runtime, replaceable) | Doing the work | Any client that drafts, reviews or resolves through the `work.*` and `review.*` capabilities |

Rule: Boundry's records never depend on how a reviewer was prompted. A review run references its
method inputs as artifacts by digest, so the method can change without a Boundry change, and every
review records exactly which inputs it ran with.

---

## 3. Lessons taken from EGM (concepts only; nothing reused)

| EGM concept | Where it is | Boundry decision |
|---|---|---|
| Elephant / Goldfish / Human roles | README, `architecture.md` | **Primitive.** Distinct AuthBoundry principals and context boundaries (§5) |
| Personas, rubrics, stage pipeline | `agents/`, `resources/`, `review.md` | **Not used.** Boundry's own method inputs are customer-owned artifacts (§2) |
| Severity: Blocker / Major / Nit | `agents/synthesizer.md:12` | **Adopt** as the finding severity enum |
| Resolution categories: PROPOSE FIX, CONTEST, ESCALATE, DECLINE | `review.md`, `egm-resolve` | **Primitive, enforced.** These rules are deterministic, so Boundry enforces them: a CONTEST must cite evidence the reviewer could read (checked against the review bundle); comprehension gaps cannot be contested; severity changes need a contest; ESCALATE needs a human decision |
| Failed reviewer = `not run`, never zero findings | `synthesizer.md:40` | **Primitive.** Reviewer execution status; a run with a `not_run` reviewer is not clean |
| Round rules: settled findings stay settled, a fixed finding re-opens if raised again, clean = no unsettled Blocker/Major, stop after 2 clean rounds or at 5 | `review.md` "Iteration" | **Computed by Boundry** from durable rounds (deterministic); the loop itself stays agent-side |
| `concepts_brief.md`, `design_draft.md`, `docs/designs/*.md` | skills | **Artifacts** in the repository, registered by path + digest. The repo stays the home of design text; Boundry records versions and links |
| Markdown review report (`goldfish_review_report.md`) | synthesizer | **Lesson:** a report is a projection rendered from Finding records, never the authority |
| Drift report | `egm-drift-report` | **Lesson, split.** Deterministic part (referenced paths/symbols exist at a source tree digest) is a Boundry check; semantic divergence is a review run of kind `drift` producing findings |
| Isolation probe on native transcripts | `tests/integration/test_claude.py`, `TESTING.md` | **Adopt the principle**, move it to runtime: canary-based exclusion test (§6) |
| "Elephant does not add context only a zero-context reviewer needs" | `review.md` ESCALATE | **Primitive.** The verification bundle contains only declared sources; the originator cannot inject explanation |

---

## 4. Two context operations

| | Continuity | Independent verification |
|---|---|---|
| Purpose | Let the next agent continue | Let a reviewer challenge the work |
| Includes | Task, latest checkpoint (summary, pending work, constraints, decisions), evidence, scoped memories, recent checkpoints, handoff note | Target artifact at a digest; sources it explicitly references, at digests; the method inputs (persona, standard) at digests; **ratified** decisions (human-approved Decision records) the target cites |
| Excludes | Nothing relevant | Checkpoint summaries and agent decisions, memories (assumptions included), recent history, handoff notes, transcripts, the originating conversation |
| Exists today | **Yes** — FeltDB `resume` / `assembleContext` (`feltdb.agent-context@1`). Verified | **No.** New: `verification.assemble` |
| Recorded | Handoff + claim (FeltDB) | Bundle manifest + digest on the Review record |

Why ratified decisions are in scope: EGM allows a contest to cite "a decision recorded in the
document". A human-approved decision is an input to the design; an agent's unratified checkpoint
decision is exactly the assumption under review.

Placement: build `verification.assemble` in this repository against the FeltDB agent-state contract
first; propose it upstream to FeltDB as the sibling of `assembleContext` once AT-2 passes.

---

## 5. Records and relationships

Existing records are used as-is. New records are few and narrow. Names avoid three existing
collisions: FeltKit `decisions.ts` (model choices), FeltDB checkpoint `decisions: string[]`
(agent notes), and FeltDB `Intent` / `Proposal` (application-contract changes: flow hashes, module
and billing targets). These must not be overloaded.

| Concept | Record | Status |
|---|---|---|
| Intent | **`WorkIntent`** — goal, requirements, constraints, acceptance criteria, human owner, status | **New** (FeltDB `Intent` is application-contract specific) |
| Knowledge | FeltDB `AgentMemory` with `kind ∈ {fact, assumption, unknown}`, source, evidence refs; `supersede` / `invalidate` with reason | **Exists** (kinds are a convention + validation). FeltDB `application-understanding` already models evidence / inference / unknown / assumption with confidence for application facts |
| Decisions | **`WorkDecision`** — question, options, chosen, rationale, rejected alternatives, evidence refs, findings addressed, decided_by (human principal), AuthBoundry decision id proving that authority, supersedes | **New** |
| Work | FeltDB `AgentTask` / `AgentCheckpoint` / `AgentHandoff`; FeltKit change sets (verified by FeltKit, not the model); compute sessions; artifacts by digest | **Exists** |
| Verification | **`ReviewRun`**, **`ReviewerExecution`**, **`Finding`**, **`Resolution`** | **New** |

```
WorkIntent ──1:n── AgentTask ──1:n── AgentCheckpoint (immutable)
    │                 │  └── AgentHandoff (continuity)
    │                 └──── AgentMemory (fact | assumption | unknown)
    │
    ├── Artifact@digest  (design, plan, code tree, test result)
    │        │
    │     ReviewRun (kind: design | readiness | drift; round n; bundle digest; isolation level)
    │        ├── ReviewerExecution (principal, method artifact digests, status completed | not_run,
    │        │                       reads, generation receipt input digest when constructed)
    │        └── Finding (severity, claim, location artifact@digest+range, evidence refs)
    │                 └── Resolution (PROPOSE_FIX | CONTEST | ESCALATE | DECLINE,
    │                                 cited evidence ⊆ bundle, by principal)
    │
    └── WorkDecision (decided_by human, resolves findings, invalidates/ supersedes memories,
                      becomes a constraint on tasks, cited by the next artifact version)
```

Every write is a capability invocation, so each already gets an AuthBoundry decision and a
invocation evidence record (plan W-U4a, joined in W-U4b). The records above are the *meaning*; the evidence join is
the *proof of who did what*.

Authority rules (AuthBoundry grants, enforced at invocation):
- `work.decision.record` — humans only. An agent may propose (as a Resolution), never decide.
- `review.read` — granted to a reviewer principal for one ReviewRun's bundle only.
- `continuity.read` (`resume`, memories, checkpoints) — **never** granted to a reviewer principal.

---

## 6. Enforcing and evidencing fresh context

Boundry cannot see inside a client's context window. It can control what reaches the reviewer
through Boundry, who the reviewer is, and in the strongest case the reviewer's entire input.
Claims are graded, never rounded up:

| Level | How | What it proves | What it does not |
|---|---|---|---|
| **asserted** | Client reports it used a fresh sub-agent (how prompt-based methods work today) | Nothing beyond the claim; recorded as unverified | Freshness |
| **scoped** | Reviewer is a separate AuthBoundry principal with a review-scoped delegation; continuity reads denied; every read recorded | The reviewer could not obtain originating context **through Boundry**, and exactly which bundle items it read | That the client didn't put context in the prompt (e.g. a Claude Code subagent shares its parent's process, MCP connection and credential, so it cannot even be a separate principal) |
| **constructed** | Boundry builds the reviewer's entire input: (a) a direct model call via FeltKit generation, recording `GenerationReceipt.inputDigest`; or (b) any agent program run in a compute session whose workspace holds only the bundle's sources, with the starting prompt digest, workspace tree digest and egress policy recorded | Freshness by construction for that run | Review quality, or that every item was fully read (EGM: a successful read result is not proof the whole resource was read) |

Runtime-level canary test (adopted from EGM's isolation probe): the originating checkpoint and a
memory carry a unique canary string; for `constructed` runs, the recorded input must not contain it
(checked against the stored bundle preimage); for `scoped` runs, no recorded read may return it.

By how the reviewer runs (any agent, model or stack; none is privileged):

| Reviewer runs as | Best achievable level | Note |
|---|---|---|
| A sub-agent inside the originating agent's own process | asserted | Shares the originator's process, connection and credential, so Boundry cannot tell it apart |
| Any MCP client as a separate principal | scoped | Needs its own agent credential and a review-scoped delegation |
| Any agent CLI or program started by Boundry in a compute session holding only the bundle's sources | constructed (b) | Runtime-neutral: Boundry records the starting input, workspace digest and egress policy. Needs W-C2; microVM for enforced egress |
| A model call Boundry makes itself | constructed (a) | Any provider or model via Resolver model refs and FeltKit generation; Boundry pays for the inference |

**Scoped review is the baseline, available to any MCP-capable agent.** Any separately authenticated
reviewer can receive a Boundry-assembled bundle, read it, submit findings and take part in
resolution. Its records state the guarantee exactly: Boundry proves what it exposed, what the
reviewer read through Boundry and what it denied; it cannot prove what the reviewer already knew or
what its client injected.

**Constructed review is an optional higher-assurance mode.** Boundry controls the reviewer's whole
input or execution environment, and input and workspace digests establish what was supplied. It
requires Boundry to run or launch inference, so it must never become a dependency of ordinary review
or of the product's operation. A customer may require it for designated approvals; the product works
without it.

**Asserted** (an in-process sub-agent) is accepted only as advisory and labelled on every Finding.

---

## 7. Possible today vs new work

| Capability | Today | New |
|---|---|---|
| Cross-agent continuation (task, checkpoint, handoff, resume) | FeltDB agent state — **Verified** | Expose as `work.*` capabilities; bind actors to AuthBoundry principals (currently free strings) |
| Knowledge with provenance, supersede/invalidate | FeltDB memory — **Verified** (write/read); invalidate not exercised | `kind` validation; link invalidation to a Finding/Decision |
| Verified test/build evidence | FeltKit change sets `verified` state — **Tested** | Use in AT-2 for implementation evidence |
| Human approval of consequential actions | FeltKit `awaiting_approval` — **Tested** | Reuse for `WorkDecision` |
| Per-call authority + decision ids | AuthBoundry via FeltKit — **Tested** | Reviewer principal + review-scoped delegation (exists as a mechanism: capability + resource scope) |
| Input digest of a model call | FeltKit `GenerationReceipt.inputDigest` — **Code** | Wire into ReviewerExecution |
| Isolated reviewer workspace | compute sessions — **Tested** | Bundle-only checkout; egress lock (plan W-C2) |
| Verification context assembly | — | **`verification.assemble`** |
| Review / finding / resolution / decision records + rule enforcement | — | **New records**, deterministic rule checks |
| Deterministic drift check | FeltDB `ArchitectureInvariant` + evaluations (Code; general invariants) | Reference-existence check of design artifacts at a tree digest |
| Semantic drift | — | Any agent performs a `drift` ReviewRun over the verification bundle and records Findings |

Not built (scope guard): no orchestration engine for review stages, no prompt library, no agent
runtime beyond the existing compute session and FeltKit generation call, no general workflow DSL.

---

## 8. Acceptance tests

**AT-1 — Cross-agent continuation** *(preserved; stated explicitly here because no prior text of
it exists in the repositories)*
1. Agent A (any MCP client, principal `A`) works in a persistent computer, checkpoints with decisions,
   evidence and memories, and creates a handoff to principal `B`.
2. `A`'s credential is revoked.
3. Agent B (a different client, model or stack, principal `B`) connects, claims the handoff and resumes
   from durable state only: same workspace (files and git state by tree digest), same objective,
   pending work, constraints and evidence.
4. B's subsequent work is attributed to `B`; any further call by `A` is refused and recorded.
Depends on the M1 persistence gate for step 3's workspace check. Partial evidence today: steps 1 and 3
at the FeltDB layer only (`probes/feltdb-continuity.mjs`).

**AT-2 — Independent review, scoped, through an external MCP client** *(M2 gate)*
1. Agent A drafts `docs/designs/x.md` (digest D1). Its checkpoint records decision `d1` and an
   assumption memory, both containing canary `C`.
2. A requests review. Boundry assembles a verification bundle (target D1 + referenced sources +
   method artifacts) and records its manifest and digest. Assert: the bundle holds no checkpoint,
   memory or handoff content, and `C` is absent.
3. Reviewer R is a **separate MCP client** (a different client implementation from A's) with its own
   agent credential and a review-scoped delegation. R reads bundle items through `review.*`; every read
   is recorded. R's attempts to call `work.resume`, read memories or read A's checkpoints are refused by
   AuthBoundry and recorded. No recorded read returns `C`.
4. The ReviewRun records isolation level `scoped` and the guarantee text: what was exposed, read and
   denied; client-side context not provable.
5. One reviewer is forced to fail: it is recorded `not_run`, and the round is not clean.
6. R submits findings with severity and location. A attempts to CONTEST one citing a source **outside**
   the bundle → refused. A CONTEST citing a bundle source → accepted. A attempts to record a
   `WorkDecision` → refused (agents cannot decide).
7. Human H resolves the escalated item and records decisions; each carries H's principal and an
   AuthBoundry decision id. The refuted assumption memory is invalidated with a link to the Finding.
   A revises the design to D2.
8. Agent C (a third client, never involved, principal `C`) retrieves through MCP only: the WorkIntent,
   D1 and D2, the ReviewRun with bundle manifest and isolation level, every Finding and Resolution, the
   Decisions with who decided, the invalidated memory, and the evidence records.

**AT-2C — Constructed review** *(optional; when the execution path exists)*
Same as AT-2 steps 1–2 and 5–8, but Boundry constructs R's entire input (a model call with a recorded
`inputDigest`, or an agent program in a compute session holding only the bundle). Assert: the recorded
input is derived from the bundle alone and does not contain `C`; the ReviewRun records level
`constructed`. Turning this mode off must not break AT-2.

---

## 9. Changes to the implementation plan

- **M2 — Durable work and independent review**: `work.*`, `knowledge.*`, `intent.*`, `decision.*`,
  `review.*` over FeltDB agent state and the new records; `verification.assemble`; exit = AT-1 and
  AT-2 (scoped), with at least two distinct agent clients. AT-2C optional.
- Constructed review never becomes a required path; its compute variant also waits for W-C2.
- AuthBoundry: no new mechanism; new grants `review.read`, `continuity.read`, `work.decision.record`.

## 10. Risks and unknowns

- `@feltdb/core` source not audited; agent state verified only through its published build.
- Agent-state actors are free strings; binding them to AuthBoundry principals is required before
  AT-1 step 4 can be meaningful.
- Scoped review cannot prove what a reviewer's client injected. This is stated on every scoped
  record rather than hidden.
- Constructed review, where used, makes Boundry pay for and govern inference (cost, model choice,
  credential custody). It is optional by design.
- Isolation evidence proves what the reviewer received, not that the review was good. Findings
  quality remains a human judgment.
