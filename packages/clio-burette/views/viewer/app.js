// Burette molecular viewer as an MCP App. Mol* (Burette's vendored build) renders
// the structure; this module owns the bridge: it loads files the server opened,
// reports the person's selection and drawn regions with ui/update-model-context,
// and offers app tools (set_frame, play_mode, focus, describe_region,
// get_view_state) that the agent or an A2UI surface can call.
import { App } from "@modelcontextprotocol/ext-apps";
import { z } from "zod";

import { installEditMode } from "./edit.js";

const SERVICE_KEY = "ai.iowarp.clio/service";
const STRUCTURE_META = "burette/structure";
const MAX_REPORTED_ATOMS = 256;
const RELOAD_POLL_MS = 1500;
const CONTEXT_DELAY_MS = 150;

const ui = {
  stage: document.getElementById("stage"),
  title: document.getElementById("title"),
  status: document.getElementById("status"),
  frame: document.getElementById("frame"),
  frameLabel: document.getElementById("frame-label"),
  play: document.getElementById("play"),
  region: document.getElementById("region"),
  reset: document.getElementById("reset"),
  overlay: document.getElementById("overlay"),
  box: document.getElementById("box"),
  frames: document.getElementById("frames"),
  edit: document.getElementById("edit"),
  editPanel: document.getElementById("edit-panel"),
  editInfo: document.getElementById("edit-info"),
  editValue: document.getElementById("edit-value"),
  editSlider: document.getElementById("edit-slider"),
  editApply: document.getElementById("edit-apply"),
  editMove: document.getElementById("edit-move"),
};

const state = {
  structure: null, // {handle, path, label, format, mtimeMs}
  frame: 0,
  frameCount: 1,
  playing: false,
  fps: 10,
  loop: true,
  mode: null,
  focus: null,
  selection: null,
  region: null,
  edit: null, // the last geometry edit: {source_path, edited_path, kind, atoms, before, after, …}
};

let viewer = null;
let serviceUrl = null;
let pendingOpen = null;
let loadSequence = 0;
let playToken = 0;
let contextTimer = null;
let suppressSelection = false;
let editMode = null;

const app = new App(
  { name: "burette-molecular-viewer", version: "0.1.0" },
  { tools: { listChanged: true } },
  { autoResize: true },
);

function setStatus(message, kind = "info") {
  ui.status.textContent = message || "";
  ui.status.dataset.kind = kind;
}

// ---- Runtime and file loading --------------------------------------------------

function serviceFromContext(context) {
  const entry = context?.[SERVICE_KEY];
  return entry && typeof entry.url === "string" ? entry.url.replace(/\/?$/u, "/") : null;
}

async function loadMolstar() {
  if (globalThis.molstar?.Viewer) return;
  let scriptUrl;
  let styleUrl;
  if (serviceUrl) {
    scriptUrl = `${serviceUrl}assets/molstar.js`;
    styleUrl = `${serviceUrl}assets/molstar.css`;
  } else {
    // No loopback service (not CLIO): read the runtime as MCP resources.
    const [script, style] = await Promise.all([
      app.readServerResource({ uri: "ui://burette/assets/molstar.js" }),
      app.readServerResource({ uri: "ui://burette/assets/molstar.css" }),
    ]);
    scriptUrl = URL.createObjectURL(new Blob([script.contents[0].text], { type: "text/javascript" }));
    styleUrl = URL.createObjectURL(new Blob([style.contents[0].text], { type: "text/css" }));
  }
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = styleUrl;
  document.head.appendChild(link);
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = scriptUrl;
    script.onload = resolve;
    script.onerror = () => reject(new Error("The Mol* runtime did not load."));
    document.head.appendChild(script);
  });
}

