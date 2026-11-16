# Probes

Small, reproducible checks run against published packages during planning. They are evidence for
claims in `docs/`, not product code.

## feltdb-continuity.mjs

Checks that `@feltdb/core@0.21.0` agent state supports cross-agent continuation from durable state
alone, and shows what a resumed context bundle contains.

```bash
mkdir /tmp/probe && cd /tmp/probe && npm init -y && npm i @feltdb/core@0.21.0
node /path/to/probes/feltdb-continuity.mjs
```

Observed 2026-11-16: a task created, checkpointed and handed off by `agent:claude-code` was
claimed and resumed by `agent:codex` in a fresh process that reopened the store from disk. The
resumed bundle (`feltdb.agent-context@1`) contained the originating agent's checkpoint
`decisions` and its `assumption` memory, which is correct for continuity and exactly what an
independent reviewer must not receive. See `docs/CONTINUITY-AND-VERIFICATION.md` §4.
