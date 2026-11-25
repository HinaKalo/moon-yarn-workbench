// Keep stdio and browser writes in the same server process.
import { createInterface } from "node:readline";

const endpoint = `http://127.0.0.1:${process.env.PORT || 18849}/mcp`;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  let id;
  try {
    ({ id } = JSON.parse(line));
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: line, signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    if (body && response.headers.get("content-type")?.includes("application/json")) {
      process.stdout.write(`${JSON.stringify(JSON.parse(body))}\n`);
    } else if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    console.error(error.message);
    if (id !== undefined) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "Moon Yarn 服务不可用" } })}\n`);
    }
  }
}
