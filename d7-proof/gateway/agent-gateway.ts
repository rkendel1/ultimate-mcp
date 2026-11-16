/**
 * The M0.1 AuthBoundry-gated MCP gateway, hosted as a FeltKit runtime component (D7(a), attribution C0).
 *
 * Same flow as src/gateway.ts (M0.1), adapted to the component interface:
 *   1. credential   the caller's `Authorization: Bearer aga_…`; missing/malformed → refused, not asked
 *   2. authority    AuthBoundry decides (src/authority.ts, unchanged): principal derived from the credential
 *   3. evidence     refusal → evidence:recordOutcome, then the refusal; allow → evidence:recordAuthorized
 *                   BEFORE anything executes
 *   4. execution    AppPort dispatch; every handler runs an application function through ctx.call, i.e. as
 *                   FeltKit principal component:agent-gateway, inside FeltKit's roles (the surface ceiling)
 *   5. evidence     the outcome: atomically with the change for notes.update (notes:updateFromAgent),
 *                   otherwise evidence:recordOutcome; the result is returned only after it is committed
 *
 * The component has no database: ctx offers call/credential/derive/model/work and nothing else. All state
 * lives in the FeltKit runtime's one FeltDB instance.
 *
 * Three identities, never collapsed (owner decision Q2):
 *   AuthBoundry principal   the agent AuthBoundry authenticated from its credential (credential possession)
 *   FeltKit principal       component:agent-gateway, as FeltKit's ctx.auth records it
 *   application actor       the agent, ASSERTED by this component after AuthBoundry's allow
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineComponent } from "@feltdb/feltkit/server";
import { createApplication, defineCapability } from "@appport/core";
import { createMcpHandler, MCP_ERROR_META, toMcpTools } from "@appport/mcp";
import { errors } from "@appport/protocol";
import * as s from "@appport/schema";
import { authBoundry, type AuthorityDecision } from "../../src/authority.ts";
import { inputDigest, newCorrelationId } from "../../src/evidence.ts";

const GATEWAY = "component:agent-gateway";
const MAX_BODY_BYTES = 1024 * 1024;
const ON_BEHALF_OF_HEADER = "x-boundry-on-behalf-of";
const AGENT_CREDENTIAL = /^aga_[A-Za-z0-9._~+/=-]{8,512}$/;
const PRINCIPAL_ID = /^[\x21-\x7e]{1,200}$/;

interface Invocation {
  correlationId: string;
  capability: string;
  decision: AuthorityDecision;
  base: Record<string, unknown>;
  /** Set when the outcome was committed with the change itself (notes.update). */
  outcomeCommitted: boolean;
  /** The FeltKit error code of a failed application call, for the outcome record. */
  feltkitError: string | null;
}
const current = new AsyncLocalStorage<Invocation>();

type Call = <T = any>(name: string, args?: object) => Promise<T>;

/** A FeltKit refusal becomes the matching AppPort error, keeping FeltKit's code in the details. */
function fromFeltKit(error: unknown): never {
  const code = String((error as { code?: string })?.code ?? "INTERNAL");
  const message = String((error as Error)?.message ?? error);
  const invocation = current.getStore();
  if (invocation) invocation.feltkitError = code;
  if (code === "FORBIDDEN" || code === "UNAUTHORIZED") throw errors.forbidden(`FeltKit refused: ${message}`, { feltkit_code: code });
  if (code === "NOT_FOUND") throw errors.notFound(message, { feltkit_code: code });
  if (code === "FAILED_PRECONDITION" || code === "CONFLICT") throw errors.conflict(message, { feltkit_code: code });
  if (code === "INVALID_ARGUMENT" || code === "VALIDATION_FAILED") throw errors.invalidInput(message, { feltkit_code: code });
  throw errors.internal(`FeltKit failed: ${code}`);
}