async function createViewer() {
  await loadMolstar();
  viewer = await globalThis.molstar.Viewer.create(ui.stage, {
    layoutIsExpanded: false,
    layoutShowControls: false,
    layoutShowRemoteState: false,
    layoutShowSequence: false,
    layoutShowLog: false,
    layoutShowLeftPanel: false,
    viewportShowExpand: false,
    viewportShowToggleFullscreen: false,
    viewportShowSelectionMode: true,
    viewportShowAnimation: false,
    viewportShowTrajectoryControls: false,
    viewportShowSettings: true,
    collapseLeftPanel: true,
    collapseRightPanel: true,
    pdbProvider: "rcsb",
    emdbProvider: "rcsb",
  });
  // Start in Mol*'s selection mode: a click selects atoms, which is what the view reports.
  viewer.plugin.selectionMode = true;
  viewer.plugin.managers.structure.selection.events.changed.subscribe(() => {
    if (!suppressSelection) onSelectionChanged();
  });
}

async function serverTool(name, args) {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) {
    const message = result.structuredContent?.error?.message || result.content?.[0]?.text || `${name} failed`;
    const error = new Error(message);
    error.code = result.structuredContent?.error?.code;
    throw error;
  }
  return result.structuredContent;
}

async function fetchStructureText(structure) {
  if (serviceUrl) {
    const response = await fetch(`${serviceUrl}files/${encodeURIComponent(structure.handle)}`, { cache: "no-store" });
    if (response.status === 404 && structure.path) {
      // The server restarted (a reopened view): register the path again.
      const registered = await serverTool("register_structure", { path: structure.path });
      Object.assign(structure, registered.structure);
      return fetchStructureText(structure);
    }
    if (!response.ok) throw new Error(`The file service answered ${response.status}.`);
    return response.text();
  }
  const parts = [];
  let offset = 0;
  for (;;) {
    let chunk;
    try {
      chunk = await serverTool("read_structure_chunk", { handle: structure.handle, offset });
    } catch (error) {
      if (error.code === "handle_unknown" && structure.path) {
        const registered = await serverTool("register_structure", { path: structure.path });
        Object.assign(structure, registered.structure);
        return fetchStructureText(structure);
      }
      throw error;
    }
    const bytes = Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0));
    parts.push(bytes);
    offset += bytes.length;
    if (chunk.done || bytes.length === 0) break;
  }
  return new TextDecoder().decode(await new Blob(parts).arrayBuffer());
}

async function statStructure(structure) {
  if (serviceUrl) {
    const response = await fetch(`${serviceUrl}stat/${encodeURIComponent(structure.handle)}`, { cache: "no-store" });
    return response.ok ? response.json() : null;
  }
  return serverTool("stat_structure", { handle: structure.handle });
}

// ---- Mol* helpers -----------------------------------------------------------------

const lib = () => globalThis.molstar.lib;

function trajectoryModelCells() {
  const { StateTransforms } = lib().plugin;
  const cells = [];
  for (const cell of viewer.plugin.state.data.cells.values()) {
    if (cell.transform.transformer === StateTransforms.Model.ModelFromTrajectory) cells.push(cell);
  }
  return cells;
}

function frameCountNow() {
  let count = 1;
  for (const cell of viewer.plugin.state.data.cells.values()) {
    const data = cell.obj?.data;
    if (cell.obj?.type?.name === "Trajectory" && data && Number.isFinite(data.frameCount)) {
      count = Math.max(count, data.frameCount);
    }
  }
  return count;
}

function currentStructure() {
  const structures = viewer.plugin.managers.structure.hierarchy.current.structures;
  return structures[0]?.cell?.obj?.data ?? null;
}

async function applyFrame(index) {
  const count = state.frameCount;
  const frame = ((Math.floor(index) % count) + count) % count;
  const builder = viewer.plugin.state.data.build();
  for (const cell of trajectoryModelCells()) {
    builder.to(cell.transform.ref).update((old) => ({ ...old, modelIndex: frame }));
  }
  await builder.commit({ doNotLogTiming: true });
  state.frame = frame;
  ui.frame.value = String(frame);
  ui.frameLabel.textContent = `${frame + 1} / ${count}`;
}

function atomQuery(test) {
  const { Queries, StructureQuery, StructureSelection } = lib().structure;
  const structure = currentStructure();
  if (!structure) throw new Error("No structure is open.");
  const query = Queries.generators.atoms({ atomTest: (ctx) => test(ctx.element) });
  return StructureSelection.toLociWithSourceUnits(StructureQuery.run(query, structure));
}

