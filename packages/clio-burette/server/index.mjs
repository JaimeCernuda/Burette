// burette-clio: one stdio MCP server that serves Burette's MCP Apps views (Mol*
// molecular viewer, Ketcher editor) and the local workspace tools CLIO needs.
// The views load their runtime and workspace files from a loopback service that
// CLIO proxies (MA23); hosts without it fall back to resources/read and chunked
// tool reads through the MCP Apps bridge.
import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { editStructureFragmentFile } from "../../../plugins/burette-agent/mcp/lib/structure-components.mjs";
import { summarizeStructureFile } from "../../../plugins/burette-agent/mcp/lib/structure-summary.mjs";
import {
  countXyzFrames, INLINE_BYTES, lookup, readChunk, readWhole, registerFile, registerText, statHandle, ToolInputError,
} from "./files.mjs";
import { editFile } from "./geometry.mjs";
import { startService } from "./service.mjs";

export const VIEWER_URI = "ui://burette/molecular-viewer-v21.html";
export const KETCHER_URI = "ui://burette/ketcher-editor-v1.html";
const VERSION = "0.1.0";
const SERVICE_KEY = "ai.iowarp.clio/service";
const PATHS_KEY = "ai.iowarp.clio/paths";
const STATE_KEY = "ai.iowarp.clio/state";
const STRUCTURE_META = "burette/structure";
const KETCHER_META = "burette/ketcher";
const MAX_KETCHER_BYTES = 1024 * 1024;

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(ROOT, "assets");
const log = (message) => process.stderr.write(`[burette-clio] ${message}\n`);
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

const service = startService({ assetsRoot: ASSETS, log });
const local = (access = "read") => ({ machine: "local", access });

const VIEWER_STATE = [
  { key: "frame", tool: "set_frame", description: "The shown frame (0-based) of a trajectory or normal mode." },
  { key: "mode", tool: "play_mode", description: "The path of the multi-frame XYZ mode or trajectory playing." },
  { key: "focus", tool: "focus", description: "The atoms or residues the camera is focused on." },
  { key: "selection", description: "Atoms the person selected: 0-based file indices, elements, residues, coordinates." },
  { key: "region", description: "The last region the person drew over the view and the atoms under it." },
  { key: "path", description: "The workspace file shown." },
  { key: "frame_count", description: "How many frames the shown file has." },
  { key: "playing", description: "Whether the frames are playing." },
];

const server = new McpServer(
  { name: "burette", version: VERSION },
  {
    instructions: [
      "Burette shows molecular structures from workspace files in Mol* and edits molecules in Ketcher.",
      "open_structure opens PDB, mmCIF, CIF (unit cell), SDF/MOL, XYZ (multi-frame trajectories) and PDBQT poses by path.",
      "play_mode plays a normal mode or trajectory given as a multi-frame XYZ file. The open view also offers app tools",
      "(set_frame, play_mode, focus, describe_region, get_view_state). The person's atom selection reaches you as the view's",
      "context: 0-based atom indices in file order, elements, residues and coordinates. The person can set a bond, angle or",
      "dihedral or drag an atom in the viewer's Edit mode; set_geometry and move_atom do the same. Every edit writes a new",
      "file next to the source and the view's context names it (edit.edited_path). open_ketcher opens a 2D editor;",
      "get_ketcher_structure returns the person's edited molecule and save_ketcher_structure writes it to a file.",
    ].join(" "),
  },
);

function text(value) {
  return [{ type: "text", text: value }];
}

function failure(error) {
  const code = error instanceof ToolInputError ? error.code : "tool_failed";
  return {
    isError: true,
    content: text(`${error.message}`),
    structuredContent: { ok: false, error: { code, message: error.message } },
  };
}

function guarded(handler) {
  return async (input, extra) => {
    try {
      return await handler(input ?? {}, extra);
    } catch (error) {
      log(error instanceof ToolInputError ? `tool refused (${error.code}): ${error.message}` : `tool error: ${error.stack || error.message}`);
      return failure(error);
    }
  };
}

async function serviceMeta() {
  const { port, token } = await service.ready;
  return { [SERVICE_KEY]: { port, token } };
}

