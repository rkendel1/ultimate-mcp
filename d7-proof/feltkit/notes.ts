/**
 * Notes: the disposable domain for the D7 proof. Every write goes through these FeltKit functions, on the
 * runtime's one FeltDB instance, in one atomic mutation transaction each.
 *
 * Optimistic concurrency is explicit: an update names the version it read (`expectedVersion`). Inside the
 * mutation, FeltKit also fences the read: if another mutation commits between this mutation's read and its
 * commit, FeltDB rejects the commit (CONFLICT) and nothing is written.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, evidence, GATEWAY, notes } from "./app.js";

/** Proof-only fault injection (server-side environment, never caller-controlled). See test/d7-fail-closed.test.ts. */
const fault = (name: string) => (process.env.D7_PROOF_FAULT ?? "").split(",").includes(name);

/** Proof-only: hold a mutation between its read and its write so two callers can race deterministically. */
const hold = (ms: number | undefined) => (ms && ms > 0 ? new Promise((r) => setTimeout(r, Math.min(ms, 3000))) : Promise.resolve());

const Note = s.object(
  {
    id: s.string(), text: s.string(), updatedAt: s.number(), actor: s.string(), actorBasis: s.string(),
    feltkitPrincipal: s.string(), authorityDecisionId: s.nullable(s.string()), __version: s.number(),
  },
  { additionalProperties: true },
);

/** Human only: the gateway's role does not hold notes.create. */
export const create = app.mutation({
  access: "notes.create",
  args: { text: s.string({ minLength: 1, maxLength: 2000 }) },
  returns: s.string(),
  handler: async (ctx, { text }) => {
    const principal = ctx.auth.requirePrincipal();
    if (principal.type !== "user") fail("FORBIDDEN", "Only a person creates notes.");
    return ctx.db.insert(notes, {
      text, updatedAt: Date.now(),
      actor: principal.id, actorBasis: "feltkit_session", feltkitPrincipal: principal.id, authorityDecisionId: null,
    });
  },
});

/** People and the agent surface. */
export const get = app.query({
  access: "notes.read",
  args: { id: s.string() },
  returns: Note,
  handler: async (ctx, { id }) => {
    const note = await ctx.db.get(notes, id);
    if (!note) fail("NOT_FOUND", "No such note.");
    return note;
  },
});

/** A person's update, fenced on the version they read. */
export const update = app.mutation({
  access: "notes.write",
  args: { id: s.string(), text: s.string({ minLength: 1, maxLength: 2000 }), expectedVersion: s.number(), holdMs: s.optional(s.number()) },
  returns: s.object({ id: s.string(), version: s.number() }),
  handler: async (ctx, { id, text, expectedVersion, holdMs }) => {
    const principal = ctx.auth.requirePrincipal();
    if (principal.type !== "user") fail("FORBIDDEN", "This update is for people; agents use the gateway.");
    const note = await ctx.db.get(notes, id);
    if (!note) fail("NOT_FOUND", "No such note.");
    if (note.__version !== expectedVersion) fail("FAILED_PRECONDITION", `Stale: the note is at version ${note.__version}, not ${expectedVersion}.`, { current: note.__version });
    await hold(holdMs);
    const updated = await ctx.db.patch(notes, id, { text, updatedAt: Date.now(), actor: principal.id, actorBasis: "feltkit_session", feltkitPrincipal: principal.id, authorityDecisionId: null });
    return { id, version: updated.__version };
  },
});

/**
 * An agent's update, through the gateway component only. The agent actor is ASSERTED by the component after
 * AuthBoundry authenticated and authorized the call (C0). This function trusts that assertion only because
 * FeltKit verified the caller is the gateway component; it records FeltKit's principal from ctx.auth itself.
 *
 * The note change and its outcome evidence commit together in this one mutation, or not at all.
 */
export const updateFromAgent = app.mutation({
  access: "notes.agentWrite",
  args: {
    id: s.string(),
    text: s.string({ minLength: 1, maxLength: 2000 }),
    expectedVersion: s.number(),
    actor: s.string({ minLength: 1, maxLength: 200 }),
    authorityDecisionId: s.string({ minLength: 1 }),
    correlationId: s.string({ minLength: 1 }),
    outcome: s.record(s.unknown()),
    holdMs: s.optional(s.number()),
  },
  returns: s.object({ id: s.string(), version: s.number() }),
  handler: async (ctx, args) => {
    const principal = ctx.auth.requirePrincipal();
    if (principal.id !== GATEWAY) fail("FORBIDDEN", "Agent actors are accepted only from the agent gateway component.");
    const note = await ctx.db.get(notes, args.id);
    if (!note) fail("NOT_FOUND", "No such note.");
    if (note.__version !== args.expectedVersion) fail("FAILED_PRECONDITION", `Stale: the note is at version ${note.__version}, not ${args.expectedVersion}.`, { current: note.__version });
    await hold(args.holdMs);
    const updated = await ctx.db.patch(notes, args.id, {
      text: args.text, updatedAt: Date.now(),
      actor: args.actor, actorBasis: "component_asserted_after_authboundry", feltkitPrincipal: principal.id, authorityDecisionId: args.authorityDecisionId,
    });
    await ctx.db.insert(evidence, {
      correlationId: args.correlationId, phase: "outcome", recordedAt: Date.now(), tool: "notes_update", capability: "notes.update",
      record: { ...args.outcome, result: { status: "completed", error_code: null, reference: `note:${args.id}@${updated.__version}` } },
      feltkitPrincipal: principal.id,
    });
    if (fault("atomic-update")) fail("UNAVAILABLE", "Injected failure after the note and its evidence were staged (proof).");
    return { id: args.id, version: updated.__version };
  },
});