function capabilities(call: Call) {
  const invocation = () => {
    const inv = current.getStore();
    if (!inv?.decision.allowed || !inv.decision.principalId || !inv.decision.decisionId) throw errors.forbidden("No AuthBoundry allow for this invocation");
    return inv;
  };
  const noteShape = s.record(s.unknownSchema());
  return [
    defineCapability({
      name: "notes.get", version: 1, description: "Read a note.", authorization: ["notes.get"], effect: "observation",
      input: s.object({ id: s.string({ minLength: 1 }) }),
      output: s.object({ note: noteShape }),
      handler: async (input) => { invocation(); try { return { note: await call("notes:get", { id: input.id }) }; } catch (e) { fromFeltKit(e); } },
    }),
    defineCapability({
      name: "notes.update", version: 1, description: "Update a note at the version you read.", authorization: ["notes.update"], effect: "consequential",
      input: s.object({
        id: s.string({ minLength: 1 }),
        text: s.string({ minLength: 1, maxLength: 2000 }),
        expected_version: s.integer({ minimum: 1 }),
        /** Proof-only: hold between read and write so a race can be produced deterministically (max 3 s). */
        hold_ms: s.optional(s.integer({ minimum: 0, maximum: 3000 })),
      }),
      output: s.object({ id: s.string(), version: s.number() }),
      handler: async (input) => {
        const inv = invocation();
        try {
          const result = await call<{ id: string; version: number }>("notes:updateFromAgent", {
            id: input.id, text: input.text, expectedVersion: input.expected_version,
            actor: inv.decision.principalId, authorityDecisionId: inv.decision.decisionId, correlationId: inv.correlationId,
            outcome: inv.base, ...(input.hold_ms ? { holdMs: input.hold_ms } : {}),
          });
          inv.outcomeCommitted = true;
          return result;
        } catch (e) { fromFeltKit(e); }
      },
    }),
    defineCapability({
      // Exposed only to prove the ceiling: FeltKit refuses the component's principal (notes.create is human-only).
      name: "notes.create", version: 1, description: "Create a note (people only; refused for agents by FeltKit).", authorization: ["notes.create"], effect: "consequential",
      input: s.object({ text: s.string({ minLength: 1, maxLength: 2000 }) }),
      output: s.object({ id: s.string() }),
      handler: async (input) => { invocation(); try { return { id: await call<string>("notes:create", { text: input.text }) }; } catch (e) { fromFeltKit(e); } },
    }),
  ];
}

