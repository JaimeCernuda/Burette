// The loopback service behind the views (CLIO MA23). CLIO proxies it under the
// app's capability-bound route on the sandbox origin and adds the bearer token,
// so the view loads Mol*, Ketcher and workspace files from a same-origin URL.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { lookup, readWhole, statHandle } from "./files.mjs";

const TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".html": "text/html; charset=utf-8",
};

export function startService({ assetsRoot, log }) {
  const token = randomBytes(24).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const server = http.createServer((request, response) => {
    const given = Buffer.from(String(request.headers.authorization || ""));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      response.writeHead(401, { "content-type": "text/plain" }).end("unauthorized");
      return;
    }
    handle(request, response, assetsRoot).catch((error) => {
      log(`service error ${request.url}: ${error.message}`);
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
      response.end("error");
    });
  });
  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, token }));
  });
  server.unref();
  return { ready, close: () => server.close() };
}

async function handle(request, response, assetsRoot) {
  const url = new URL(request.url, "http://service");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405).end();
    return;
  }
  if (parts[0] === "assets") {
    const target = path.resolve(assetsRoot, ...parts.slice(1));
    if (!target.startsWith(assetsRoot + path.sep)) {
      response.writeHead(404).end();
      return;
    }
    await sendFile(response, target, TYPES[path.extname(target)] || "application/octet-stream", "public, max-age=3600");
    return;
  }
  if (parts[0] === "files" && parts[1]) {
    let entry;
    try {
      entry = lookup(parts[1]);
    } catch {
      response.writeHead(404, { "content-type": "text/plain" }).end("handle_unknown");
      return;
    }
    if (!entry.path || entry.format === "cifCore") {
      const body = await readWhole(entry);
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(body);
      return;
    }
    await sendFile(response, entry.path, "text/plain; charset=utf-8", "no-store");
    return;
  }
  if (parts[0] === "stat" && parts[1]) {
    let body;
    try {
      body = await statHandle(parts[1]);
    } catch {
      response.writeHead(404, { "content-type": "text/plain" }).end("handle_unknown");
      return;
    }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
    return;
  }
  response.writeHead(404).end();
}

async function sendFile(response, target, type, cache) {
  let info;
  try {
    info = await stat(target);
  } catch {
    response.writeHead(404).end();
    return;
  }
  if (!info.isFile()) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": type, "content-length": info.size, "cache-control": cache });
  createReadStream(target).pipe(response);
}
