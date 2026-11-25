import express from "express";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { demo } from "./demo.mjs";
import { makeSso } from "./sso.mjs";

const app = express();
const port = Number(process.env.PORT || 18849);
const origin = process.env.YARN_PUBLIC_ORIGIN;
const publicHost = origin ? new URL(origin).host : null;
const sso = origin ? makeSso({
  origin, issuer: process.env.MOON_SSO_ISSUER, clientId: process.env.MOON_SSO_CLIENT_ID,
  secret: process.env.MOON_SSO_CLIENT_SECRET,
}) : null;
const staticPath = fileURLToPath(new URL("./public", import.meta.url));
const localRunner = process.platform === "win32" ? "./runner/bin/Release/net10.0/YarnPreview.exe" : "./runner/YarnPreview";
const runner = process.env.YARN_RUNNER || fileURLToPath(new URL(localRunner, import.meta.url));
const scriptsDir = resolve(process.env.SCRIPT_DIR || "scripts");
const scriptId = z.uuid();
const title = z.string().trim().min(1).max(100);
const source = z.string().max(60_000);
const revision = z.int().positive();
const previewArgs = z.object({
  source, startNode: z.string().trim().min(1).max(90).default("Start"),
  choices: z.array(z.int().nonnegative()).max(100).default([]),
  seed: z.int().min(0).max(2147483647).default(1),
});
const createArgs = z.object({ title, source: source.default("title: Start\n---\n你好。\n===\n") });
const saveArgs = z.object({ title, source, revision });

app.disable("x-powered-by");
app.use((req, res, next) => {
  const host = req.headers.host || "";
  const isPublic = publicHost !== null && host === publicHost && req.headers["x-forwarded-proto"] === "https";
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  if ((!isPublic && !local) || (req.headers.origin && req.headers.origin !== (isPublic ? origin : `http://${host}`))) {
    return res.status(403).json({ error: "无效的访问来源" });
  }
  res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" });
  if (isPublic) return sso(req, res, next);
  next();
});
app.use(["/api", "/mcp"], (req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (["POST", "PUT"].includes(req.method) && !req.is("application/json")) {
    return res.status(415).json({ error: "请求需要 application/json" });
  }
  next();
}, express.json({ limit: "512kb" }));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function read(id) {
  if (!scriptId.safeParse(id).success) throw new HttpError(404, "脚本不存在");
  const path = resolve(scriptsDir, `${id}.json`);
  if (!existsSync(path)) throw new HttpError(404, "脚本不存在");
  return JSON.parse(readFileSync(path, "utf8"));
}

