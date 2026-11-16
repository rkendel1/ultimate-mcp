/**
 * D7(a) proof application (disposable). One FeltKit application, one FeltDB instance, two front doors:
 *
 *   people  → FeltKit accounts and sessions → /api/query|mutation/<fn>   (role: member)
 *   agents  → AuthBoundry agent credentials → /agents/mcp/ (component)   (role: gateway, as component:agent-gateway)
 *
 * FeltKit roles set the ceiling of each surface. AuthBoundry decides each agent invocation inside the
 * gateway's ceiling. Both must allow (owner decision Q1, 2026-11-16).
 */
import { feltkit, s } from "@feltdb/feltkit";

export const GATEWAY = "component:agent-gateway";

export const app = feltkit({
  name: "d7-proof",
  roles: {
    // People: create, read and update notes; read evidence. Not the agent-only functions.
    member: ["notes.create", "notes.read", "notes.write", "evidence.read"],
    // The agent surface's ceiling: read notes, update them as an asserted agent actor, write evidence.
    // It does NOT hold notes.create: that function is human-only by role.
    gateway: ["notes.read", "notes.agentWrite", "evidence.write"],
  },
  auth: { accounts: { roles: ["member"] } },
  components: {
    "agent-gateway": {
      entry: "gateway/agent-gateway.ts",
      routes: ["/agents/mcp/"],
      principal: { id: GATEWAY, roles: ["gateway"] },
      credentials: ["authboundry-check"],
      description: "AuthBoundry-gated MCP surface for agents (M0.1 gateway as a component).",
    },
  },
});

/** Who changed a note, and on what basis. The three identities are kept apart (owner decision Q2, C0). */
const provenance = {
  /** The application-level actor: a person (FeltKit session) or an agent (asserted by the component). */
  actor: s.string(),
  actorBasis: s.enum(["feltkit_session", "component_asserted_after_authboundry"] as const),
  /** The principal FeltKit's runtime saw for the call (ctx.auth), written by the function, never by the caller. */
  feltkitPrincipal: s.string(),
  /** AuthBoundry's decision id for an agent change; null for a person's change. */
  authorityDecisionId: s.nullable(s.string()),
};

export const notes = app.collection("notes", {
  text: s.string({ minLength: 1, maxLength: 2000 }),
  updatedAt: s.number(),
  ...provenance,
});

/** Invocation evidence for the agent surface: the M0.1 record shape, plus FeltKit's own view of the caller. */
export const evidence = app.collection("evidence", {
  correlationId: s.string(),
  phase: s.enum(["authorized", "outcome"] as const),
  recordedAt: s.number(),
  tool: s.nullable(s.string()),
  capability: s.nullable(s.string()),
  /** The component-reported part of the record (caller, authority, result, digests): data, not identity. */
  record: s.record(s.unknown()),
  /** Written by the evidence function from ctx.auth: the FeltKit principal that actually made the call. */
  feltkitPrincipal: s.string(),
});