function parseResidue(spec) {
  const match = /^(?:([A-Za-z0-9]+):)?([A-Za-z]{1,4})?(-?\d+)([A-Za-z]?)$/u.exec(String(spec).trim());
  if (!match) throw new Error(`Cannot read the residue "${spec}". Use "A:45", "45" or "HIS45".`);
  return { chain: match[1] ?? null, name: match[2]?.toUpperCase() ?? null, seq: Number(match[3]), ins: match[4] || "" };
}

function lociFor(target) {
  const P = lib().structure.StructureProperties;
  if (Array.isArray(target?.atoms) && target.atoms.length) {
    const wanted = new Set(target.atoms.map(Number));
    return atomQuery((loc) => wanted.has(P.atom.sourceIndex(loc)));
  }
  if (Array.isArray(target?.residues) && target.residues.length) {
    const specs = target.residues.map(parseResidue);
    return atomQuery((loc) => specs.some((spec) => (
      P.residue.auth_seq_id(loc) === spec.seq
      && (!spec.chain || P.chain.auth_asym_id(loc) === spec.chain || P.chain.label_asym_id(loc) === spec.chain)
      && (!spec.name || P.atom.auth_comp_id(loc).toUpperCase() === spec.name)
    )));
  }
  throw new Error("Give atoms (0-based indices) or residues to focus.");
}

function hasResidues() {
  return ["pdb", "pdbqt", "mmcif", "gro"].includes(state.structure?.format);
}

function describeLocation(loc) {
  const P = lib().structure.StructureProperties;
  const atom = {
    index: P.atom.sourceIndex(loc),
    element: String(P.atom.type_symbol(loc)),
    xyz: [P.atom.x(loc), P.atom.y(loc), P.atom.z(loc)].map((v) => Math.round(v * 1000) / 1000),
  };
  if (state.structure?.format === "cifCore") atom.site = P.atom.auth_atom_id(loc);
  if (hasResidues()) {
    atom.name = P.atom.auth_atom_id(loc);
    atom.residue = P.atom.auth_comp_id(loc);
    atom.seq = P.residue.auth_seq_id(loc);
    atom.chain = P.chain.auth_asym_id(loc);
  }
  const operator = loc.unit.conformation.operator;
  if (!operator.isIdentity) atom.image = operator.name;
  return atom;
}

function summarizeLoci(lociList) {
  const { StructureElement } = lib().structure;
  const atoms = [];
  const sum = [0, 0, 0];
  let count = 0;
  const elements = {};
  const residues = new Map();
  for (const loci of lociList) {
    if (!loci || StructureElement.Loci.isEmpty(loci)) continue;
    StructureElement.Loci.forEachLocation(loci, (loc) => {
      const atom = describeLocation(loc);
      count += 1;
      sum[0] += atom.xyz[0]; sum[1] += atom.xyz[1]; sum[2] += atom.xyz[2];
      elements[atom.element] = (elements[atom.element] ?? 0) + 1;
      if (atom.residue !== undefined) {
        const key = `${atom.chain}:${atom.residue}${atom.seq}`;
        residues.set(key, { chain: atom.chain, name: atom.residue, seq: atom.seq });
      }
      if (atoms.length < MAX_REPORTED_ATOMS) atoms.push(atom);
    });
  }
  if (!count) return null;
  atoms.sort((a, b) => a.index - b.index);
  const centroid = sum.map((v) => Math.round((v / count) * 1000) / 1000);
  return {
    path: state.structure?.path ?? null,
    frame: state.frame,
    count,
    truncated: count > atoms.length,
    indices: atoms.map((a) => a.index),
    elements,
    residues: [...residues.values()].slice(0, 128),
    centroid,
    atoms,
  };
}

function selectionLoci() {
  return [...viewer.plugin.managers.structure.selection.entries.values()].map((entry) => entry.selection);
}

