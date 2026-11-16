// Check 7a: CLIO can start the server as a command, and one stdio process serves
// both the MCP Apps views (ui:// resources) and the tools.
// Usage: node packages/clio-burette/tests/stdio-check.mjs [command args...]
// (defaults to: node packages/clio-burette/src/clio_burette/bundle/server.mjs)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const [command, ...args] = process.argv.length > 2
  ? process.argv.slice(2)
  : [process.execPath, path.join(here, "../src/clio_burette/bundle/server.mjs")];
const sample = path.join(here, "../../../samples/mini.pdb");

const transport = new StdioClientTransport({ command, args, stderr: "inherit", env: { ...process.env } });
const client = new Client({ name: "burette-clio-check", version: "0" });
await client.connect(transport);
const { tools } = await client.listTools();
const { resources } = await client.listResources();
const out = {
  server: client.getServerVersion(),
  tools: tools.map((t) => ({
    name: t.name,
    resourceUri: t._meta?.ui?.resourceUri ?? null,
    visibility: t._meta?.ui?.visibility ?? null,
    paths: t._meta?.["ai.iowarp.clio/paths"] ?? null,
  })),
  resources: resources.map((r) => ({ uri: r.uri, mimeType: r.mimeType })),
};
const viewer = await client.readResource({ uri: "ui://burette/molecular-viewer-v21.html" });
out.viewerResource = { mimeType: viewer.contents[0].mimeType, bytes: viewer.contents[0].text.length };
const opened = await client.callTool({ name: "open_structure", arguments: { path: sample } });
const meta = opened._meta ?? {};
out.openStructure = {
  text: opened.content[0].text,
  service: meta["ai.iowarp.clio/service"] ? { port: meta["ai.iowarp.clio/service"].port, token: "(redacted)" } : null,
  structure: { ...meta["burette/structure"], data: meta["burette/structure"]?.data ? `${meta["burette/structure"].data.length} chars inline` : undefined },
};
const port = meta["ai.iowarp.clio/service"]?.port;
const token = meta["ai.iowarp.clio/service"]?.token;
const handle = meta["burette/structure"]?.handle;
const noAuth = await fetch(`http://127.0.0.1:${port}/files/${handle}`);
const withAuth = await fetch(`http://127.0.0.1:${port}/files/${handle}`, { headers: { authorization: `Bearer ${token}` } });
out.service = { withoutToken: noAuth.status, withToken: withAuth.status, bytes: (await withAuth.text()).length };
console.log(JSON.stringify(out, null, 2));
await client.close();