async function describe(entry) {
  let summary = null;
  if (entry.path) {
    try {
      summary = await summarizeStructureFile(entry.path);
    } catch (error) {
      summary = { summaryLine: `No summary: ${error.message}` };
    }
  }
  let inline = null;
  let frames = summary?.counts?.models ?? null;
  const countFrames = entry.format === "xyz" && entry.byteCount <= 64 * 1024 * 1024;
  if (entry.byteCount <= INLINE_BYTES || entry.format === "cifCore" || countFrames) {
    const content = (await readWhole(entry)).toString("utf8");
    if (entry.format === "xyz") frames = countXyzFrames(content);
    if (Buffer.byteLength(content) <= INLINE_BYTES) inline = content;
  }
  return { summary, inline, frames };
}

function focusSchema() {
  return z.object({
    atoms: z.array(z.number().int().min(0)).max(4096).optional()
      .describe("0-based atom indices in file order."),
    residues: z.array(z.string().max(32)).max(512).optional()
      .describe('Residues as "A:45", "45" or "HIS45" (chain:number, number, or name+number).'),
  }).optional();
}

async function openStructureResult(entry, { frame, focus, play, fps, loop, supercell, label, keepCamera }) {
  const { summary, inline, frames } = await describe(entry);
  const shown = label || entry.label;
  const lines = [
    `Opened ${shown} in Burette (${entry.format}, ${entry.byteCount} bytes).`,
    summary?.summaryLine ? summary.summaryLine + "." : null,
    frames && frames > 1 ? `${frames} frames${play ? ", playing" : ""}.` : null,
    entry.packed ? `Crystal: ${entry.packed.operators} symmetry operators on ${entry.packed.sites} sites packed into a ${entry.packed.atoms}-atom P1 unit cell; view atom indices count that packed cell, and atom names are the CIF site labels.` : null,
    "Selections the person makes arrive as the view's context; the view's app tools set the frame, focus and region.",
  ].filter(Boolean);
  return {
    content: text(lines.join(" ")),
    structuredContent: {
      ok: true,
      path: entry.path,
      label: shown,
      format: entry.format,
      byteCount: entry.byteCount,
      frames,
      ...(entry.packed ? { packedCell: entry.packed } : {}),
      summary: summary ? {
        line: summary.summaryLine ?? null,
        counts: summary.counts ?? null,
        rows: Array.isArray(summary.rows) ? summary.rows.slice(0, 12) : null,
      } : null,
    },
    _meta: {
      ...(await serviceMeta()),
      [STRUCTURE_META]: {
        handle: entry.handle,
        path: entry.path,
        label: shown,
        format: entry.format,
        byteCount: entry.byteCount,
        mtimeMs: entry.mtimeMs,
        ...(inline !== null ? { data: inline } : {}),
        ...(Number.isInteger(frame) ? { frame } : {}),
        ...(focus ? { focus } : {}),
        ...(play ? { play: true, fps: fps ?? 10, loop: loop !== false } : {}),
        ...(supercell ? { supercell } : {}),
        ...(keepCamera ? { keepCamera: true } : {}),
        ...(entry.packed ? { packedCell: entry.packed } : {}),
      },
    },
  };
}

// ---- Views -----------------------------------------------------------------

const resourceMeta = { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } };

registerAppResource(server, "Burette molecular viewer", VIEWER_URI, {
  description: "Mol* viewer for workspace structures with selection, region, frame and focus reporting.",
  _meta: resourceMeta,
}, async () => ({
  contents: [{ uri: VIEWER_URI, mimeType: RESOURCE_MIME_TYPE, text: read("views/viewer.html"), _meta: resourceMeta }],
}));

registerAppResource(server, "Burette Ketcher editor", KETCHER_URI, {
  description: "Ketcher 2D chemical editor whose edits return to the agent as MOL and SMILES.",
  _meta: resourceMeta,
}, async () => ({
  contents: [{ uri: KETCHER_URI, mimeType: RESOURCE_MIME_TYPE, text: read("views/ketcher.html"), _meta: resourceMeta }],
}));

// Runtime assets for hosts without the loopback service (resources/read fallback).
for (const [name, file, mimeType] of [
  ["Mol* runtime", "molstar.js", "text/javascript"],
  ["Mol* styles", "molstar.css", "text/css"],
]) {
  const uri = `ui://burette/assets/${file}`;
  server.registerResource(name, uri, { mimeType, description: `${name} for the Burette viewer.` }, async () => ({
    contents: [{ uri, mimeType, text: readFileSync(path.join(ASSETS, file), "utf8") }],
  }));
}

// ---- Model-facing tools ------------------------------------------------------