function selectLoci(loci) {
  suppressSelection = true;
  try {
    viewer.plugin.managers.interactivity.lociSelects.deselectAll();
    viewer.plugin.managers.interactivity.lociSelects.select({ loci });
  } finally {
    suppressSelection = false;
  }
}

// ---- Regions: atoms under a rectangle of the view -------------------------------------

function atomsInRect(rect, relativeTo = "view") {
  const { StructureElement, StructureProperties: P } = lib().structure;
  const { Vec3 } = lib().math.LinearAlgebra;
  const structure = currentStructure();
  if (!structure) throw new Error("No structure is open.");
  const canvas = ui.stage.querySelector("canvas");
  const bounds = canvas.getBoundingClientRect();
  // Convert a rectangle normalized to the whole view into canvas fractions.
  let r = rect;
  if (relativeTo === "view") {
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    r = {
      x: (rect.x * width - bounds.left) / bounds.width,
      y: (rect.y * height - bounds.top) / bounds.height,
      width: (rect.width * width) / bounds.width,
      height: (rect.height * height) / bounds.height,
    };
  }
  const camera = viewer.plugin.canvas3d.camera;
  const viewport = camera.viewport;
  const out = Vec3();
  const point = Vec3();
  const keys = new Set();
  for (const unit of structure.units) {
    const location = StructureElement.Location.create(structure, unit, unit.elements[0]);
    for (let i = 0; i < unit.elements.length; i += 1) {
      location.element = unit.elements[i];
      Vec3.set(point, P.atom.x(location), P.atom.y(location), P.atom.z(location));
      camera.project(out, point);
      const fx = (out[0] - viewport.x) / viewport.width;
      // Mol*'s project() returns window coordinates: y grows downwards.
      const fy = (out[1] - viewport.y) / viewport.height;
      if (fx >= r.x && fx <= r.x + r.width && fy >= r.y && fy <= r.y + r.height) {
        keys.add(`${unit.id}:${location.element}`);
      }
    }
  }
  if (!keys.size) return { loci: null, summary: null };
  const loci = atomQuery((loc) => keys.has(`${loc.unit.id}:${loc.element}`));
  return { loci, summary: summarizeLoci([loci]) };
}

function describeRegion(rect, relativeTo) {
  const { loci, summary } = atomsInRect(rect, relativeTo);
  state.region = {
    rect,
    relative_to: relativeTo,
    count: summary?.count ?? 0,
    indices: summary?.indices ?? [],
    elements: summary?.elements ?? {},
    residues: summary?.residues ?? [],
    centroid: summary?.centroid ?? null,
  };
  if (loci) {
    selectLoci(loci);
    state.selection = summary;
  }
  scheduleContext();
  return { region: state.region, atoms: summary?.atoms ?? [] };
}

function wireRegionDrawing() {
  let start = null;
  ui.region.addEventListener("click", () => {
    const active = ui.region.getAttribute("aria-pressed") !== "true";
    ui.region.setAttribute("aria-pressed", String(active));
    ui.overlay.hidden = !active;
  });
  ui.overlay.addEventListener("pointerdown", (event) => {
    if (ui.overlay.dataset.mode === "move") return;
    start = { x: event.clientX, y: event.clientY };
    ui.overlay.setPointerCapture(event.pointerId);
    Object.assign(ui.box.style, { left: `${start.x}px`, top: `${start.y}px`, width: "0px", height: "0px" });
    ui.box.hidden = false;
  });
  ui.overlay.addEventListener("pointermove", (event) => {
    if (!start) return;
    Object.assign(ui.box.style, {
      left: `${Math.min(start.x, event.clientX)}px`, top: `${Math.min(start.y, event.clientY)}px`,
      width: `${Math.abs(event.clientX - start.x)}px`, height: `${Math.abs(event.clientY - start.y)}px`,
    });
  });
  ui.overlay.addEventListener("pointerup", (event) => {
    if (!start || ui.overlay.dataset.mode === "move") return;
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    const rect = {
      x: Math.min(start.x, event.clientX) / width,
      y: Math.min(start.y, event.clientY) / height,
      width: Math.abs(event.clientX - start.x) / width,
      height: Math.abs(event.clientY - start.y) / height,
    };
    start = null;
    ui.box.hidden = true;
    ui.overlay.hidden = true;
    ui.region.setAttribute("aria-pressed", "false");
    if (rect.width < 0.005 || rect.height < 0.005) return;
    try {
      const { region } = describeRegion(rect, "view");
      setStatus(`${region.count} atoms in the drawn region`);
    } catch (error) {
      setStatus(error.message, "error");
    }
  });
}

