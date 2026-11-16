// Local AuthBoundry for the M0 acceptance tests. Test infrastructure only.
//
// Starts the REAL AuthBoundry binary with REAL FeltDB persistence in a scratch directory, and sets up
// one application the way AuthBoundry's own conformance harness does
// (authboundry/conformance/authority-integrity/lib/authority.mjs): organization, application,
// contract, agent principals, people with policies, a check credential, agent credentials, and the
// `agent_required` credential policy. Every value is synthetic. No hosted tenant is contacted.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const AUTHBOUNDRY_SRC = process.env.AUTHBOUNDRY_SRC ?? "/home/user/authboundry";
export const AUTHBOUNDRY_BIN = process.env.AUTHBOUNDRY_BIN ?? join(AUTHBOUNDRY_SRC, "target", "debug", "authboundry");

const TENANT = "continuity";
const ADMIN = "local-admin";
const OWNER_GRANTS = ["identity.read", "identity.write", "principal.read", "principal.write", "policy.read", "policy.write",
  "agent.read", "agent.write", "delegation.read", "delegation.create", "delegation.revoke",
  "audit.read", "evidence.read", "authorization.read", "session.admin"];
const FLOW = `use auth {
  providers = [local]
  tenant = true
  isolation = "strict"
  agents = true
  claims = {
    role = enum["owner", "admin", "member", "user"]
  }
  policy = {}
  storage = {
    authority = "feltdb"
    audit = "feltdb"
    reporting = "authboundry_projection"
  }
}

use control_plane {
  authoritative_state = [organization, deployment, provisioning, subscription_reference, billing_account_reference]
  storage = "feltdb"
}
`;

export const APPLICATION = "boundry-continuity";
/** The application's AuthBoundry contract: one capability name per AppPort capability. */
export const CAPABILITIES = ["work.task.create", "evidence.list", "evidence.get"];

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      const port = typeof address === "object" && address ? address.port : 0;
      s.close(() => resolve(port));
    });
  });
}

export interface AgentCredential {
  principal: string;
  secret: string;
  id: string;
}

export interface LocalAuthority {
  url: string;
  dir: string;
  checkCredential: string;
  /** A control-plane call as the local administrator (the operator, never an agent). */
  control(path: string, init?: { method?: string; body?: unknown; query?: Record<string, string> }): Promise<{ status: number; body: any }>;
  addAgent(principal: string, scopes?: string[]): Promise<AgentCredential>;
  addPerson(principal: string, capabilities?: string[]): Promise<void>;
  delegate(delegator: string, delegate: string, capabilities: string[]): Promise<string>;
  revokeDelegation(id: string): Promise<void>;
  revokeCredential(credentialId: string): Promise<void>;
  stop(): void;
  start(): Promise<void>;
  cleanup(): void;
}

function killGroup(proc: ChildProcess | null) {
  if (!proc?.pid) return;
  try { process.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ }
}

