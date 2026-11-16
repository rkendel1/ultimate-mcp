/**
 * Boundry Continuity M0.1 gateway process.
 *
 * Configuration (environment):
 *   BOUNDRY_STATE_DIR                 FeltDB state directory (this process takes its single-owner lock)
 *   BOUNDRY_PORT                      listen port on 127.0.0.1 (default 8787; 0 = any free port)
 *   AUTHBOUNDRY_URL                   AuthBoundry origin
 *   BOUNDRY_APPLICATION_ID            the application id AuthBoundry knows this gateway by
 *   AUTHBOUNDRY_CHECK_CREDENTIAL      the application's check credential (abc_…); never logged
 *
 * Prints one line `boundry-continuity listening <url>` once ready. Stops on SIGINT/SIGTERM,
 * closing FeltDB. A SIGKILL leaves nothing to clean up: FeltDB's committed writes are durable.
 */
import { createServer } from "node:http";
import { createFeltDB } from "@feltdb/core";
import { authBoundry } from "./authority.ts";
import { feltDbEvidence } from "./evidence.ts";
import { createGateway } from "./gateway.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`boundry-continuity: ${name} is required\n`);
    process.exit(2);
  }
  return value;
}

const stateDir = required("BOUNDRY_STATE_DIR");
const authorityUrl = required("AUTHBOUNDRY_URL");
const applicationId = required("BOUNDRY_APPLICATION_ID");
const checkCredential = required("AUTHBOUNDRY_CHECK_CREDENTIAL");
const port = Number(process.env.BOUNDRY_PORT ?? "8787");

const db = createFeltDB({ path: stateDir });
const evidence = feltDbEvidence(db);
const gateway = createGateway({
  db,
  evidence,
  authority: authBoundry({ url: authorityUrl, applicationId, checkCredential }),
  serverInfo: { name: "boundry-continuity", version: "0.0.1" },
});

const server = createServer((request, response) => {
  gateway.handle(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }));
  });
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  process.stdout.write(`boundry-continuity listening http://127.0.0.1:${actual}\n`);
});

const stop = () => {
  server.close();
  db.close().finally(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