function toolError(code: string, message: string) {
  return { isError: true, content: [{ type: "text", text: `${code}: ${message}` }], _meta: { [MCP_ERROR_META]: { code, category: code === "AUTHORITY_UNAVAILABLE" ? "unavailable" : "authorization", retryable: code === "AUTHORITY_UNAVAILABLE" } } };
}
const rpc = (id: unknown, payload: { result: unknown } | { error: { code: number; message: string } }) => JSON.stringify({ jsonrpc: "2.0", id: id ?? null, ...payload });
function send(response: ServerResponse, status: number, body: string) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(body);
}
async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export default defineComponent(async (ctx) => {
  const contextKeys = Object.keys(ctx).sort().join(",");
  const checkCredential = await ctx.credential("authboundry-check");
  const url = process.env.D7_AUTHBOUNDRY_URL;
  const applicationId = process.env.D7_AUTHBOUNDRY_APPLICATION;
  const configured = Boolean(checkCredential && url && applicationId);
  const authority = configured ? authBoundry({ url: url!, applicationId: applicationId!, checkCredential: checkCredential! }) : null;
  const call: Call = (name, args = {}) => ctx.call(name, args);

  const application = createApplication({
    application: { id: "d7-agent-gateway", name: "d7-agent-gateway", version: "0.0.1" },
    capabilities: capabilities(call),
    // Defence in depth, as in M0.1: AppPort executes only inside an AuthBoundry allow for exactly this capability and principal.
    authorizer: {
      name: "authboundry-decision",
      async authorize(request) {
        const inv = current.getStore();
        const principal = request.principal ?? request.session?.principal;
        if (!inv?.decision.allowed) return { allowed: false, code: "FORBIDDEN", reason: "No AuthBoundry allow for this invocation" };
        if (inv.capability !== request.capability.name) return { allowed: false, code: "FORBIDDEN", reason: "AuthBoundry allowed a different capability" };
        if (!principal || principal.id !== inv.decision.principalId) return { allowed: false, code: "FORBIDDEN", reason: "Principal differs from the one AuthBoundry authenticated" };
        return { allowed: true, permissions: [...(request.required ?? [])] };
      },
    },
  });
  const toolToCapability = new Map(toMcpTools(application.manifest()).map((t) => [t.name, t._appport.capability] as const));
  const mcp = createMcpHandler(application, {
    serverInfo: { name: "d7-agent-gateway", version: "0.0.1" },
    context: () => {
      const inv = current.getStore();
      if (!inv?.decision.allowed || !inv.decision.principalId) return undefined;
      return { principal: { id: inv.decision.principalId, type: "service", attributes: { kind: "agent", authority: "authboundry", decision_id: inv.decision.decisionId } } };
    },
  });

  const forward = (request: IncomingMessage, body: string | undefined) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(request.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    return mcp(new Request(new URL(request.url ?? "/", "http://d7.local"), { method: request.method ?? "GET", headers, ...(body !== undefined ? { body } : {}) }));
  };
  const relay = async (response: ServerResponse, answer: Response, text?: string) => {
    const headers: Record<string, string> = {};
    answer.headers.forEach((v, k) => { headers[k] = v; });
    response.writeHead(answer.status, headers);
    response.end(text ?? (await answer.text()));
  };

  async function callTool(request: IncomingMessage, response: ServerResponse, body: string, message: { id?: unknown; params?: { name?: unknown; arguments?: unknown } }) {
    const correlationId = newCorrelationId();
    const tool = typeof message.params?.name === "string" ? message.params.name : null;
    const capability = tool ? toolToCapability.get(tool) ?? null : null;
    const args = message.params?.arguments ?? {};
    const header = request.headers.authorization;
    const match = typeof header === "string" ? /^Bearer (\S+)$/.exec(header) : null;
    const credential = header === undefined || header === "" ? { kind: "none" as const } : match && AGENT_CREDENTIAL.test(match[1]!) ? { kind: "agent_credential" as const, value: match[1]! } : { kind: "malformed" as const };
    const rawOnBehalfOf = request.headers[ON_BEHALF_OF_HEADER];
    const onBehalfOf = typeof rawOnBehalfOf === "string" && rawOnBehalfOf.length > 0 ? rawOnBehalfOf : null;

    /** The component-reported evidence content (M0.1 shape). FeltKit's principal is added by the evidence function. */
    const content = (decision: AuthorityDecision | null, result: Record<string, unknown> | null) => ({
      caller: {
        credential: credential.kind,
        authenticated_principal_id: decision?.executor?.proven ? decision.principalId : null,
        authentication: decision?.executor?.proven ? "authboundry_agent_credential" : "none",
        agent_credential_id: decision?.executor?.agentCredentialId ?? null,
      },
      application_actor: decision?.allowed ? { id: decision.principalId, basis: "component_asserted_after_authboundry" } : null,
      executor: { service: GATEWAY, identity_basis: "feltkit_declared_component" },
      on_behalf_of: onBehalfOf,
      authority: decision
        ? { asked: true, outcome: decision.outcome, decision_id: decision.decisionId, principal_id: decision.principalId, reason: decision.reason, http_status: decision.httpStatus, delegation_id: decision.delegationId }
        : { asked: false, outcome: "not_asked", decision_id: null, principal_id: null, reason: null, http_status: null, delegation_id: null },
      ...(result ? { result } : {}),
      input_digest: inputDigest(args),
    });
    const evidenceFailed = () => send(response, 503, rpc(message.id, { error: { code: -32603, message: "EVIDENCE_UNAVAILABLE: the invocation could not be recorded, so it was not carried out or its result is withheld." } }));
    const refuse = async (code: string, reason: string, decision: AuthorityDecision | null) => {
      try {
        await call("evidence:recordOutcome", { correlationId, tool, capability, record: content(decision, { status: "refused", error_code: code, reference: null }) });
      } catch {
        return evidenceFailed();
      }
      send(response, 200, rpc(message.id, { result: toolError(code, reason) }));
    };

    if (credential.kind === "none") return refuse("UNAUTHORIZED", "An AuthBoundry agent credential is required (Authorization: Bearer aga_…).", null);
    if (credential.kind === "malformed") return refuse("UNAUTHORIZED", "The Authorization header is not an AuthBoundry agent credential.", null);
    if (onBehalfOf !== null && !PRINCIPAL_ID.test(onBehalfOf)) return refuse("FORBIDDEN", `${ON_BEHALF_OF_HEADER} is not a principal id.`, null);
    if (!capability) return refuse("UNKNOWN_TOOL", `No such tool: ${tool ?? "(none)"}`, null);
    if (!authority) return refuse("AUTHORITY_UNAVAILABLE", "The gateway's AuthBoundry configuration is incomplete.", null);

    const decision = await authority.decide({ agentCredential: credential.value, capability, onBehalfOf });
    if (!decision.allowed) {
      const code = decision.outcome === "unauthenticated" ? "UNAUTHORIZED" : decision.outcome === "unavailable" ? "AUTHORITY_UNAVAILABLE" : "FORBIDDEN";
      return refuse(code, decision.reason ?? decision.outcome, decision);
    }
    try {
      await call("evidence:recordAuthorized", { correlationId, tool, capability, record: content(decision, { status: "authorized", error_code: null, reference: null }) });
    } catch {
      return evidenceFailed();
    }

    const inv: Invocation = { correlationId, capability, decision, base: content(decision, null), outcomeCommitted: false, feltkitError: null };
    const answer = await current.run(inv, () => forward(request, body));
    const text = await answer.text();
    if (inv.outcomeCommitted) return relay(response, answer, text);

    let result: Record<string, unknown> = { status: "failed", error_code: "MALFORMED_RESPONSE", reference: null };
    try {
      const parsed = JSON.parse(text) as { result?: { isError?: boolean; structuredContent?: { note?: { id?: string; __version?: number } }; _meta?: Record<string, { code?: string }> }; error?: { code?: number } };
      if (parsed.error) result = { status: "failed", error_code: `JSONRPC_${parsed.error.code ?? "ERROR"}`, reference: null };
      else if (parsed.result?.isError) result = { status: "failed", error_code: parsed.result._meta?.[MCP_ERROR_META]?.code ?? "TOOL_ERROR", feltkit_error: inv.feltkitError, reference: null };
      else {
        const note = parsed.result?.structuredContent?.note;
        result = { status: "completed", error_code: null, reference: note?.id ? `note:${note.id}@${note.__version}` : null };
      }
    } catch { /* keep MALFORMED_RESPONSE */ }
    try {
      await call("evidence:recordOutcome", { correlationId, tool, capability, record: { ...inv.base, result } });
    } catch {
      return evidenceFailed();
    }
    return relay(response, answer, text);
  }

  return {
    async request(request, response) {
      if (request.method !== "POST") return relay(response, await forward(request, undefined));
      const body = await readBody(request);
      if (body === null) return send(response, 413, rpc(null, { error: { code: -32600, message: "Request too large" } }));
      let message: unknown;
      try { message = JSON.parse(body); } catch { message = null; }
      if (Array.isArray(message)) return send(response, 400, rpc(null, { error: { code: -32600, message: "Batched requests are not supported" } }));
      if (message && typeof message === "object" && (message as { method?: unknown }).method === "tools/call") {
        return callTool(request, response, body, message as { id?: unknown; params?: { name?: unknown; arguments?: unknown } });
      }
      return relay(response, await forward(request, body));
    },
    health() {
      return {
        state: configured ? "ready" : "unconfigured",
        checks: { authority: { state: configured ? "ready" : "unconfigured" }, context: { state: "ready", detail: `component context offers: ${contextKeys}` } },
      };
    },
  };
});

