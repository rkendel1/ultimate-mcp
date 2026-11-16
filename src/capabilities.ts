/**
 * The M0.1 capabilities. Deliberately three:
 *
 *   work.task.create   create a durable work task (FeltDB agent state), attributed to the AuthBoundry-
 *                      proven principal — the first step of cross-agent continuation (AT-1)
 *   evidence.list      read invocation evidence, newest first
 *   evidence.get       read one evidence record
 *
 * Handlers never decide who the caller is. They read `context.principal`, which the gateway sets
 * only from AuthBoundry's proven executor, and the authorizer refuses any dispatch whose principal
 * differs from the one AuthBoundry allowed.
 */
import { defineCapability } from "@appport/core";
import { errors } from "@appport/protocol";
import * as s from "@appport/schema";
import { openAgentState, type StateFirstDB } from "@feltdb/core";
import type { EvidenceStore } from "./evidence.ts";

const MAX_TEXT = 2_000;

export function continuityCapabilities(db: StateFirstDB, evidence: EvidenceStore) {
  const agentState = openAgentState(db);

  const principalOf = (context: { principal?: { id: string } }): string => {
    const id = context.principal?.id;
    if (!id) throw errors.unauthorized("No authenticated principal");
    return id;
  };

  const workTaskCreate = defineCapability({
    name: "work.task.create",
    version: 1,
    description: "Create a durable work task. The task's owner and creator are the authenticated agent.",
    authorization: ["work.task.create"],
    effect: "consequential",
    input: s.object({
      objective: s.string({ minLength: 1, maxLength: MAX_TEXT }),
      constraints: s.optional(s.array(s.string({ maxLength: MAX_TEXT }), { maxItems: 50 })),
      pending_work: s.optional(s.array(s.string({ maxLength: MAX_TEXT }), { maxItems: 50 })),
    }),
    output: s.object({
      task_id: s.string(),
      owner: s.string(),
      created_by: s.string(),
      created_at: s.string(),
      checkpoint_version: s.number(),
    }),
    async handler(input, context) {
      const actor = principalOf(context);
      const { task } = await (await agentState).createTask({
        objective: input.objective,
        actor,
        ...(input.constraints ? { constraints: input.constraints } : {}),
        ...(input.pending_work ? { pendingWork: input.pending_work } : {}),
      });
      return { task_id: task.task_id, owner: task.owner, created_by: task.created_by, created_at: task.created_at, checkpoint_version: task.checkpoint_version };
    },
  });

  const recordSchema = s.record(s.unknownSchema());

  const evidenceList = defineCapability({
    name: "evidence.list",
    version: 1,
    description: "List invocation evidence records, newest first.",
    authorization: ["evidence.list"],
    effect: "observation",
    input: s.object({
      limit: s.optional(s.number({ minimum: 1, maximum: 100 })),
      cursor: s.optional(s.string()),
    }),
    output: s.object({ records: s.array(recordSchema), next_cursor: s.nullable(s.string()) }),
    async handler(input, context) {
      principalOf(context);
      const page = await evidence.list({ limit: input.limit ?? 50, ...(input.cursor ? { cursor: input.cursor } : {}) });
      return { records: page.records as unknown as Record<string, unknown>[], next_cursor: page.next_cursor };
    },
  });

  const evidenceGet = defineCapability({
    name: "evidence.get",
    version: 1,
    description: "Read one invocation evidence record by id.",
    authorization: ["evidence.get"],
    effect: "observation",
    input: s.object({ id: s.string({ minLength: 1 }) }),
    output: s.object({ record: recordSchema }),
    async handler(input, context) {
      principalOf(context);
      const record = await evidence.get(input.id);
      if (!record) throw errors.notFound("No such evidence record");
      return { record: record as unknown as Record<string, unknown> };
    },
  });

  return [workTaskCreate, evidenceList, evidenceGet];
}