/** Where atom `index` (0-based file order) projects in the viewport, with its depth. */
function projectAtom(index) {
  const { StructureElement, StructureProperties: P } = lib().structure;
  const { Vec3 } = lib().math.LinearAlgebra;
  const structure = currentStructure();
  const camera = viewer.plugin.canvas3d.camera;
  for (const unit of structure.units) {
    const location = StructureElement.Location.create(structure, unit, unit.elements[0]);
    for (let i = 0; i < unit.elements.length; i += 1) {
      location.element = unit.elements[i];
      if (P.atom.sourceIndex(location) !== index) continue;
      const out = Vec3();
      camera.project(out, Vec3.create(P.atom.x(location), P.atom.y(location), P.atom.z(location)));
      return { x: out[0], y: out[1], z: out[2], viewport: camera.viewport, rect: ui.stage.querySelector("canvas").getBoundingClientRect() };
    }
  }
  throw new Error(`Atom ${index} is not in the view.`);
}

// ---- Model context ----------------------------------------------------------------------

function viewState() {
  return {
    burette: "viewer/v1",
    path: state.structure?.path ?? null,
    label: state.structure?.label ?? null,
    format: state.structure?.format ?? null,
    frame: state.frame,
    frame_count: state.frameCount,
    playing: state.playing,
    mode: state.mode,
    focus: state.focus,
    selection: state.selection,
    region: state.region,
    edit: state.edit,
  };
}

function contextText(view) {
  if (!view.path && !view.label) return "Burette viewer: nothing open.";
  const lines = [`Burette viewer shows ${view.path ?? view.label} (${view.format}), frame ${view.frame + 1} of ${view.frame_count}${view.playing ? ", playing" : ""}.`];
  const selection = view.selection;
  if (selection) {
    const listed = selection.atoms.slice(0, 24).map((a) => `${a.element}${a.index}${a.residue ? ` ${a.chain}:${a.residue}${a.seq}` : ""}`).join(", ");
    lines.push(`The person selected ${selection.count} atom${selection.count === 1 ? "" : "s"} (0-based file indices): ${listed}${selection.count > 24 ? ", …" : ""}; centroid ${selection.centroid.join(", ")} Å.`);
  } else {
    lines.push("No atoms are selected.");
  }
  if (view.focus) lines.push(`Focused on ${JSON.stringify(view.focus)}.`);
  const edit = view.edit;
  if (edit) {
    lines.push(edit.kind === "move_atom"
      ? `The person moved atom ${edit.atoms[0]} from (${edit.before.join(", ")}) to (${edit.after.join(", ")}) Å; the edited structure is ${edit.edited_path} (source ${edit.source_path} unchanged).`
      : `The person set the ${edit.kind} of atoms ${edit.atoms.join("-")} from ${edit.before} to ${edit.after}; the edited structure is ${edit.edited_path} (source ${edit.source_path} unchanged).`);
  }
  return lines.join(" ");
}

function scheduleContext() {
  clearTimeout(contextTimer);
  contextTimer = setTimeout(() => {
    const view = viewState();
    app.updateModelContext({ content: [{ type: "text", text: contextText(view) }], structuredContent: view })
      .catch((error) => console.warn("Burette: updateModelContext failed", error));
  }, CONTEXT_DELAY_MS);
}

function onSelectionChanged() {
  state.selection = summarizeLoci(selectionLoci());
  if (state.selection) setStatus(`${state.selection.count} atom${state.selection.count === 1 ? "" : "s"} selected`);
  editMode?.onSelection(state.selection);
  scheduleContext();
}