registerAppTool(server, "open_structure", {
  title: "Open structure",
  description:
    "Open a workspace structure file in the Burette Mol* viewer: PDB, PDBQT poses, mmCIF, CIF with unit cell, SDF/MOL, XYZ "
    + "(multi-frame XYZ is a trajectory), GRO, MOL2. Optionally start at a frame or focus atoms/residues. "
    + "The person's selection comes back as the view's context.",
  inputSchema: {
    path: z.string().min(1).describe("Workspace path of the structure file."),
    frame: z.number().int().min(0).optional().describe("0-based frame or model to show first."),
    focus: focusSchema(),
    supercell: z.array(z.number().int().min(1).max(4)).length(3).optional()
      .describe("For a crystal (CIF with a cell): repeat the unit cell a×b×c times."),
    label: z.string().max(120).optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  _meta: {
    ui: { resourceUri: VIEWER_URI },
    [PATHS_KEY]: { path: local("read") },
    [STATE_KEY]: VIEWER_STATE,
  },
}, guarded(async (input) => {
  const entry = await registerFile(input.path);
  return openStructureResult(entry, input);
}));

registerAppTool(server, "play_mode", {
  title: "Play mode or trajectory",
  description:
    "Play a vibrational normal mode or short trajectory written as a multi-frame XYZ file (for example from an ASE "
    + "vibrations analysis), looping in the viewer. Called from an open view, it switches that view to the new file.",
  inputSchema: {
    path: z.string().min(1).optional().describe("Workspace path of the multi-frame XYZ."),
    mode: z.string().min(1).optional().describe("Same as path; lets a chart channel named 'mode' pass the file."),
    fps: z.number().min(1).max(60).optional(),
    loop: z.boolean().optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  _meta: {
    ui: { resourceUri: VIEWER_URI },
    [PATHS_KEY]: { path: local("read"), mode: local("read") },
    [STATE_KEY]: VIEWER_STATE,
  },
}, guarded(async (input) => {
  const file = input.path ?? input.mode;
  if (!file) throw new ToolInputError("path_missing", "Give the path of the multi-frame XYZ to play.");
  const entry = await registerFile(file);
  const result = await openStructureResult(entry, { ...input, play: true });
  result.structuredContent.mode = entry.path;
  return result;
}));

async function geometryResult(input, edit) {
  const source = await registerFile(input.path);
  if (!source.path) throw new ToolInputError("no_file", "Geometry edits need a workspace file.");
  const record = await editFile(source.path, source.format, edit);
  const entry = await registerFile(record.edited_path);
  const result = await openStructureResult(entry, { keepCamera: true });
  const unitOf = { distance: " Å", angle: "°", dihedral: "°" }[record.kind] ?? "";
  const what = record.kind === "move_atom"
    ? `moved atom ${record.atoms[0]} from (${record.before.join(", ")}) to (${record.after.join(", ")}) Å`
    : `set the ${record.kind} of atoms ${record.atoms.join("-")} from ${record.before}${unitOf} to ${record.after}${unitOf}`;
  result.content = text(`Burette ${what} and wrote ${record.edited_path} (the source ${record.source_path} is unchanged). ${record.note} Moved atoms: ${record.moved_atoms.join(", ")}.`);
  result.structuredContent.edit = record;
  result._meta[STRUCTURE_META].edit = record;
  return result;
}

const editAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

registerAppTool(server, "set_geometry", {
  title: "Set geometry",
  description:
    "Set a bond length (2 atoms), angle (3) or dihedral (4 bonded atoms, 0-based file indices) in an XYZ, PDB/PDBQT or "
    + "SDF/MOL file. The smaller fragment on the moving side turns or shifts rigidly; ring bonds and non-bonded pairs "
    + "are refused (bonds: covalent radii x 1.15). Writes a NEW file next to the source (name.editN.ext) and opens it.",
  inputSchema: {
    path: z.string().min(1),
    kind: z.enum(["distance", "angle", "dihedral"]),
    atoms: z.array(z.number().int().min(0)).min(2).max(4),
    value: z.number().describe("Å for a distance, degrees for an angle or dihedral."),
    frame: z.number().int().min(0).optional().describe("Frame or model to edit (default 0); only that frame is written."),
  },
  annotations: editAnnotations,
  _meta: { ui: { resourceUri: VIEWER_URI }, [PATHS_KEY]: { path: local("read") }, [STATE_KEY]: VIEWER_STATE },
}, guarded(async (input) => geometryResult(input, { kind: input.kind, atoms: input.atoms, value: input.value, frame: input.frame })));

registerAppTool(server, "move_atom", {
  title: "Move atom",
  description:
    "Move one atom (0-based file index) to a position or by a displacement in Å, in an XYZ, PDB/PDBQT or SDF/MOL file. "
    + "Writes a NEW file next to the source (name.editN.ext) and opens it.",
  inputSchema: {
    path: z.string().min(1),
    atom: z.number().int().min(0),
    position: z.array(z.number()).length(3).optional(),
    displacement: z.array(z.number()).length(3).optional(),
    frame: z.number().int().min(0).optional(),
  },
  annotations: editAnnotations,
  _meta: { ui: { resourceUri: VIEWER_URI }, [PATHS_KEY]: { path: local("read") }, [STATE_KEY]: VIEWER_STATE },
}, guarded(async (input) => geometryResult(input, {
  kind: "move_atom", atoms: [input.atom], position: input.position, displacement: input.displacement, frame: input.frame,
})));

registerAppTool(server, "open_pdb_entry", {
  title: "Open PDB entry",
  description: "Fetch one entry from the RCSB Protein Data Bank by its four-character ID and open it in the viewer.",
  inputSchema: { pdb_id: z.string().regex(/^[0-9][A-Za-z0-9]{3}$/u).describe("Four-character PDB ID, e.g. 1HTB.") },
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: { ui: { resourceUri: VIEWER_URI }, [STATE_KEY]: VIEWER_STATE },
}, guarded(async ({ pdb_id: id }) => {
  const upper = id.toUpperCase();
  const response = await fetch(`https://files.rcsb.org/download/${upper}.cif`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new ToolInputError("pdb_fetch_failed", `RCSB answered ${response.status} for ${upper}.`);
  const body = await response.text();
  const entry = registerText(body, { label: `${upper}.cif`, format: "mmcif" });
  return openStructureResult(entry, {});
}));

server.registerTool("summarize_structure", {
  title: "Summarize structure",
  description: "Count atoms, residues, chains, ligands, waters, ions, elements and models in a structure file without opening a view.",
  inputSchema: { path: z.string().min(1) },
  annotations: { readOnlyHint: true, openWorldHint: false },
  _meta: { [PATHS_KEY]: { path: local("read") } },
}, guarded(async ({ path: file }) => {
  const summary = await summarizeStructureFile(path.resolve(file));
  const rows = (summary.rows || []).map((row) => `${row.label}: ${row.value}`).join("; ");
  return {
    content: text(`${summary.title}: ${summary.summaryLine}.${rows ? ` ${rows}.` : ""}`),
    structuredContent: { ok: true, summary },
  };
}));

server.registerTool("edit_fragment", {
  title: "Edit structure fragment",
  description:
    "Write a new PDB with a matched fragment extracted, removed, or replaced by atoms from another PDB. The source file is "
    + "not changed. This edits topology (which atoms are present), not geometry.",
  inputSchema: {
    path: z.string().min(1).describe("Source PDB/ENT file."),
    operation: z.enum(["extract", "remove_to_new_file", "replace_to_new_file"]),
    output_path: z.string().min(1).describe("Where to write the derived PDB (not overwritten if it exists)."),
    component: z.enum(["polymer", "ligand", "water", "ion", "chain", "element"]).optional(),
    chain: z.string().max(8).optional(),
    comp_id: z.string().max(8).optional(),
    seq: z.union([z.string().max(12), z.number().int()]).optional(),
    element: z.string().max(3).optional(),
    replacement_path: z.string().optional().describe("PDB whose atoms replace the fragment."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  _meta: { [PATHS_KEY]: { path: local("read"), replacement_path: local("read"), output_path: local("write") } },
}, guarded(async (input) => {
  const output = path.resolve(input.output_path);
  if (await exists(output)) throw new ToolInputError("output_exists", `${output} already exists; choose another output_path.`);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "burette-fragment-"));
  const previous = process.env.BURETTE_BROWSER_DEV_GENERATED_FILES_ROOT;
  process.env.BURETTE_BROWSER_DEV_GENERATED_FILES_ROOT = scratch;
  try {
    const edited = await editStructureFragmentFile({
      file: path.resolve(input.path), operation: input.operation, component: input.component, chain: input.chain,
      compId: input.comp_id, seq: input.seq, element: input.element,
      replacementFile: input.replacement_path ? path.resolve(input.replacement_path) : undefined,
    });
    await mkdir(path.dirname(output), { recursive: true });
    await copyFile(edited.outputPath, output);
    const result = { ...edited, outputPath: output };
    return {
      content: text(input.operation === "extract"
        ? `extract wrote ${output}: ${edited.atomCount ?? "the"} atoms of ${edited.component ?? "the fragment"}.`
        : `${input.operation} wrote ${output}: removed ${edited.removedAtomCount ?? 0} atoms, inserted ${edited.insertedAtomCount ?? 0}.`),
      structuredContent: { ok: true, edited: result },
    };
  } finally {
    if (previous === undefined) delete process.env.BURETTE_BROWSER_DEV_GENERATED_FILES_ROOT;
    else process.env.BURETTE_BROWSER_DEV_GENERATED_FILES_ROOT = previous;
    await rm(scratch, { recursive: true, force: true });
  }
}));

// ---- Ketcher ---------------------------------------------------------------------

const ketcherSurfaces = new Map();
let lastSurface = null;

registerAppTool(server, "open_ketcher", {
  title: "Open Ketcher",
  description:
    "Open the Ketcher 2D chemical editor, seeded with a SMILES, a MOL block or a MOL/SDF/SMILES file. The person's edits "
    + "return as the view's context; read them with get_ketcher_structure and write them with save_ketcher_structure.",
  inputSchema: {
    smiles: z.string().max(65536).optional(),
    molfile: z.string().max(MAX_KETCHER_BYTES).optional(),
    path: z.string().optional().describe("A .mol, .sdf (first record) or .smi file to load."),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  _meta: {
    ui: { resourceUri: KETCHER_URI },
    [PATHS_KEY]: { path: local("read") },
    [STATE_KEY]: [
      { key: "smiles", description: "The SMILES of the drawn structure." },
      { key: "selection", description: "Selected atoms (0-based) of the drawn structure." },
    ],
  },
}, guarded(async (input) => {
  let format = "smiles";
  let content = input.smiles ?? "";
  if (input.molfile) {
    format = "mol";
    content = input.molfile;
  } else if (input.path) {
    const absolute = path.resolve(input.path);
    const raw = readFileSync(absolute, "utf8");
    if (Buffer.byteLength(raw) > MAX_KETCHER_BYTES) throw new ToolInputError("file_too_large", "Ketcher takes files up to 1 MiB.");
    const extension = path.extname(absolute).toLowerCase();
    if (extension === ".smi" || extension === ".smiles") {
      content = raw.split(/\r?\n/u)[0].trim().split(/\s+/u)[0];
    } else {
      format = "mol";
      content = extension === ".sdf" || extension === ".sd" ? raw.split(/^\$\$\$\$/mu)[0] : raw;
    }
  }
  const surfaceId = `ketcher-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  ketcherSurfaces.set(surfaceId, { surfaceId, smiles: format === "smiles" ? content : null, molfile: format === "mol" ? content : null, revision: 0, source: "seed" });
  lastSurface = surfaceId;
  return {
    content: text(`Opened Ketcher${content ? ` with ${format === "smiles" ? content : "a MOL block"}` : ""}. Surface ${surfaceId}.`),
    structuredContent: { ok: true, surfaceId, format, seeded: Boolean(content) },
    _meta: { ...(await serviceMeta()), [KETCHER_META]: { surfaceId, format, content } },
  };
}));

server.registerTool("get_ketcher_structure", {
  title: "Get Ketcher structure",
  description: "Return the structure the person drew or edited in the open Ketcher view, as SMILES and MOL.",
  inputSchema: { surface_id: z.string().optional() },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, guarded(async ({ surface_id: id }) => {
  const surface = ketcherSurfaces.get(id ?? lastSurface ?? "");
  if (!surface) throw new ToolInputError("no_ketcher_surface", "No Ketcher view has been opened in this server.");
  return {
    content: text(`Ketcher ${surface.surfaceId} revision ${surface.revision} (${surface.source}): ${surface.smiles ?? "(no SMILES)"}`),
    structuredContent: { ok: true, ...surface },
  };
}));

server.registerTool("save_ketcher_structure", {
  title: "Save Ketcher structure",
  description: "Write the person's current Ketcher structure to a workspace file as MOL, SDF or SMILES.",
  inputSchema: {
    path: z.string().min(1),
    format: z.enum(["mol", "sdf", "smiles"]).optional().describe("Defaults from the file extension."),
    surface_id: z.string().optional(),
    overwrite: z.boolean().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  _meta: { [PATHS_KEY]: { path: local("write") } },
}, guarded(async (input) => {
  const surface = ketcherSurfaces.get(input.surface_id ?? lastSurface ?? "");
  if (!surface) throw new ToolInputError("no_ketcher_surface", "No Ketcher view has been opened in this server.");
  const output = path.resolve(input.path);
  const extension = path.extname(output).slice(1).toLowerCase();
  const format = input.format ?? (extension === "smi" || extension === "smiles" ? "smiles" : extension === "sdf" ? "sdf" : "mol");
  if (!input.overwrite && await exists(output)) throw new ToolInputError("output_exists", `${output} exists; pass overwrite: true to replace it.`);
  let body;
  if (format === "smiles") {
    if (!surface.smiles) throw new ToolInputError("no_smiles", "The editor has not reported a SMILES yet.");
    body = `${surface.smiles}\n`;
  } else {
    if (!surface.molfile) throw new ToolInputError("no_molfile", "The editor has not reported a MOL block yet.");
    body = format === "sdf" ? `${surface.molfile.replace(/\s*$/u, "")}\n$$$$\n` : surface.molfile;
  }
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, body);
  return {
    content: text(`Wrote ${format.toUpperCase()} of Ketcher revision ${surface.revision} to ${output}.`),
    structuredContent: { ok: true, path: output, format, revision: surface.revision, smiles: surface.smiles },
  };
}));

// ---- App-only tools (the views call these through the bridge) ---------------------

const appOnly = { ui: { visibility: ["app"] } };

registerAppTool(server, "register_structure", {
  title: "Register structure",
  description: "View helper: open another workspace file in the current view and get its handle.",
  inputSchema: { path: z.string().min(1) },
  annotations: { readOnlyHint: true },
  _meta: { ...appOnly, [PATHS_KEY]: { path: local("read") } },
}, guarded(async ({ path: file }) => {
  const entry = await registerFile(file);
  const structure = { handle: entry.handle, path: entry.path, label: entry.label, format: entry.format, byteCount: entry.byteCount, mtimeMs: entry.mtimeMs };
  return { content: text(`Registered ${entry.path}.`), structuredContent: { ok: true, structure } };
}));

registerAppTool(server, "read_structure_chunk", {
  title: "Read structure chunk",
  description: "View helper: read one base64 chunk of an opened structure (hosts without the loopback service).",
  inputSchema: { handle: z.string().min(1), offset: z.number().int().min(0).optional() },
  annotations: { readOnlyHint: true },
  _meta: appOnly,
}, guarded(async ({ handle, offset }) => {
  const chunk = await readChunk(handle, offset);
  return { content: text(`chunk ${chunk.offset}+${chunk.data.length}`), structuredContent: { ok: true, ...chunk } };
}));

registerAppTool(server, "stat_structure", {
  title: "Stat structure",
  description: "View helper: size and modification time of an opened structure, to reload it after it changes.",
  inputSchema: { handle: z.string().min(1) },
  annotations: { readOnlyHint: true },
  _meta: appOnly,
}, guarded(async ({ handle }) => {
  lookup(handle);
  const info = await statHandle(handle);
  return { content: text(JSON.stringify(info)), structuredContent: { ok: true, ...info } };
}));

registerAppTool(server, "ketcher_report", {
  title: "Ketcher report",
  description: "View helper: the Ketcher view reports the person's current structure.",
  inputSchema: {
    surface_id: z.string().min(1),
    smiles: z.string().max(65536).nullable().optional(),
    molfile: z.string().max(MAX_KETCHER_BYTES).nullable().optional(),
    selection: z.array(z.number().int().min(0)).max(4096).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
  _meta: appOnly,
}, guarded(async (input) => {
  const previous = ketcherSurfaces.get(input.surface_id);
  const surface = {
    surfaceId: input.surface_id,
    smiles: input.smiles ?? null,
    molfile: input.molfile ?? null,
    selection: input.selection ?? [],
    revision: (previous?.revision ?? 0) + 1,
    source: "person",
    reportedAt: new Date().toISOString(),
  };
  ketcherSurfaces.set(input.surface_id, surface);
  lastSurface = input.surface_id;
  return { content: text(`revision ${surface.revision}`), structuredContent: { ok: true, revision: surface.revision } };
}));

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready (version ${VERSION}, node ${process.version})`);
