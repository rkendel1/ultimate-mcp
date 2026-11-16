// MCP client driver: the official TypeScript SDK client. Test infrastructure only.
//
// Reads one JSON command per stdin line, runs it over a fresh MCP connection (initialize, then the
// request), and prints one normalized JSON result line. The Python driver (py_driver.py) speaks the
// same line protocol, so the orchestrator can run identical scenarios through both clients.
//
// command: {"id", "url", "headers"?: {..}, "list"?: true, "tool"?: str, "args"?: {..}, "meta"?: {..}}
// result:  {"id", "ok": true, "tools": [...]}                                  (list)
//          {"id", "ok": true, "is_error": bool, "code": str|null, "structured": obj|null}  (call)
//          {"id", "ok": false, "error": str}                                   (transport/protocol failure)
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

interface Command {
  id: string;
  url: string;
  headers?: Record<string, string>;
  list?: boolean;
  tool?: string;
  args?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

async function run(command: Command): Promise<Record<string, unknown>> {
  const transport = new StreamableHTTPClientTransport(new URL(command.url), { requestInit: { headers: command.headers ?? {} } });
  const client = new Client({ name: "boundry-m0-ts-driver", version: "1.0.0" });
  try {
    await client.connect(transport);
    if (command.list) {
      const { tools } = await client.listTools();
      return { ok: true, tools: tools.map((t) => t.name).sort() };
    }
    const result = (await client.callTool({ name: command.tool ?? "", arguments: command.args ?? {}, ...(command.meta ? { _meta: command.meta } : {}) })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content?: Array<{ type: string; text?: string }>;
      _meta?: Record<string, { code?: string }>;
    };
    const text = result.content?.find((c) => c.type === "text")?.text ?? "";
    const code = result.isError ? result._meta?.["dev.appport/error"]?.code ?? (/^([A-Z_]+):/.exec(text)?.[1] ?? null) : null;
    return { ok: true, is_error: result.isError === true, code, structured: result.structuredContent ?? null };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message ?? error) };
  } finally {
    await client.close().catch(() => undefined);
  }
}

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (!line.trim()) continue;
  const command = JSON.parse(line) as Command;
  const result = await run(command);
  process.stdout.write(JSON.stringify({ id: command.id, ...result }) + "\n");
}