// ---- Opening, frames, playback and reload ---------------------------------------------------

async function openStructure(descriptor) {
  if (!viewer) {
    pendingOpen = descriptor;
    return;
  }
  const sequence = ++loadSequence;
  stopPlayback();
  const structure = { ...descriptor };
  delete structure.data;
  setStatus(`Loading ${structure.label}…`);
  ui.title.textContent = structure.label ?? structure.path ?? "Structure";
  const text = descriptor.data ?? await fetchStructureText(structure);
  if (sequence !== loadSequence) return;
  await loadText(structure, text, { keepCamera: descriptor.keepCamera === true });
  if (sequence !== loadSequence) return;
  state.edit = descriptor.edit ?? null;
  state.mode = descriptor.play ? structure.path ?? structure.label : null;
  state.focus = null;
  state.region = null;
  if (Number.isInteger(descriptor.frame)) await applyFrame(descriptor.frame);
  if (descriptor.focus) await focusOn(descriptor.focus);
  if (descriptor.play && state.frameCount > 1) startPlayback(descriptor.fps ?? 10, descriptor.loop !== false);
  setStatus(`${structure.label} · ${state.frameCount} frame${state.frameCount === 1 ? "" : "s"}`);
  scheduleContext();
}

async function loadText(structure, text, { keepCamera }) {
  const plugin = viewer.plugin;
  const camera = keepCamera ? plugin.canvas3d?.camera.getSnapshot() : null;
  await plugin.clear();
  const data = await plugin.builders.data.rawData({ data: text, label: structure.label });
  const trajectory = await plugin.builders.structure.parseTrajectory(data, structure.format);
  if (structure.format === "cifCore") await buildCrystal(trajectory, structure.supercell);
  else await plugin.builders.structure.hierarchy.applyPreset(trajectory, "default", {});
  state.structure = structure;
  // Small molecules and crystals have no residues: a click picks one atom, not the whole molecule.
  plugin.managers.interactivity.setProps({ granularity: hasResidues() ? "residue" : "element" });
  state.frameCount = frameCountNow();
  state.frame = 0;
  state.selection = null;
  ui.frames.hidden = state.frameCount <= 1;
  ui.frame.max = String(Math.max(0, state.frameCount - 1));
  ui.frame.value = "0";
  ui.frameLabel.textContent = `1 / ${state.frameCount}`;
  if (camera) plugin.canvas3d.camera.setState(camera, 0);
}

// A small-molecule CIF: every symmetry operator applied over the requested cells
// (one cell by default), ball-and-stick, and the unit cell box on the model.
async function buildCrystal(trajectory, supercell) {
  const plugin = viewer.plugin;
  const { StateTransforms } = lib().plugin;
  const [a, b, c] = Array.isArray(supercell) ? supercell : [1, 1, 1];
  const model = await plugin.builders.structure.createModel(trajectory);
  const crystal = await plugin.builders.structure.createStructure(model, {
    name: "symmetry",
    params: { ijkMin: [0, 0, 0], ijkMax: [a - 1, b - 1, c - 1] },
  });
  await plugin.builders.structure.representation.addRepresentation(crystal, {
    type: "ball-and-stick",
    color: "element-symbol",
    typeParams: { sizeFactor: 0.3 },
  });
  await plugin.build().to(model).apply(StateTransforms.Representation.ModelUnitcell3D, {}).commit();
}

async function reloadIfChanged() {
  const structure = state.structure;
  if (!structure?.handle || !structure.path) return;
  let info;
  try {
    info = await statStructure(structure);
  } catch {
    return;
  }
  if (!info?.exists || !info.mtimeMs || info.mtimeMs === structure.mtimeMs) return;
  structure.mtimeMs = info.mtimeMs;
  const frame = state.frame;
  const wasPlaying = state.playing;
  stopPlayback();
  const sequence = ++loadSequence;
  const text = await fetchStructureText(structure);
  if (sequence !== loadSequence) return;
  await loadText(structure, text, { keepCamera: true });
  if (frame < state.frameCount) await applyFrame(frame);
  if (state.focus) await focusOn(state.focus).catch(() => {});
  if (wasPlaying) startPlayback(state.fps, state.loop);
  setStatus(`Reloaded ${structure.label} (changed on disk)`);
  scheduleContext();
}

