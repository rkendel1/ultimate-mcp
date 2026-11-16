/**
 * The Boundry Continuity MCP endpoint: the trust boundary for M0.1.
 *
 * Every `tools/call` goes through the same five steps, in this order:
 *
 *   1. Credential   the caller's `Authorization: Bearer aga_…` (an AuthBoundry agent credential).
 *                   Missing or malformed → refused here, without asking anyone.
 *   2. Authority    AuthBoundry decides (authority.ts): it authenticates the credential, derives the
 *                   principal from it, and evaluates policy and delegation. Nothing else decides.
 *   3. Evidence     refusals: the outcome record is committed, then the refusal is returned.
 *                   allows: an `authorized` record is committed BEFORE anything executes.
 *   4. Execution    AppPort dispatch, with the principal AuthBoundry proved. AppPort's authorizer
 *                   re-checks that an exact AuthBoundry allow exists for this capability and
 *                   principal, so no path reaches a handler without one.
 *   5. Evidence     the outcome record is committed before the result is returned.
 *
 * If evidence cannot be committed, the gateway fails closed: it does not execute (step 3) or does
 * not return the result (step 5), and answers 503 EVIDENCE_UNAVAILABLE.
 *
 * Nothing the caller writes becomes identity. Headers other than Authorization, `_meta`, and tool
 * arguments are never read as a principal. `x-boundry-on-behalf-of` names the person the agent asks
 * to act for; AuthBoundry decides whether a live delegation makes that true.
 *
 * `initialize`, `ping` and `tools/list` are answered without a credential: discovery is not
 * authority, and every call is decided when it is made (per-caller tool lists are M5).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createApplication, type AppPortApplication } from "@appport/core";
import { createMcpHandler, MCP_ERROR_META, toMcpTools } from "@appport/mcp";
import type { StateFirstDB } from "@feltdb/core";
import type { Authority, AuthorityDecision } from "./authority.ts";
import { continuityCapabilities } from "./capabilities.ts";
import { evidenceId, inputDigest, newCorrelationId, type EvidenceRecord, type EvidenceStore } from "./evidence.ts";

const MAX_BODY_BYTES = 1024 * 1024;
const ON_BEHALF_OF_HEADER = "x-boundry-on-behalf-of";
const AGENT_CREDENTIAL = /^aga_[A-Za-z0-9._~+/=-]{8,512}$/;
const PRINCIPAL_ID = /^[\x21-\x7e]{1,200}$/;

interface Invocation {
  correlationId: string;
  capability: string;
  decision: AuthorityDecision;
}
const current = new AsyncLocalStorage<Invocation>();

export interface GatewayOptions {
  db: StateFirstDB;
  authority: Authority;
  evidence: EvidenceStore;
  serverInfo?: { name: string; version: string };
  now?: () => Date;
}

export interface Gateway {
  application: AppPortApplication;
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
}

type Credential = { kind: "agent_credential"; value: string } | { kind: "none" } | { kind: "malformed" };

function credentialOf(request: IncomingMessage): Credential {
  const header = request.headers.authorization;
  if (header === undefined || header === "") return { kind: "none" };
  const match = /^Bearer (\S+)$/.exec(header);
  if (!match || !AGENT_CREDENTIAL.test(match[1]!)) return { kind: "malformed" };
  return { kind: "agent_credential", value: match[1]! };
}

function toolError(code: string, message: string) {
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
    _meta: { [MCP_ERROR_META]: { code, category: code === "AUTHORITY_UNAVAILABLE" ? "unavailable" : "authorization", retryable: code === "AUTHORITY_UNAVAILABLE" } },
  };
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

function send(response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(body);
}

const rpc = (id: unknown, payload: { result: unknown } | { error: { code: number; message: string } }) =>
  JSON.stringify({ jsonrpc: "2.0", id: id ?? null, ...payload });

export function createGateway(options: GatewayOptions): Gateway {
  const now = options.now ?? (() => new Date());
  const { evidence, authority } = options;

  const application = createApplication({
    application: { id: "boundry-continuity", name: options.serverInfo?.name ?? "boundry-continuity", version: options.serverInfo?.version ?? "0.0.1" },
    capabilities: continuityCapabilities(options.db, evidence),
    // Defence in depth: AppPort executes only inside an invocation AuthBoundry allowed, for exactly
    // this capability and principal. The gateway already refused everything else before dispatch.
    authorizer: {
      name: "authboundry-decision",
      async authorize(request) {
        const invocation = current.getStore();
        const principal = request.principal ?? request.session?.principal;
        if (!invocation?.decision.allowed) return { allowed: false, code: "FORBIDDEN", reason: "No AuthBoundry allow for this invocation" };
        if (invocation.capability !== request.capability.name) return { allowed: false, code: "FORBIDDEN", reason: "AuthBoundry allowed a different capability" };
        if (!principal || principal.id !== invocation.decision.principalId) return { allowed: false, code: "FORBIDDEN", reason: "Principal differs from the one AuthBoundry proved" };
        return { allowed: true, permissions: [...(request.required ?? [])] };
      },
    },
  });

  const toolToCapability = new Map(toMcpTools(application.manifest()).map((t) => [t.name, t._appport.capability] as const));

  const mcp = createMcpHandler(application, {
    serverInfo: options.serverInfo ?? { name: "boundry-continuity", version: "0.0.1" },
    // The only principal AppPort ever sees is the one AuthBoundry proved for this invocation.
    context: () => {
      const invocation = current.getStore();
      if (!invocation?.decision.allowed || !invocation.decision.principalId) return undefined;
      return {
        principal: {
          id: invocation.decision.principalId,
          type: "service",
          attributes: { kind: "agent", authority: "authboundry", decision_id: invocation.decision.decisionId },
        },
      };
    },
  });

  const forward = async (request: IncomingMessage, body: string | undefined): Promise<Response> => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(request.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    const url = new URL(request.url ?? "/", "http://boundry.local");
    return mcp(new Request(url, { method: request.method ?? "GET", headers, ...(body !== undefined ? { body } : {}) }));
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
    const credential = credentialOf(request);
    const rawOnBehalfOf = request.headers[ON_BEHALF_OF_HEADER];
    const onBehalfOf = typeof rawOnBehalfOf === "string" && rawOnBehalfOf.length > 0 ? rawOnBehalfOf : null;

    const record = (phase: EvidenceRecord["phase"], decision: AuthorityDecision | null, result: EvidenceRecord["result"]): EvidenceRecord => {
      const at = now();
      return {
        id: evidenceId(phase, at, correlationId),
        correlation_id: correlationId,
        phase,
        recorded_at: at.toISOString(),
        transport: "mcp",
        tool,
        capability,
        caller: {
          credential: credential.kind,
          principal_id: decision?.principalId ?? null,
          proven: decision?.executor?.proven === true && decision.principalId !== null,
          agent_credential_id: decision?.executor?.agentCredentialId ?? null,
        },
        on_behalf_of: onBehalfOf,
        authority: decision
          ? { asked: true, outcome: decision.outcome, decision_id: decision.decisionId, reason: decision.reason, http_status: decision.httpStatus, delegation_id: decision.delegationId }
          : { asked: false, outcome: "not_asked", decision_id: null, reason: null, http_status: null, delegation_id: null },
        result,
        input_digest: inputDigest(args),
      };
    };

    const evidenceFailed = () =>
      send(response, 503, rpc(message.id, { error: { code: -32603, message: "EVIDENCE_UNAVAILABLE: the invocation could not be recorded, so it was not carried out or its result is withheld." } }));

    /** Commit the refusal's record, then answer with it. */
    const refuse = async (code: string, reason: string, decision: AuthorityDecision | null) => {
      try {
        await evidence.append(record("outcome", decision, { status: "refused", error_code: code, reference: null }));
      } catch {
        return evidenceFailed();
      }
      send(response, 200, rpc(message.id, { result: toolError(code, reason) }));
    };

    if (credential.kind === "none") return refuse("UNAUTHORIZED", "An AuthBoundry agent credential is required (Authorization: Bearer aga_…).", null);
    if (credential.kind === "malformed") return refuse("UNAUTHORIZED", "The Authorization header is not an AuthBoundry agent credential.", null);
    if (onBehalfOf !== null && !PRINCIPAL_ID.test(onBehalfOf)) return refuse("FORBIDDEN", `${ON_BEHALF_OF_HEADER} is not a principal id.`, null);
    if (!capability) return refuse("UNKNOWN_TOOL", `No such tool: ${tool ?? "(none)"}`, null);

    const decision = await authority.decide({ agentCredential: credential.value, capability, onBehalfOf });
    if (!decision.allowed) {
      const code = decision.outcome === "unauthenticated" ? "UNAUTHORIZED" : decision.outcome === "unavailable" ? "AUTHORITY_UNAVAILABLE" : "FORBIDDEN";
      return refuse(code, decision.reason ?? decision.outcome, decision);
    }

    // Allowed: the authorization is on record before anything executes.
    try {
      await evidence.append(record("authorized", decision, { status: "authorized", error_code: null, reference: null }));
    } catch {
      return evidenceFailed();
    }

    const answer = await current.run({ correlationId, capability, decision }, () => forward(request, body));
    const text = await answer.text();
    let result: EvidenceRecord["result"] = { status: "failed", error_code: "MALFORMED_RESPONSE", reference: null };
    try {
      const parsed = JSON.parse(text) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown>; _meta?: Record<string, { code?: string }> }; error?: { code?: number } };
      if (parsed.error) result = { status: "failed", error_code: `JSONRPC_${parsed.error.code ?? "ERROR"}`, reference: null };
      else if (parsed.result?.isError) result = { status: "failed", error_code: parsed.result._meta?.[MCP_ERROR_META]?.code ?? "TOOL_ERROR", reference: null };
      else {
        const sc = parsed.result?.structuredContent;
        const reference = typeof sc?.task_id === "string" ? `task:${sc.task_id}` : null;
        result = { status: "completed", error_code: null, reference };
      }
    } catch { /* keep MALFORMED_RESPONSE */ }

    try {
      await evidence.append(record("outcome", decision, result));
    } catch {
      return evidenceFailed();
    }
    await relay(response, answer, text);
  }

  return {
    application,
    async handle(request, response) {
      const path = new URL(request.url ?? "/", "http://boundry.local").pathname;
      if (path === "/health") return send(response, 200, JSON.stringify({ status: "ok" }));
      if (path !== "/mcp") return send(response, 404, JSON.stringify({ error: "not_found" }));
      if (request.method !== "POST") return relay(response, await forward(request, undefined));
      const body = await readBody(request);
      if (body === null) return send(response, 413, rpc(null, { error: { code: -32600, message: "Request too large" } }));
      let message: unknown;
      try { message = JSON.parse(body); } catch { message = null; }
      if (message && !Array.isArray(message) && typeof message === "object" && (message as { method?: unknown }).method === "tools/call") {
        return callTool(request, response, body, message as { id?: unknown; params?: { name?: unknown; arguments?: unknown } });
      }
      if (Array.isArray(message)) return send(response, 400, rpc(null, { error: { code: -32600, message: "Batched requests are not supported" } }));
      return relay(response, await forward(request, body));
    },
  };
}
