/**
 * Invocation evidence: one append-only record for every attempted capability invocation, written
 * durably BEFORE the gateway reports the invocation as refused or completed.
 *
 * Append-only is enforced by the store, not by convention: every record is created with FeltDB's
 * `requireAbsent`, so a second write under an existing id is refused by FeltDB and the original is
 * left untouched. Nothing in this module updates or deletes a record.
 *
 * What is never recorded: credentials (only AuthBoundry's credential id, an identifier), arguments
 * (only their SHA-256 digest), and results (only a reference such as the created task id).
 */
import { createHash, randomUUID } from "node:crypto";
import type { StateFirstDB } from "@feltdb/core";
import type { AuthorityOutcome } from "./authority.ts";

export const EVIDENCE_COLLECTION = "boundry_invocation_evidence";

export type EvidencePhase =
  /** An allowed invocation, recorded before it executes. */
  | "authorized"
  /** The final word on an attempt: refused, completed or failed. */
  | "outcome";

export interface EvidenceRecord {
  id: string;
  correlation_id: string;
  phase: EvidencePhase;
  recorded_at: string;
  transport: "mcp";
  tool: string | null;
  capability: string | null;
  /**
   * Who called, and on what basis. Four identities are kept apart:
   *   - the AUTHENTICATED caller: whoever presented the credential, known only as its holder;
   *   - the AUTHORIZED principal: `authority.principal_id`, what AuthBoundry decided for;
   *   - the EXECUTING service: `executor`, this gateway;
   *   - any identity the request merely CLAIMS: never recorded as identity.
   */
  caller: {
    /** What the caller presented, as the gateway saw it (never the value). */
    credential: "agent_credential" | "none" | "malformed";
    /**
     * The principal AuthBoundry bound the presented credential to, or null. Basis: possession of a
     * valid credential (AuthBoundry `executor.method = agent_credential`). It shows that the caller held
     * that principal's credential; it does not establish which software, model or person held it.
     */
    authenticated_principal_id: string | null;
    authentication: "authboundry_agent_credential" | "none";
    agent_credential_id: string | null;
  };
  /** The service that executed the invocation. Its identity is asserted by its own configuration. */
  executor: {
    service: string;
    identity_basis: "asserted_by_configuration";
  };
  /** The delegator the caller asked to act for; AuthBoundry decided whether that is true. */
  on_behalf_of: string | null;
  authority: {
    asked: boolean;
    outcome: AuthorityOutcome | "not_asked";
    /** AuthBoundry's durable decision id. Null whenever AuthBoundry recorded no decision; never invented. */
    decision_id: string | null;
    /** The principal AuthBoundry decided for (null when it decided nothing). */
    principal_id: string | null;
    reason: string | null;
    http_status: number | null;
    delegation_id: string | null;
  };
  result: {
    status: "authorized" | "refused" | "completed" | "failed";
    error_code: string | null;
    reference: string | null;
  };
  input_digest: string | null;
}

export interface EvidencePage {
  records: EvidenceRecord[];
  next_cursor: string | null;
}

export interface EvidenceStore {
  append(record: EvidenceRecord): Promise<void>;
  get(id: string): Promise<EvidenceRecord | null>;
  list(input: { limit: number; cursor?: string }): Promise<EvidencePage>;
}

/** Ids sort by time, so the newest record is first in descending id order. */
export function evidenceId(phase: EvidencePhase, at: Date, correlationId: string): string {
  return `ev_${at.getTime().toString().padStart(15, "0")}_${correlationId}_${phase}`;
}

export const newCorrelationId = () => randomUUID();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export const inputDigest = (input: unknown) => `sha256:${createHash("sha256").update(canonical(input)).digest("hex")}`;

const strip = (record: Record<string, unknown>): EvidenceRecord => {
  const { __version: _v, ...rest } = record;
  return rest as unknown as EvidenceRecord;
};

export function feltDbEvidence(db: StateFirstDB): EvidenceStore {
  const collection = db.collection<Record<string, unknown>>(EVIDENCE_COLLECTION);
  return {
    async append(record) {
      // Creates or fails; never replaces.
      await collection.insert(record as unknown as Record<string, unknown>, record.id, { requireAbsent: true });
    },
    async get(id) {
      const found = await collection.get(id);
      return found ? strip(found) : null;
    },
    async list({ limit, cursor }) {
      const page = await db.query<Record<string, unknown>>({
        collection: EVIDENCE_COLLECTION,
        orderBy: [{ field: "id", direction: "desc" }],
        limit,
        ...(cursor ? { cursor } : {}),
      });
      return { records: page.records.map(strip), next_cursor: page.nextCursor ?? null };
    },
  };
}