function startPlayback(fps, loop) {
  stopPlayback();
  state.playing = true;
  state.fps = fps;
  state.loop = loop;
  ui.play.textContent = "Pause";
  const token = ++playToken;
  const step = async () => {
    if (token !== playToken) return;
    const next = state.frame + 1;
    if (next >= state.frameCount && !state.loop) {
      stopPlayback();
      scheduleContext();
      return;
    }
    await applyFrame(next);
    // Report the moving frame about once a second, not on every frame.
    if (state.frame % Math.max(1, Math.round(state.fps)) === 0) scheduleContext();
    if (token === playToken) setTimeout(step, 1000 / state.fps);
  };
  setTimeout(step, 1000 / fps);
}

function stopPlayback() {
  playToken += 1;
  state.playing = false;
  ui.play.textContent = "Play";
}

async function focusOn(target) {
  const loci = lociFor(target);
  const { StructureElement } = lib().structure;
  if (StructureElement.Loci.isEmpty(loci)) throw new Error("No atoms match the focus.");
  viewer.plugin.managers.structure.focus.setFromLoci(loci);
  viewer.plugin.managers.camera.focusLoci(loci);
  selectLoci(loci);
  state.focus = target;
  state.selection = summarizeLoci([loci]);
  scheduleContext();
  return state.selection;
}

function result(structuredContent, message) {
  return { content: [{ type: "text", text: message }], structuredContent };
}

// ---- App tools ------------------------------------------------------------------------------

function registerAppTools() {
  app.registerTool("set_frame", {
    title: "Set frame",
    description: "Show one frame (0-based) of the open trajectory or normal mode; stops playback.",
    inputSchema: z.object({ frame: z.number().int().min(0) }),
  }, async ({ frame }) => {
    stopPlayback();
    await applyFrame(frame);
    scheduleContext();
    return result(viewState(), `Showing frame ${state.frame + 1} of ${state.frameCount}.`);
  });

  app.registerTool("play_mode", {
    title: "Play mode",
    description: "Play a multi-frame XYZ (normal mode or trajectory) in this view; with no path, play or pause the open file.",
    inputSchema: z.object({
      path: z.string().optional(),
      mode: z.string().optional(),
      fps: z.number().min(1).max(60).optional(),
      playing: z.boolean().optional(),
    }),
  }, async ({ path, mode, fps, playing }) => {
    const file = path ?? mode;
    if (file && file !== state.structure?.path) {
      const registered = await serverTool("register_structure", { path: file });
      await openStructure({ ...registered.structure, play: playing !== false, fps: fps ?? state.fps });
    } else if (playing === false) {
      stopPlayback();
    } else {
      startPlayback(fps ?? state.fps, true);
      state.mode = state.structure?.path ?? null;
    }
    scheduleContext();
    return result(viewState(), state.playing ? `Playing ${state.frameCount} frames at ${state.fps} fps.` : "Paused.");
  });

  app.registerTool("focus", {
    title: "Focus",
    description: "Focus the camera on atoms (0-based file indices) or residues (\"A:45\", \"HIS45\") and select them.",
    inputSchema: z.object({
      atoms: z.array(z.number().int().min(0)).optional(),
      residues: z.array(z.string()).optional(),
      focus: z.object({ atoms: z.array(z.number().int().min(0)).optional(), residues: z.array(z.string()).optional() }).optional(),
    }),
  }, async ({ atoms, residues, focus }) => {
    const target = focus ?? (atoms ? { atoms } : { residues });
    const selection = await focusOn(target);
    return result(viewState(), `Focused on ${selection.count} atoms.`);
  });

  app.registerTool("describe_region", {
    title: "Describe region",
    description:
      "Return the atoms under a rectangle of the view (indices, elements, residues, centroid) and select them. "
      + "rect is normalized 0..1 (x, y from the top-left); without rect, describe the person's last drawn region or selection.",
    inputSchema: z.object({
      rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
      relative_to: z.enum(["view", "canvas"]).optional(),
    }),
  }, async ({ rect, relative_to: relativeTo }) => {
    if (rect) {
      const described = describeRegion(rect, relativeTo ?? "view");
      return result(described, `${described.region.count} atoms under the region.`);
    }
    const selection = state.selection;
    return result({ region: state.region, selection }, selection ? `${selection.count} atoms selected.` : "No region or selection.");
  });

  app.registerTool("get_view_state", {
    title: "Get view state",
    description: "Return the open file, frame, playback, focus, selection and last region.",
    inputSchema: z.object({}),
  }, async () => result(viewState(), contextText(viewState())));
}

