// The harness's server half: starts burette-clio over stdio with the MCP SDK
// client, serves the host page and view resources, relays /rpc, and proxies
// /service/* to the server's loopback service with its bearer token (CLIO's MA23
// route). The browser never sees the port or the token, as in CLIO.
import { spawnSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../..");
const SERVICE_KEY = "ai.iowarp.clio/service";

function buildHost(outDir) {
  const out = path.join(outDir, "harness-host.js");
  const result = spawnSync("bun", ["build", path.join(here, "host.js"), "--outfile", out, "--target", "browser", "--format", "iife", "--define", "require=undefined"], { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return out;
}

export async function startHarness({ command, args, outDir, log = () => {} }) {
  const { readFileSync } = await import("node:fs");
  const hostScript = readFileSync(buildHost(outDir), "utf8");
  const transport = new StdioClientTransport({ command, args, stderr: "pipe", env: { ...process.env } });
  transport.stderr?.on("data", (chunk) => log(String(chunk).trimEnd()));
  const client = new Client({ name: "burette-harness", version: "0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const uiOf = new Map(tools.map((t) => [t.name, t._meta?.ui?.resourceUri ?? null]));
  let service = null;

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://harness");
      if (url.pathname === "/" || url.pathname === "/host.html") {
        response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><head><meta charset="utf-8"><title>Burette MCP Apps harness</title>
<style>body{margin:12px;font:13px system-ui}#context{white-space:pre-wrap;font:11px ui-monospace,monospace;max-height:220px;overflow:auto;background:#f5f5f7;padding:8px;border-radius:6px}</style></head>
<body><div id="views"></div><h4>Last ui/update-model-context</h4><pre id="context">(none)</pre><script>${hostScript}</script></body></html>`);
        return;
      }
      if (url.pathname === "/view") {
        const resource = await client.readResource({ uri: url.searchParams.get("uri") });
        response.writeHead(200, { "content-type": "text/html" }).end(resource.contents[0].text);
        return;
      }
      if (url.pathname === "/rpc") {
        const body = JSON.parse(await readBody(request));
        let result;
        if (body.method === "tools/call") {
          result = await client.callTool(body.params);
          const meta = result._meta ?? {};
          if (meta[SERVICE_KEY]) {
            service = meta[SERVICE_KEY];
            delete meta[SERVICE_KEY];
          }
          result.resourceUri = uiOf.get(body.params.name);
        } else if (body.method === "resources/read") {
          result = await client.readResource(body.params);
        } else {
          throw new Error(`unsupported ${body.method}`);
        }
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result }));
        return;
      }
      if (url.pathname.startsWith("/service/")) {
        if (!service) {
          response.writeHead(502).end("no service declared");
          return;
        }
        const upstream = await fetch(`http://127.0.0.1:${service.port}/${url.pathname.slice("/service/".length)}${url.search}`, {
          headers: { authorization: `Bearer ${service.token}` },
        });
        const headers = { "content-type": upstream.headers.get("content-type") || "application/octet-stream", "cache-control": "no-store" };
        response.writeHead(upstream.status, headers).end(Buffer.from(await upstream.arrayBuffer()));
        return;
      }
      response.writeHead(404).end();
    } catch (error) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    client,
    async close() {
      server.close();
      await client.close();
    },
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => { data += chunk; });
    request.on("end", () => resolve(data));
    request.on("error", reject);
  });
}
