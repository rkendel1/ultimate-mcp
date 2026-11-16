/**
 * Evidence functions for the agent surface. Records are only ever inserted (FeltKit inserts are `requireAbsent`
 * creates); no function updates or deletes them. Each record carries FeltKit's own view of the caller
 * (`feltkitPrincipal`, from ctx.auth) beside the component-reported content, so the two are never confused.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, evidence, GATEWAY } from "./app.js";

const fault = (name: string) => (process.env.D7_PROOF_FAULT ?? "").split(",").includes(name);

const recordArgs = {
  correlationId: s.string({ minLength: 1 }),
  tool: s.nullable(s.string()),
  capability: s.nullable(s.string()),
  record: s.record(s.unknown()),
};

function gatewayOnly(ctx: { auth: { requirePrincipal(): { id: string } } }) {
  const principal = ctx.auth.requirePrincipal();
  if (principal.id !== GATEWAY) fail("FORBIDDEN", "Only the agent gateway component writes agent evidence.");
  return principal;
}

/** Committed BEFORE the agent's protected work executes. */
export const recordAuthorized = app.mutation({
  access: "evidence.write",
  args: recordArgs,
  returns: s.string(),
  handler: async (ctx, args) => {
    const principal = gatewayOnly(ctx);
    if (fault("authorized-evidence")) fail("UNAVAILABLE", "Injected evidence failure: authorized record (proof).");
    return ctx.db.insert(evidence, { ...args, phase: "authorized", recordedAt: Date.now(), feltkitPrincipal: principal.id });
  },
});

/** A refusal, a read's outcome, or a failed write's outcome. A successful update's outcome is written atomically by notes:updateFromAgent. */
export const recordOutcome = app.mutation({
  access: "evidence.write",
  args: recordArgs,
  returns: s.string(),
  handler: async (ctx, args) => {
    const principal = gatewayOnly(ctx);
    if (fault("outcome-evidence")) fail("UNAVAILABLE", "Injected evidence failure: outcome record (proof).");
    return ctx.db.insert(evidence, { ...args, phase: "outcome", recordedAt: Date.now(), feltkitPrincipal: principal.id });
  },
});

/** People only for this proof. */
export const list = app.query({
  access: "evidence.read",
  args: { limit: s.optional(s.number({ minimum: 1, maximum: 500 })) },
  handler: async (ctx, { limit }) => ctx.db.query(evidence, { orderBy: [{ field: "recordedAt", direction: "desc" }], limit: limit ?? 200 }),
});
