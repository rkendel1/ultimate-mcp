"""MCP client driver: the official Python SDK client (`mcp` 2.3.0). Test infrastructure only.

Same line protocol as ts-driver.ts: one JSON command per stdin line, one normalized JSON result
line per command, each over a fresh MCP connection (initialize, then the request).
"""
import asyncio
import json
import re
import sys

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.shared._httpx_utils import create_mcp_http_client


def _dump(value):
    if value is None:
        return None
    if hasattr(value, "model_dump"):
        return value.model_dump(by_alias=True, exclude_none=True)
    return value


async def run(command):
    headers = command.get("headers") or {}
    try:
        async with create_mcp_http_client(headers=headers) as http_client:
            async with streamable_http_client(command["url"], http_client=http_client) as streams:
                read_stream, write_stream = streams[0], streams[1]
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    if command.get("list"):
                        tools = await session.list_tools()
                        return {"ok": True, "tools": sorted(t.name for t in tools.tools)}
                    kwargs = {}
                    if command.get("meta"):
                        kwargs["meta"] = command["meta"]
                    result = await session.call_tool(command.get("tool", ""), command.get("args") or {}, **kwargs)
                    data = _dump(result) or {}
                    is_error = bool(data.get("isError"))
                    code = None
                    if is_error:
                        meta = data.get("_meta") or data.get("meta") or {}
                        code = (meta.get("dev.appport/error") or {}).get("code")
                        if code is None:
                            text = next((c.get("text", "") for c in data.get("content", []) if c.get("type") == "text"), "")
                            match = re.match(r"^([A-Z_]+):", text)
                            code = match.group(1) if match else None
                    return {"ok": True, "is_error": is_error, "code": code, "structured": data.get("structuredContent")}
    except BaseException as error:  # noqa: BLE001 - every failure is reported as a transport/protocol failure
        if isinstance(error, (KeyboardInterrupt, SystemExit)):
            raise
        return {"ok": False, "error": repr(error)}


async def main():
    loop = asyncio.get_running_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        if not line.strip():
            continue
        command = json.loads(line)
        result = await run(command)
        sys.stdout.write(json.dumps({"id": command["id"], **result}) + "\n")
        sys.stdout.flush()


asyncio.run(main())
