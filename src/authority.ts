/**
 * AuthBoundry is the only authority. This module asks it one question per invocation —
 * "may the agent holding this credential invoke this capability now (on behalf of this person)?" —
 * and turns the answer into a decision the gateway can act on.
 *
 * The request is AuthBoundry's documented enforcement-point flow (authboundry
 * docs/AGENT-CREDENTIALS.md, "Credential-derived principal"): the application's check credential
 * plus the CALLER's agent credential, and no `principal_id`. AuthBoundry derives the principal from
 * its stored credential record on every request (no caching), so identity can come from nowhere else.
 *
 * Fail closed: anything that is not an exact, attributable allow for this application, capability
 * and (when asked) delegator is a refusal. When AuthBoundry cannot be reached, the decision says so
 * and carries NO decision id: one is never invented.
 */

export type AuthorityOutcome =
  /** AuthBoundry allowed exactly this request. */
  | "allow"
  /** AuthBoundry denied (policy, delegation, scope, principal mismatch, inactive agent). */
  | "deny"
  /** AuthBoundry rejected the credential (unknown, malformed, revoked, expired, replayed). */
  | "unauthenticated"
  /** Authorization could not be established (unreachable, timeout, unexpected status). */
  | "unavailable"
  /** AuthBoundry answered, but not with an exact, verifiable allow. */
  | "invalid";

export interface AuthorityDecision {
  outcome: AuthorityOutcome;
  allowed: boolean;
  /** AuthBoundry's durable decision id; null whenever AuthBoundry recorded no decision. */
  decisionId: string | null;
  reason: string | null;
  httpStatus: number | null;
  /** The principal AuthBoundry derived from the credential. Never taken from the caller. */
  principalId: string | null;
  executor: { proven: boolean; agentCredentialId: string | null } | null;
  onBehalfOf: string | null;
  delegationId: string | null;
}

export interface AuthorityRequest {
  agentCredential: string;
  capability: string;
  onBehalfOf: string | null;
}

export interface Authority {
  decide(request: AuthorityRequest): Promise<AuthorityDecision>;
}

export interface AuthBoundryOptions {
  url: string;
  applicationId: string;
  checkCredential: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export function authBoundry(options: AuthBoundryOptions): Authority {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  return {
    async decide(request) {
      const base = { decisionId: null, principalId: null, executor: null, onBehalfOf: request.onBehalfOf, delegationId: null };
      const refuse = (outcome: Exclude<AuthorityOutcome, "allow">, reason: string, httpStatus: number | null, extra: Partial<AuthorityDecision> = {}): AuthorityDecision =>
        ({ ...base, outcome, allowed: false, reason, httpStatus, ...extra });

      let status: number;
      let body: Record<string, unknown>;
      try {
        const response = await doFetch(new URL("/_authboundry/authorize/check", options.url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "x-authboundry-check-credential": options.checkCredential,
            "x-authboundry-agent-credential": request.agentCredential,
          },
          // No principal_id: AuthBoundry derives it from the credential.
          body: JSON.stringify({
            application_id: options.applicationId,
            capability: request.capability,
            mode: "enforce",
            ...(request.onBehalfOf !== null ? { on_behalf_of: request.onBehalfOf } : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = response.status;
        body = ((await response.json().catch(() => null)) ?? {}) as Record<string, unknown>;
      } catch (error) {
        const name = (error as Error)?.name === "TimeoutError" ? "timeout" : "unreachable";
        return refuse("unavailable", `authorization could not be established: AuthBoundry ${name}`, null);
      }

      const executorOf = (b: Record<string, unknown>) => {
        const e = b.executor as Record<string, unknown> | undefined;
        return e && typeof e === "object" ? { proven: e.proven === true, agentCredentialId: str(e.agent_credential_id) } : null;
      };
      if (status === 401) return refuse("unauthenticated", str(body.reason) ?? "unauthenticated", status);
      if (status === 403) return refuse("deny", str(body.reason) ?? "forbidden", status);
      if (status !== 200) return refuse("unavailable", `authorization could not be established: AuthBoundry answered ${status}`, status);

      const decisionId = str(body.decision_id);
      const executor = executorOf(body);
      // Only a principal AuthBoundry proved from the credential is ever attributed.
      const principalId = executor?.proven ? str(body.principal_id) : null;
      const attributed = { decisionId, principalId, executor, delegationId: str(body.delegation_id) };

      if (body.decision === "deny") return refuse("deny", str(body.reason) ?? "denied", status, attributed);
      if (body.decision !== "allow") return refuse("invalid", "AuthBoundry answered without a decision", status, attributed);

      const exact =
        body.application_id === options.applicationId &&
        body.capability === request.capability &&
        body.mode === "enforce" &&
        decisionId !== null &&
        principalId !== null &&
        executor?.proven === true;
      if (!exact) return refuse("invalid", "AuthBoundry's allow is not an exact, proven allow for this application and capability", status, attributed);
      if (request.onBehalfOf !== null && (body.on_behalf_of !== request.onBehalfOf || attributed.delegationId === null)) {
        return refuse("invalid", "AuthBoundry's allow does not name this delegator and a delegation", status, attributed);
      }
      return { ...base, ...attributed, outcome: "allow", allowed: true, reason: str(body.reason), httpStatus: status };
    },
  };
}
