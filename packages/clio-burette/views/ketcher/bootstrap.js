// Ketcher view bootstrap: the MCP Apps bridge for Burette's Ketcher editor. It
// loads the editor module from the loopback service, seeds it from the opening
// result, and returns every edit to the agent as MOL and SMILES (the server keeps
// the latest for get_ketcher_structure / save_ketcher_structure, and the view's
// context carries it to the model).
import { App } from "@modelcontextprotocol/ext-apps";
import { z } from "zod";

const SERVICE_KEY = "ai.iowarp.clio/service";
const KETCHER_META = "burette/ketcher";
const REPORT_DELAY_MS = 400;
const MAX_CONTEXT_MOLFILE = 32 * 1024;

const statusLine = document.getElementById("status");
const root = document.getElementById("root");
const app = new App({ name: "burette-ketcher-editor", version: "0.1.0" }, { tools: { listChanged: true } }, { autoResize: true });

let api = null;
let editor = null;
let surfaceId = null;
let pendingSeed = null;
let reportTimer = null;
let lastReport = null;
let applyingSeed = false;

function setStatus(message, kind = "info") {
  statusLine.textContent = message || "";
  statusLine.dataset.kind = kind;
}

function serviceUrlFrom(context) {
  const entry = context?.[SERVICE_KEY];
  return entry && typeof entry.url === "string" ? entry.url.replace(/\/?$/u, "/") : null;
}

/** Selected Ketcher atoms as 0-based positions in the MOL block, with elements. */
function selectedAtoms() {
  let ids = [];
  try {
    ids = editor?.ketcher()?.editor?.selection?.()?.atoms ?? api.getSelectedAtomIndexes();
  } catch {
    ids = api.getSelectedAtomIndexes();
  }
  if (!ids?.length) return [];
  let struct = null;
  try {
    struct = editor?.ketcher()?.editor?.struct?.();
  } catch {
    struct = null;
  }
  const order = new Map();
  const labels = new Map();
  if (struct?.atoms?.forEach) {
    let position = 0;
    struct.atoms.forEach((atom, id) => {
      order.set(id, position);
      labels.set(id, atom?.label ?? "?");
      position += 1;
    });
  }
  return ids
    .map((id) => ({ index: order.get(id) ?? id, element: labels.get(id) ?? "?" }))
    .sort((a, b) => a.index - b.index);
}

async function snapshot() {
  // One conversion at a time: concurrent Indigo worker calls can swap their replies.
  const smiles = await api.getSmiles().catch(() => null);
  const molfile = await api.getMolfile().catch(() => null);
  return { smiles, molfile, selection: selectedAtoms() };
}

function scheduleReport() {
  if (applyingSeed) return;
  clearTimeout(reportTimer);
  reportTimer = setTimeout(() => { report().catch((error) => setStatus(error.message, "error")); }, REPORT_DELAY_MS);
}

async function report() {
  if (!api || !surfaceId) return;
  const current = await snapshot();
  lastReport = current;
  const selection = current.selection;
  await app.callServerTool({
    name: "ketcher_report",
    arguments: { surface_id: surfaceId, smiles: current.smiles, molfile: current.molfile, selection: selection.map((a) => a.index) },
  });
  const molfile = current.molfile && current.molfile.length <= MAX_CONTEXT_MOLFILE ? current.molfile : null;
  const text = [
    `Ketcher (${surfaceId}) shows ${current.smiles ? `SMILES ${current.smiles}` : "an empty canvas"}.`,
    selection.length ? `Selected atoms (0-based MOL order): ${selection.map((a) => `${a.element}${a.index}`).join(", ")}.` : "",
    "Use get_ketcher_structure for the MOL block or save_ketcher_structure to write it.",
  ].filter(Boolean).join(" ");
  await app.updateModelContext({
    content: [{ type: "text", text }],
    structuredContent: { burette: "ketcher/v1", surfaceId, smiles: current.smiles, molfile, selection },
  });
  setStatus(current.smiles ? `Reported ${current.smiles}` : "Reported an empty canvas");
}

async function applySeed(seed) {
  surfaceId = seed.surfaceId ?? surfaceId;
  if (!api) {
    pendingSeed = seed;
    return;
  }
  if (seed.content) {
    applyingSeed = true;
    try {
      await api.setMolecule(seed.content);
    } finally {
      applyingSeed = false;
    }
  }
  await report();
}

function registerTools() {
  app.registerTool("get_ketcher_structure", {
    title: "Get Ketcher structure",
    description: "Return the structure drawn in this Ketcher view as SMILES and MOL, with the selected atoms.",
    inputSchema: z.object({}),
  }, async () => {
    const current = await snapshot();
    return { content: [{ type: "text", text: current.smiles ?? "(empty)" }], structuredContent: { surfaceId, ...current } };
  });
  app.registerTool("set_ketcher_structure", {
    title: "Set Ketcher structure",
    description: "Replace the drawing in this Ketcher view with a SMILES or MOL block.",
    inputSchema: z.object({ smiles: z.string().optional(), molfile: z.string().optional() }),
  }, async ({ smiles, molfile }) => {
    await api.setMolecule(molfile ?? smiles ?? "");
    await report();
    return { content: [{ type: "text", text: `Set ${lastReport?.smiles ?? "structure"}.` }], structuredContent: { surfaceId, ...lastReport } };
  });
}

app.ontoolresult = (params) => {
  const seed = (params?._meta ?? params?.meta)?.[KETCHER_META];
  if (seed && typeof seed === "object") applySeed(seed).catch((error) => setStatus(error.message, "error"));
};

async function main() {
  registerTools();
  setStatus("Connecting…");
  await app.connect();
  const service = serviceUrlFrom(app.getHostContext());
  if (!service) {
    setStatus("This host gives the view no Burette service, which the Ketcher editor needs to load.", "error");
    return;
  }
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `${service}assets/ketcher/ketcher-app.css`;
  document.head.appendChild(link);
  setStatus("Loading Ketcher…");
  const module = await import(/* @vite-ignore */ `${service}assets/ketcher/ketcher-app.js`);
  editor = module.mount(root, {
    onStatus: (message) => setStatus(message),
    onReady: (ready) => {
      api = ready;
      api.subscribeChange(scheduleReport);
      api.subscribeSelection(scheduleReport);
      // Ketcher's own selection event: Burette's wrapper does not see it in this view.
      try {
        editor.ketcher()?.editor?.event?.selectionChange?.add(scheduleReport);
      } catch (error) {
        console.warn("Burette: no Ketcher selection events", error);
      }
      setStatus("Ready");
      if (pendingSeed) {
        const seed = pendingSeed;
        pendingSeed = null;
        applySeed(seed).catch((error) => setStatus(error.message, "error"));
      }
    },
  });
}

window.__buretteKetcher = { snapshot: () => (api ? snapshot() : null), surface: () => surfaceId, ketcher: () => editor?.ketcher() };
main().catch((error) => {
  console.error(error);
  setStatus(error.message || String(error), "error");
});
