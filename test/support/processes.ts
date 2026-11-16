// Gateway process and MCP client drivers for the M0 acceptance tests. Test infrastructure only.
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PYTHON = process.env.BOUNDRY_TEST_PYTHON ?? join(ROOT, "test", "clients", ".venv", "bin", "python");

export interface GatewayProcess {
  url: string;
  proc: ChildProcess;
  kill(signal?: NodeJS.Signals): Promise<void>;
}

export async function startGateway(env: { stateDir: string; authorityUrl: string; applicationId: string; checkCredential: string }): Promise<GatewayProcess> {
  const proc = spawn(process.execPath, [join(ROOT, "src", "server.ts")], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      BOUNDRY_STATE_DIR: env.stateDir, BOUNDRY_PORT: "0",
      AUTHBOUNDRY_URL: env.authorityUrl, BOUNDRY_APPLICATION_ID: env.applicationId, AUTHBOUNDRY_CHECK_CREDENTIAL: env.checkCredential,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stderr?.on("data", (d) => { log = (log + d).slice(-4000); });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gateway did not start: ${log}`)), 30_000);
    createInterface({ input: proc.stdout! }).on("line", (line) => {
      const m = /listening (\S+)/.exec(line);
      if (m) { clearTimeout(timer); resolve(`${m[1]}/mcp`); }
    });
    proc.once("exit", (code) => { clearTimeout(timer); reject(new Error(`gateway exited (${code}): ${log}`)); });
  });
  return {
    url, proc,
    kill: (signal = "SIGTERM") => new Promise((resolve) => {
      if (proc.exitCode !== null) return resolve();
      proc.once("exit", () => resolve());
      proc.kill(signal);
    }),
  };
}

export type CallResult =
  | { ok: true; is_error: boolean; code: string | null; structured: Record<string, any> | null }
  | { ok: true; tools: string[] }
  | { ok: false; error: string };

export interface Driver {
  name: "typescript" | "python";
  list(url: string, headers?: Record<string, string>): Promise<CallResult>;
  call(url: string, tool: string, args: Record<string, unknown>, headers?: Record<string, string>, meta?: Record<string, unknown>): Promise<CallResult>;
  close(): void;
}

export function startDriver(name: Driver["name"]): Driver {
  const proc = name === "typescript"
    ? spawn(process.execPath, [join(ROOT, "test", "clients", "ts-driver.ts")], { cwd: ROOT, stdio: ["pipe", "pipe", "inherit"] })
    : spawn(PYTHON, [join(ROOT, "test", "clients", "py_driver.py")], { cwd: ROOT, stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map<string, (r: CallResult) => void>();
  createInterface({ input: proc.stdout! }).on("line", (line) => {
    const { id, ...rest } = JSON.parse(line) as { id: string } & CallResult;
    pending.get(id)?.(rest as CallResult);
    pending.delete(id);
  });
  const send = (command: Record<string, unknown>) => new Promise<CallResult>((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => reject(new Error(`${name} driver timed out`)), 60_000);
    pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
    proc.stdin!.write(JSON.stringify({ id, ...command }) + "\n");
  });
  return {
    name,
    list: (url, headers = {}) => send({ url, headers, list: true }),
    call: (url, tool, args, headers = {}, meta) => send({ url, headers, tool, args, ...(meta ? { meta } : {}) }),
    close: () => { proc.stdin!.end(); },
  };
}