function meta({ id, title, revision, updatedAt }) {
  return { id, title, revision, updatedAt, url: `${origin || `http://127.0.0.1:${port}`}/?script=${id}` };
}

function list() {
  return readdirSync(scriptsDir).filter((name) => name.endsWith(".json") && scriptId.safeParse(name.slice(0, -5)).success)
    .map((name) => meta(read(name.slice(0, -5))))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function persist(data) {
  const script = { ...data, updatedAt: new Date().toISOString() };
  const path = resolve(scriptsDir, `${script.id}.json`);
  writeFileSync(`${path}.tmp`, JSON.stringify(script) + "\n", { flush: true, mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  return script;
}

function create(input) {
  if (readdirSync(scriptsDir).filter((name) => name.endsWith(".json")).length >= 2000) {
    throw new HttpError(409, "脚本数量已达上限");
  }
  return persist({ ...input, id: crypto.randomUUID(), revision: 1 });
}

function save(id, input) {
  const script = read(id);
  if (script.revision !== input.revision) throw new HttpError(409, "服务器上的脚本已有更新，请先下载本地改动再重新加载。");
  return persist({ ...input, id, revision: script.revision + 1 });
}

let concurrentPreviews = 0;
async function run(input, checkOnly = false) {
  if (concurrentPreviews >= 3) throw new HttpError(429, "预览服务正忙，请稍后再试");
  concurrentPreviews++;
  try {
    return await new Promise((resolveRun, reject) => {
      const child = execFile(runner, [], {
        timeout: 4500, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DOTNET_EnableDiagnostics: "0",
          DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "1" },
      }, (error, stdout) => {
        if (error) {
          if (!error.killed) console.warn("Yarn runner failed", error.code);
          return reject(new HttpError(error.killed ? 422 : 503,
            error.killed ? "预览运行超时。请检查循环，或换一个起始节点。" : "Yarn 编译器暂时不可用"));
        }
        try { resolveRun(JSON.parse(stdout)); }
        catch { reject(new HttpError(503, "Yarn 编译器返回了无效结果")); }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ ...input, checkOnly }));
    });
  } finally {
    concurrentPreviews--;
  }
}

app.get("/healthz", (_, res) => res.json({ status: "ok", service: "moon-yarn-workbench" }));
app.get("/api/scripts", (_, res) => res.json(list()));
app.post("/api/scripts", (req, res) => res.status(201).json(create(createArgs.parse(req.body))));
app.get("/api/scripts/:id", (req, res) => res.json(read(req.params.id)));
app.put("/api/scripts/:id", (req, res) => res.json(save(req.params.id, saveArgs.parse(req.body))));
app.post("/api/preview", async (req, res) => res.json(await run(previewArgs.parse(req.body))));
app.post("/api/check", async (req, res) => res.json(await run(previewArgs.parse(req.body), true)));
app.use("/api", (_, res) => res.status(404).json({ error: "接口不存在" }));

function register(server, name, description, inputSchema, readOnlyHint, action) {
  server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint, destructiveHint: false } }, async (input) => {
    try {
      const data = await action(input);
      return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  });
}

function makeMcp() {
  const server = new McpServer({ name: "moon-yarn-workbench", version: "1.0.0" }, {
    instructions: "Moon Yarn 工作台。脚本采用相同的浏览器存储。写入前读取 revision。预览选项返回 id 和 available；按顺序将可用选项 ID 送到 choices。命令仅在预览中展示。",
  });
  register(server, "list_scripts", "列出工作台脚本及浏览器链接。", {}, true, () => ({ scripts: list() }));
  register(server, "get_script", "读取脚本源码和当前版本。", { id: scriptId }, true,
    ({ id }) => { const script = read(id); return { ...meta(script), source: script.source }; });
  register(server, "create_script", "新建 Yarn 脚本。", createArgs.shape, false, (input) => meta(create(input)));
  register(server, "save_script", "校验 revision 后覆盖该脚本的标题和源文本。", { id: scriptId, ...saveArgs.shape }, false,
    ({ id, ...input }) => meta(save(id, input)));
  register(server, "check_script", "用 Yarn Spinner 编译器检查语法和返回节点名。",
    { id: scriptId }, true, ({ id }) => run(previewArgs.parse({ source: read(id).source }), true));
  register(server, "preview_script", "运行已保存的脚本，返回文本、变量、可用选择和结局。",
    { id: scriptId, startNode: previewArgs.shape.startNode, choices: previewArgs.shape.choices, seed: previewArgs.shape.seed },
    true, ({ id, ...input }) => run({ ...input, source: read(id).source }));
  return server;
}

app.post("/mcp", async (req, res) => {
  const server = makeMcp();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { void server.close().catch(console.error); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.all("/mcp", (_, res) => res.status(405).set("Allow", "POST").end());
app.use(express.static(staticPath, { etag: true, maxAge: 0 }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof z.ZodError) return res.status(400).json({ error: "脚本内容不符合格式", issues: error.issues });
  if (error instanceof HttpError || [400, 413].includes(error.status)) {
    return res.status(error.status).json({ error: error.status === 413 ? "脚本内容过长" : error.message });
  }
  console.error(error);
  res.status(500).json({ error: "工作台服务错误" });
});

if (!existsSync(runner)) throw new Error("Missing Yarn preview runner");
mkdirSync(scriptsDir, { recursive: true, mode: 0o700 });
if (!list().length) create({ title: "示例 · 档案馆的钥匙", source: demo });
const server = app.listen(port, process.env.BIND_HOST || "127.0.0.1");
process.once("SIGTERM", () => server.close());