// ---- Wiring ---------------------------------------------------------------------------------

function structureFromResult(params) {
  const meta = params?._meta ?? params?.meta;
  const descriptor = meta?.[STRUCTURE_META];
  return descriptor && typeof descriptor === "object" ? descriptor : null;
}

app.ontoolresult = (params) => {
  const descriptor = structureFromResult(params);
  if (descriptor) openStructure(descriptor).catch((error) => setStatus(error.message, "error"));
  else if (params?.isError) setStatus(params.content?.[0]?.text ?? "The tool failed.", "error");
};
app.onhostcontextchanged = (context) => {
  const url = serviceFromContext(context);
  if (url) serviceUrl = url;
  if (context?.displayMode) document.documentElement.dataset.displayMode = context.displayMode;
};

ui.frame.addEventListener("input", () => {
  stopPlayback();
  applyFrame(Number(ui.frame.value)).then(scheduleContext);
});
ui.play.addEventListener("click", () => {
  if (state.playing) stopPlayback();
  else startPlayback(state.fps, true);
  scheduleContext();
});
ui.reset.addEventListener("click", () => viewer?.plugin.managers.camera.reset());
wireRegionDrawing();
registerAppTools();
editMode = installEditMode({
  app,
  state,
  ui,
  setStatus,
  scheduleContext,
  openStructure,
  async selectAtoms(indices) {
    if (!indices.length) return;
    const loci = lociFor({ atoms: indices });
    selectLoci(loci);
    state.selection = summarizeLoci([loci]);
    scheduleContext();
  },
  projectAtom,
  unproject([x, y, z]) {
    const { Vec3 } = lib().math.LinearAlgebra;
    const out = Vec3();
    viewer.plugin.canvas3d.camera.unproject(out, Vec3.create(x, y, z));
    return [out[0], out[1], out[2]].map((v) => Math.round(v * 10000) / 10000);
  },
});

async function main() {
  setStatus("Connecting…");
  await app.connect();
  const context = app.getHostContext();
  serviceUrl = serviceFromContext(context);
  if (context?.displayMode) document.documentElement.dataset.displayMode = context.displayMode;
  setStatus("Loading Mol*…");
  await createViewer();
  setStatus("Ready");
  if (pendingOpen) {
    const descriptor = pendingOpen;
    pendingOpen = null;
    await openStructure(descriptor);
  }
  setInterval(() => { reloadIfChanged().catch(() => {}); }, RELOAD_POLL_MS);
}

window.__buretteViewer = {
  state, viewState, describeRegion,
  clearSelection: () => viewer.plugin.managers.interactivity.lociSelects.deselectAll(),
  // Client (CSS) coordinates of an atom, for the harness to click it like a person.
  screenOf: (index) => {
    const p = projectAtom(index);
    return {
      x: p.rect.left + ((p.x - p.viewport.x) / p.viewport.width) * p.rect.width,
      y: p.rect.top + ((p.y - p.viewport.y) / p.viewport.height) * p.rect.height,
    };
  },
  stats: () => {
    const structure = currentStructure();
    if (!structure) return null;
    return { units: structure.units.length, atoms: structure.elementCount, bonds: structure.interUnitBonds?.edgeCount ?? null };
  },
};
main().catch((error) => {
  console.error(error);
  setStatus(error.message || String(error), "error");
});