export async function startLocalAuthority(): Promise<LocalAuthority> {
  const dir = mkdtempSync(join(tmpdir(), "boundry-authboundry-"));
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(join(dir, "authboundry.flow"), FLOW);
  const adminSecret = `synthetic-admin-${randomBytes(16).toString("hex")}`;
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let proc: ChildProcess | null = null;
  let session: string | null = null;
  let log = "";

  const start = async () => {
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", TMPDIR: process.env.TMPDIR,
      AUTHBOUNDRY_FELTDB_PATH: join(dir, "state"),
      AUTHBOUNDRY_FELTDB_BRIDGE: join(AUTHBOUNDRY_SRC, "bridge", "feltdb-store.cjs"),
      AUTHBOUNDRY_APPPORT_SERVICES_BRIDGE: join(AUTHBOUNDRY_SRC, "bridge", "appport-services.cjs"),
      AUTHBOUNDRY_NODE: process.execPath,
      AUTHBOUNDRY_PORTAL_ORIGIN: "http://localhost",
      AUTHBOUNDRY_ACCOUNTS: `${ADMIN}:${adminSecret}:role=owner@${TENANT}`,
    };
    const args = ["serve", join(dir, "authboundry.flow"), "--addr", `127.0.0.1:${port}`, "--tenant", TENANT,
      ...OWNER_GRANTS.flatMap((g) => ["--grant", `authority.${g}=role:owner`])];
    proc = spawn(AUTHBOUNDRY_BIN, args, { cwd: dir, env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
    proc.stdout?.on("data", (d) => { log = (log + d).slice(-8000); });
    proc.stderr?.on("data", (d) => { log = (log + d).slice(-8000); });
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        const r = await fetch(`${url}/ready`);
        if (r.ok && ((await r.json()) as { ready?: boolean }).ready) break;
      } catch { /* not yet */ }
      if (proc.exitCode !== null) throw new Error(`AuthBoundry exited during start: ${log.slice(-1500)}`);
      if (Date.now() > deadline) { killGroup(proc); throw new Error(`AuthBoundry not ready: ${log.slice(-1500)}`); }
      await sleep(100);
    }
    session = null;
  };

  const signIn = async () => {
    const r = await fetch(`${url}/_authboundry/browser/credentials?tenant=${TENANT}`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ application: "portal", connector: "local", tenant: TENANT, return_to: "/", username: ADMIN, password: adminSecret }),
    });
    const body = (await r.json().catch(() => ({}))) as { credential?: string };
    if (!r.ok || typeof body.credential !== "string") throw new Error(`admin sign-in failed (${r.status})`);
    session = body.credential;
    return session;
  };

  const control: LocalAuthority["control"] = async (path, init = {}) => {
    const s = session ?? (await signIn());
    const u = new URL(path, url);
    u.searchParams.set("tenant", TENANT);
    for (const [k, v] of Object.entries(init.query ?? {})) u.searchParams.set(k, v);
    const r = await fetch(u, {
      method: init.method ?? "GET",
      headers: { accept: "application/json", "x-authboundry-session": s, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const must = async (label: string, path: string, init: Parameters<LocalAuthority["control"]>[1], ok = (st: number, _b: any) => st < 300) => {
    const r = await control(path, init);
    if (!ok(r.status, r.body)) throw new Error(`${label}: ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
    return r.body;
  };
  const created = (st: number, b: any) => st < 300 || (st === 409 && /_exists$/.test(String(b?.reason ?? "")));
  const appPath = `/_authboundry/control-plane/applications/${APPLICATION}`;

  await start();
  await must("organization", "/_authboundry/control-plane/organizations", { method: "POST", body: { id: APPLICATION, name: APPLICATION, authority_tenant_id: TENANT } }, created);
  await must("application", "/_authboundry/control-plane/applications", { method: "POST", body: { id: APPLICATION, project_id: APPLICATION, name: APPLICATION, production_url: "http://localhost", environment: "production" } }, created);
  await must("contract", `${appPath}/contracts`, { method: "POST", body: { authority_source: "external", version: "1.0.0", capabilities: CAPABILITIES } });
  const checkCredential = (await must("check credential", `${appPath}/check-credentials`, { method: "POST", body: { label: "boundry-continuity" } })).secret as string;
  await must("agent credential policy", `${appPath}/agent-credential-policy`, { method: "POST", body: { policy: "agent_required" } });

  const authority: LocalAuthority = {
    url, dir, checkCredential, control,
    async addAgent(principal, scopes = CAPABILITIES) {
      await must("agent", "/_authboundry/agents", { method: "POST", body: { id: principal, name: principal, application: APPLICATION } }, created);
      const body = await must("agent credential", `${appPath}/agent-credentials`, { method: "POST", body: { principal_id: principal, scopes, ttl_seconds: 86_400, max_lifetime_seconds: 30 * 86_400 } });
      return { principal, secret: body.secret as string, id: body.credential.id as string };
    },
    async addPerson(principal, capabilities = CAPABILITIES) {
      await must("principal", `${appPath}/principals`, { method: "POST", body: { id: principal, kind: "human", claims: { role: "member" } } }, (st, b) => st < 300 || (st === 409 && b?.reason === "principal_exists"));
      await must("policy", "/_authboundry/policies", { method: "POST", body: { application: APPLICATION, principal_id: principal, capabilities } });
    },
    async delegate(delegator, delegate, capabilities) {
      const id = `del-${randomBytes(8).toString("hex")}`;
      await must("delegation", "/_authboundry/delegations", { method: "POST", body: { id, delegator, delegate, capabilities: capabilities.join(","), application: APPLICATION } });
      return id;
    },
    async revokeDelegation(id) {
      await must("revoke delegation", `/_authboundry/delegations/${encodeURIComponent(id)}/revoke`, { method: "POST", body: {} });
    },
    async revokeCredential(credentialId) {
      await must("revoke credential", `${appPath}/agent-credentials/${encodeURIComponent(credentialId)}/revoke`, { method: "POST", body: {} });
    },
    stop() { killGroup(proc); proc = null; },
    start,
    cleanup() { killGroup(proc); if (process.env.BOUNDRY_KEEP_CASES !== "1") rmSync(dir, { recursive: true, force: true }); },
  };
  return authority;
}
