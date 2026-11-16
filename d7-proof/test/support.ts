// D7 proof test support. Test infrastructure only.
//
// Reuses the M0.1 harnesses unchanged: the local AuthBoundry (../../test/support/authboundry.ts) and the two
// MCP client drivers (../../test/support/processes.ts). Starts the FeltKit application through its own CLI
// (`feltkit start`, production mode) as a child process with a hermetic environment: ambient FELTDB_*
// variables are never passed on.
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { APPLICATION, type LocalAuthority } from "../../test/support/authboundry.ts";

// Hermetic: this environment sets FELTDB_* variables; nothing in the proof may inherit them.
for (const key of Object.keys(process.env)) if (key.startsWith("FELTDB_")) delete process.env[key];

export const PROOF_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FELTKIT_BIN = join(PROOF_DIR, "node_modules", "@feltdb", "feltkit", "bin", "feltkit.js");

/** The AuthBoundry capabilities of the agent surface (one per gateway capability). */
export const NOTES_CAPABILITIES = ["notes.get", "notes.update", "notes.create"];

/** Adds the agent surface's capabilities to the local AuthBoundry application's contract. */
export async function addNotesContract(authority: LocalAuthority) {
  const r = await authority.control(`/_authboundry/control-plane/applications/${APPLICATION}/contracts`, {
    method: "POST",
    body: { authority_source: "external", version: "1.1.0", capabilities: ["work.task.create", "evidence.list", "evidence.get", ...NOTES_CAPABILITIES] },
  });
  if (r.status >= 300) throw new Error(`contract: ${r.status} ${JSON.stringify(r.body)}`);
}

export interface FeltKitApp {
  url: string;
  mcpUrl: string;
  proc: ChildProcess;
  log(): string;
  kill(signal?: NodeJS.Signals): Promise<number | null>;
}

/** The exact environment the application process gets: nothing ambient beyond PATH/HOME/TMPDIR. */
export function appEnvironment(input: { stateDir: string; authority: LocalAuthority; fault?: string }): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp",
    FELTKIT_STATE_DIR: input.stateDir,
    FELTKIT_CREDENTIAL_AUTHBOUNDRY_CHECK: input.authority.checkCredential,
    D7_AUTHBOUNDRY_URL: input.authority.url,
    D7_AUTHBOUNDRY_APPLICATION: APPLICATION,
    ...(input.fault ? { D7_PROOF_FAULT: input.fault } : {}),
  };
}

export async function startApp(env: Record<string, string>, { expectFailure = false } = {}): Promise<FeltKitApp> {
  const proc = spawn(process.execPath, [FELTKIT_BIN, "start", "--port", "0", "--host", "127.0.0.1"], { cwd: PROOF_DIR, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = "";
  const append = (d: Buffer) => { log = (log + d).slice(-20_000); };
  proc.stderr?.on("data", append);
  const kill = (signal: NodeJS.Signals = "SIGTERM") => new Promise<number | null>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve(proc.exitCode);
    proc.once("exit", (code) => resolve(code));
    try { process.kill(-proc.pid!, signal); } catch { proc.kill(signal); }
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`feltkit start did not report an address: ${log.slice(-3000)}`)), 60_000);
    createInterface({ input: proc.stdout! }).on("line", (line) => {
      append(Buffer.from(line + "\n"));
      const m = /serving (http:\/\/\S+)/.exec(line);
      if (m) { clearTimeout(timer); resolve(m[1]!.replace("localhost", "127.0.0.1")); }
    });
    proc.once("exit", (code) => { clearTimeout(timer); reject(Object.assign(new Error(`feltkit start exited (${code}): ${log.slice(-3000)}`), { exitCode: code, log })); });
  }).catch((e) => { if (expectFailure) return Promise.reject(e); throw e; });
  const app: FeltKitApp = { url, mcpUrl: `${url}/agents/mcp/`, proc, log: () => log, kill };
  // Wait until the runtime and the required component are ready.
  const deadline = Date.now() + 30_000;
  for (;;) {
    const h = await fetch(`${url}/_feltkit/health`).then((r) => r.json() as Promise<{ status?: string }>).catch(() => ({} as { status?: string }));
    if (h.status === "ready") break;
    if (Date.now() > deadline) throw new Error(`application not ready: ${JSON.stringify(h)} ${log.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return app;
}

/** A person: a FeltKit account and its session token. */
export async function signUp(app: FeltKitApp): Promise<{ token: string; principalId: string }> {
  const email = `ada-${randomBytes(4).toString("hex")}@example.test`;
  const r = await fetch(`${app.url}/api/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: `pw-${randomBytes(12).toString("hex")}`, name: "Ada" }) });
  const body = (await r.json()) as { ok?: boolean; token?: string; principal?: { id: string } };
  if (!r.ok || !body.token || !body.principal) throw new Error(`signup failed: ${r.status} ${JSON.stringify(body)}`);
  return { token: body.token, principalId: body.principal.id };
}

export interface FnResult { status: number; ok: boolean; value?: any; error?: { code: string; message: string } }

/** A person's call through FeltKit's own human API. */
export async function human(app: FeltKitApp, token: string, kind: "query" | "mutation", fn: string, args: Record<string, unknown> = {}): Promise<FnResult> {
  const r = await fetch(`${app.url}/api/${kind}/${encodeURIComponent(fn)}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ args }) });
  const body = (await r.json().catch(() => ({}))) as { ok?: boolean; value?: unknown; error?: { code: string; message: string } };
  return { status: r.status, ok: body.ok === true, ...(body.ok ? { value: body.value } : { error: body.error }) };
}

/** The live-query change stream a person's UI uses (FeltKit /api/events, SSE). Collects change events. */
export function changeStream(app: FeltKitApp, token: string) {
  const controller = new AbortController();
  const changes: Array<{ collections?: string[] }> = [];
  let ready: () => void;
  const opened = new Promise<void>((r) => { ready = r; });
  (async () => {
    const r = await fetch(`${app.url}/api/events`, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: controller.signal });
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, i); buffer = buffer.slice(i + 2);
        const event = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (event === "ready") ready!();
        if (event === "change" && data) changes.push(JSON.parse(data));
      }
    }
  })().catch(() => undefined);
  return {
    opened,
    changes,
    async waitFor(collection: string, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (changes.some((c) => c.collections?.includes(collection))) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    },
    close: () => controller.abort(),
  };
}

/** A raw MCP tools/call (stateless server: no session), for cases where the HTTP status matters. */
export async function rawToolCall(app: FeltKitApp, tool: string, args: Record<string, unknown>, headers: Record<string, string>) {
  const r = await fetch(app.mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as { result?: { isError?: boolean; structuredContent?: any; _meta?: Record<string, { code?: string }> }; error?: { message: string } } };
}

/** Evidence records of one invocation, read by a person through FeltKit (evidence:list is human-only). */
export async function evidenceFor(app: FeltKitApp, token: string, correlationId?: string) {
  const r = await human(app, token, "query", "evidence:list", { limit: 500 });
  if (!r.ok) throw new Error(`evidence:list refused: ${JSON.stringify(r.error)}`);
  const records = ((r.value?.records ?? r.value) as Array<Record<string, any>>);
  return correlationId ? records.filter((x) => x.correlationId === correlationId) : records;
}
