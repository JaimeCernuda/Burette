// Drives the Burette views in the harness host with Playwright/Chromium and
// writes screenshots plus a JSON log of what the views reported.
// Usage: node packages/clio-burette/tests/run-views.mjs <out-dir> [scenario...]
//        (BURETTE_SERVER="cmd arg..." to start another server command)
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHarness } from "./harness/harness-server.mjs";
import { measure, readStructure } from "../server/geometry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures");
const outDir = path.resolve(process.argv[2] || "burette-view-checks");
const only = new Set(process.argv.slice(3));
mkdirSync(outDir, { recursive: true });

function loadPlaywright() {
  try {
    return createRequire(import.meta.url)("playwright");
  } catch {
    const root = execSync("npm root -g", { encoding: "utf8" }).trim();
    return createRequire(path.join(root, "noop.js"))("playwright");
  }
}

const serverCommand = process.env.BURETTE_SERVER
  ? process.env.BURETTE_SERVER.split(" ")
  : [process.execPath, path.join(here, "../src/clio_burette/bundle/server.mjs")];
const log = [];
const harness = await startHarness({ command: serverCommand[0], args: serverCommand.slice(1), outDir, log: (line) => log.push(line) });
const { chromium } = loadPlaywright();
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const results = {};

async function page(query = "") {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1 });
  const p = await context.newPage();
  p.on("console", (m) => { if (m.type() === "error") log.push(`console: ${m.text().slice(0, 300)}`); });
  p.on("pageerror", (e) => log.push(`pageerror: ${e.message}`));
  await p.goto(`${harness.url}${query}`);
  return p;
}

const frameOf = (p) => p.frames().find((f) => f.url().includes("/view?"));

async function waitStatus(p, pattern, timeout = 60000) {
  const frame = frameOf(p);
  await frame.waitForFunction((source) => new RegExp(source).test(document.getElementById("status")?.textContent || ""), pattern.source, { timeout });
  return frame;
}

async function shot(p, name) {
  await p.mouse.move(2, 2);
  await p.waitForTimeout(150);
  const file = path.join(outDir, `${name}.png`);
  await p.screenshot({ path: file, fullPage: true });
  return file;
}

async function waitContext(p, predicate, timeout = 15000) {
  await p.waitForFunction(predicate, null, { timeout });
  return p.evaluate(() => window.harness.lastContext());
}

const scenarios = {
  async xylene() {
    const p = await page();
    await p.evaluate((file) => window.harness.open("open_structure", { path: file }), path.join(fixtures, "p-xylene.xyz"));
    const frame = await waitStatus(p, /frame/);
    await p.waitForTimeout(1500);
    const opened = await shot(p, "01-p-xylene-open");
    const tools = await p.evaluate(() => window.harness.listAppTools());
    // The person draws a region over the left half of the molecule (Region button + drag).
    const box = await frame.locator("#stage canvas").first().boundingBox();
    await frame.locator("#region").click();
    await p.mouse.move(box.x + box.width * 0.12, box.y + box.height * 0.2);
    await p.mouse.down();
    await p.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.8, { steps: 8 });
    await p.mouse.up();
    const context = await waitContext(p, () => window.harness.lastContext()?.structuredContent?.selection?.count > 0);
    await p.waitForTimeout(800);
    const selected = await shot(p, "02-p-xylene-region-selection");
    // The agent asks for the atoms under a mark (e.g. a comment's rect on the view).
    const region = await p.evaluate(() => window.harness.callAppTool("describe_region", { rect: { x: 0.55, y: 0.1, width: 0.45, height: 0.9 } }));
    await p.waitForTimeout(500);
    return { opened, selected, appTools: tools.tools.map((t) => t.name), context, describeRegion: region.structuredContent };
  },
  async click() {
    const p = await page();
    await p.evaluate((file) => window.harness.open("open_structure", { path: file }), path.join(fixtures, "p-xylene.xyz"));
    const frame = await waitStatus(p, /frame/);
    await p.waitForTimeout(1500);
    const box = await frame.locator("#stage canvas").first().boundingBox();
    // A plain Mol* click (the view starts in selection mode): click along the
    // molecule's axis until an atom is hit and the view reports it.
    for (const fx of [0.5, 0.42, 0.58, 0.35, 0.65, 0.3, 0.7]) {
      await p.mouse.click(box.x + box.width * fx, box.y + box.height * 0.5);
      await p.waitForTimeout(400);
      const count = await p.evaluate(() => window.harness.lastContext()?.structuredContent?.selection?.count ?? 0);
      if (count > 0) break;
    }
    const context = await p.evaluate(() => window.harness.lastContext());
    const file = await shot(p, "03-p-xylene-click-selection");
    return { file, context };
  },
  async mode() {
    const p = await page();
    await p.evaluate((file) => window.harness.open("play_mode", { path: file, fps: 8 }), path.join(fixtures, "p-xylene-mode.xyz"));
    await waitStatus(p, /20 frames/);
    await p.waitForTimeout(1200);
    const playing = await p.evaluate(() => window.harness.lastContext()?.structuredContent);
    const a = await shot(p, "04-mode-playing-a");
    await p.waitForTimeout(700);
    const b = await shot(p, "05-mode-playing-b");
    const frames = [];
    for (const f of [0, 5, 10, 15]) {
      const r = await p.evaluate((frame) => window.harness.callAppTool("set_frame", { frame }), f);
      frames.push({ asked: f, shown: r.structuredContent.frame, playing: r.structuredContent.playing });
    }
    await p.waitForTimeout(500);
    const atFrame = await shot(p, "06-set-frame-15");
    // set_frame changes coordinates: the selection centroid differs across frames.
    const radius = [];
    for (const f of [0, 5]) {
      await p.evaluate((frame) => window.harness.callAppTool("set_frame", { frame }), f);
      const r = await p.evaluate(() => window.harness.callAppTool("focus", { atoms: [0] }));
      radius.push({ frame: f, atom0: r.structuredContent.selection.atoms[0].xyz });
    }
    return { playing, shots: [a, b, atFrame], frames, radius, lastContext: await p.evaluate(() => window.harness.lastContext()) };
  },
  async reload() {
    const { copyFileSync } = await import("node:fs");
    const work = path.join(outDir, "work");
    mkdirSync(work, { recursive: true });
    const file = path.join(work, "edited.xyz");
    copyFileSync(path.join(fixtures, "p-xylene.xyz"), file);
    const p = await page();
    await p.evaluate((f) => window.harness.open("open_structure", { path: f }), file);
    await waitStatus(p, /frame/);
    await p.waitForTimeout(1000);
    const dihedral = (a, b, c, d) => {
      const sub = (u, v) => u.map((x, k) => x - v[k]);
      const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const dot = (u, v) => u.reduce((t, x, k) => t + x * v[k], 0);
      const b0 = sub(a, b), b1 = sub(c, b), b2 = sub(d, c);
      const n1 = cross(b0, b1), n2 = cross(b1, b2);
      const m = cross(n1, b1.map((x) => x / Math.hypot(...b1)));
      return Math.round((Math.atan2(dot(m, n2), dot(n1, n2)) * 180) / Math.PI * 10) / 10;
    };
    const torsion = async () => {
      const r = await p.evaluate(() => window.harness.callAppTool("focus", { atoms: [1, 0, 6, 13] }));
      const xyz = Object.fromEntries(r.structuredContent.selection.atoms.map((a) => [a.index, a.xyz]));
      return { dihedral_H13_C6_C0_C1: dihedral(xyz[13], xyz[6], xyz[0], xyz[1]), atoms: r.structuredContent.selection.atoms };
    };
    const before = await torsion();
    const beforeShot = await shot(p, "07-reload-before");
    // What ASE's set_dihedral / set_geometry does: rotate the methyl hydrogens 12-14
    // by 60 degrees about the C0-C6 bond (the x axis here) and rewrite the file.
    const lines = readFileSync(file, "utf8").split("\n");
    const angle = Math.PI / 3;
    for (const index of [12, 13, 14]) {
      const [e, x, y, z] = lines[2 + index].trim().split(/\s+/);
      const ny = Number(y) * Math.cos(angle) - Number(z) * Math.sin(angle);
      const nz = Number(y) * Math.sin(angle) + Number(z) * Math.cos(angle);
      lines[2 + index] = `${e} ${Number(x).toFixed(6)} ${ny.toFixed(6)} ${nz.toFixed(6)}`;
    }
    writeFileSync(file, lines.join("\n"));
    const later = new Date(Date.now() + 2000);
    utimesSync(file, later, later);
    await waitStatus(p, /Reloaded/, 15000);
    await p.waitForTimeout(800);
    const after = await torsion();
    const afterShot = await shot(p, "08-reload-after");
    return { before: before.dihedral_H13_C6_C0_C1, after: after.dihedral_H13_C6_C0_C1, beforeShot, afterShot };
  },
  async edit() {
    const { copyFileSync, readdirSync } = await import("node:fs");
    const work = path.join(outDir, "work", "edit");
    mkdirSync(work, { recursive: true });
    for (const name of readdirSync(work)) rmSync(path.join(work, name));
    const glycol = path.join(work, "ethylene-glycol.xyz");
    copyFileSync(path.join(fixtures, "ethylene-glycol.xyz"), glycol);
    const dihedralOf = (file) => {
      const atoms = readStructure(readFileSync(file, "utf8"), "xyz", 0).atoms.map((a) => a.xyz);
      return Math.round(measure.dihedral(atoms, [0, 1, 2, 3]) * 10) / 10;
    };
    const out = { source: { path: glycol, dihedral: dihedralOf(glycol) } };
    const p = await page();
    await p.evaluate((f) => window.harness.open("open_structure", { path: f }), glycol);
    const frame = await waitStatus(p, /frame/);
    await p.waitForTimeout(1200);
    const frameBox = await p.locator("iframe").boundingBox();
    const clickAtom = async (index) => {
      const at = await frame.evaluate((i) => window.__buretteViewer.screenOf(i), index);
      await p.mouse.click(frameBox.x + 1 + at.x, frameBox.y + 1 + at.y);
      await p.waitForTimeout(350);
    };
    // An asymmetric molecule checks the region projection: a small box around O3 holds O3.
    const o3 = await frame.evaluate(() => window.__buretteViewer.screenOf(3));
    const view = await frame.evaluate(() => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight }));
    const around = await p.evaluate((rect) => window.harness.callAppTool("describe_region", { rect }), {
      x: (o3.x - 15) / view.w, y: (o3.y - 15) / view.h, width: 30 / view.w, height: 30 / view.h,
    });
    out.regionAroundO3 = around.structuredContent.region.indices;
    await clickAtom(3); // clear the region's selection
    await frame.evaluate(() => window.__buretteViewer.clearSelection());
    await frame.locator("#edit").click();
    for (const index of [0, 1, 2, 3]) await clickAtom(index);
    await p.waitForTimeout(400);
    out.panelBefore = await frame.locator("#edit-info").textContent();
    out.shots = [await shot(p, "17-glycol-edit-anti")];
    // Typed value: O-C-C-O to gauche.
    await frame.locator("#edit-value").fill("60");
    await frame.locator("#edit-value").press("Enter");
    await waitStatus(p, /wrote/, 20000);
    await p.waitForTimeout(1000);
    const typed = await p.evaluate(() => window.harness.lastContext()?.structuredContent?.edit);
    out.typed = { edit: typed, fileDihedral: dihedralOf(typed.edited_path), panel: await frame.locator("#edit-info").textContent() };
    out.shots.push(await shot(p, "18-glycol-edit-gauche-typed"));
    // Dragged handle: drag the slider thumb to about -60 degrees.
    const slider = await frame.locator("#edit-slider").boundingBox();
    const xOf = (v) => slider.x + 8 + ((v + 180) / 360) * (slider.width - 16);
    await p.mouse.move(xOf(60), slider.y + slider.height / 2);
    await p.mouse.down();
    await p.mouse.move(xOf(-60), slider.y + slider.height / 2, { steps: 12 });
    await p.mouse.up();
    await waitStatus(p, /→ -/, 20000);
    await p.waitForTimeout(1000);
    const dragged = await p.evaluate(() => window.harness.lastContext()?.structuredContent?.edit);
    out.dragged = { edit: dragged, fileDihedral: dihedralOf(dragged.edited_path) };
    out.shots.push(await shot(p, "19-glycol-edit-slider"));
    // Drag one atom (hydroxyl H4) in the view plane.
    for (const index of [0, 1, 2, 3]) await clickAtom(index); // deselect the four
    await clickAtom(4);
    await frame.locator("#edit-move").click();
    const h = await frame.evaluate(() => window.__buretteViewer.screenOf(4));
    await p.mouse.move(frameBox.x + 1 + h.x, frameBox.y + 1 + h.y);
    await p.mouse.down();
    await p.mouse.move(frameBox.x + 1 + h.x + 60, frameBox.y + 1 + h.y - 30, { steps: 8 });
    await p.mouse.up();
    await waitStatus(p, /Moved/, 20000);
    await p.waitForTimeout(800);
    out.moved = await p.evaluate(() => window.harness.lastContext()?.structuredContent?.edit);
    out.shots.push(await shot(p, "20-glycol-drag-atom"));
    out.context = await p.evaluate(() => window.harness.lastContext()?.content?.[0]?.text);
    // The same edit through the server tool, as the agent would call it.
    const tool = await harness.client.callTool({ name: "set_geometry", arguments: { path: glycol, kind: "dihedral", atoms: [0, 1, 2, 3], value: 60 } });
    out.tool = { text: tool.content[0].text, edit: tool.structuredContent.edit, fileDihedral: dihedralOf(tool.structuredContent.edit.edited_path) };
    const notBonded = await harness.client.callTool({ name: "set_geometry", arguments: { path: glycol, kind: "distance", atoms: [0, 3], value: 2 } });
    out.notBonded = notBonded.content[0].text;
    out.sourceAfter = dihedralOf(glycol);
    out.files = readdirSync(work).sort();
    // Ring bond refused in the view: p-xylene ring atoms 5-0-1-2.
    const xylene = path.join(work, "p-xylene.xyz");
    copyFileSync(path.join(fixtures, "p-xylene.xyz"), xylene);
    const q = await page();
    await q.evaluate((f) => window.harness.open("open_structure", { path: f }), xylene);
    const qframe = await waitStatus(q, /frame/);
    await q.waitForTimeout(1200);
    const qBox = await q.locator("iframe").boundingBox();
    await qframe.locator("#edit").click();
    for (const index of [5, 0, 1, 2]) {
      const at = await qframe.evaluate((i) => window.__buretteViewer.screenOf(i), index);
      await q.mouse.click(qBox.x + 1 + at.x, qBox.y + 1 + at.y);
      await q.waitForTimeout(350);
    }
    await qframe.locator("#edit-value").fill("30");
    await qframe.locator("#edit-value").press("Enter");
    await waitStatus(q, /ring/, 20000);
    out.ring = await qframe.locator("#status").textContent();
    out.shots.push(await shot(q, "21-ring-bond-refused"));
    return out;
  },
  async magnetite() {
    const out = {};
    for (const [name, file, args] of [
      ["09-magnetite-unit-cell", "magnetite.cif", {}],
      ["10-magnetite-2x2x2", "magnetite.cif", { supercell: [2, 2, 2] }],
      ["11-magnetite-001-water", "magnetite-001-h2o.cif", {}],
    ]) {
      const p = await page();
      await p.evaluate(([f, a]) => window.harness.open("open_structure", { path: f, ...a }), [path.join(fixtures, file), args]);
      await waitStatus(p, /frame/);
      await p.waitForTimeout(2500);
      const frame = frameOf(p);
      const info = await frame.evaluate(() => ({ ...window.__buretteViewer.viewState(), stats: window.__buretteViewer.stats() }));
      out[name] = { file: await shot(p, name), info };
      if (file === "magnetite-001-h2o.cif") {
        const water = await p.evaluate(() => window.harness.callAppTool("focus", { atoms: [112, 113, 114] }));
        await p.waitForTimeout(1200);
        out[name].water = water.structuredContent.selection;
        out[name].focusShot = await shot(p, "12-magnetite-water-focus");
      }
    }
    return out;
  },
  async fallback() {
    // A host without the loopback service: Mol* comes as MCP resources and a
    // 0.5 MB, 1000-frame XYZ (over the inline limit) in chunks via callServerTool.
    const big = path.join(outDir, "work", "big-trajectory.xyz");
    mkdirSync(path.dirname(big), { recursive: true });
    const base = readFileSync(path.join(fixtures, "p-xylene.xyz"), "utf8").trim().split("\n").slice(2);
    const frames = [];
    for (let f = 0; f < 1000; f += 1) {
      const s = 0.3 * Math.sin((2 * Math.PI * f) / 50);
      frames.push("18", `frame ${f}`, ...base.map((line) => {
        const [e, x, y, z] = line.trim().split(/\s+/);
        return `${e} ${(Number(x) * (1 + s / 3)).toFixed(5)} ${(Number(y) * (1 + s / 3)).toFixed(5)} ${Number(z).toFixed(5)}`;
      }));
    }
    writeFileSync(big, frames.join("\n") + "\n");
    const p = await page("?service=0");
    await p.evaluate((file) => window.harness.open("play_mode", { path: file, fps: 20 }), big);
    await waitStatus(p, /1000 frames/, 90000);
    await p.waitForTimeout(1500);
    const calls = await p.evaluate(() => window.harness.serverCalls);
    const state = await p.evaluate(() => window.harness.lastContext()?.structuredContent);
    return { file: await shot(p, "13-no-service-fallback"), calls, frameCount: state?.frame_count, playing: state?.playing };
  },
  async ketcher() {
    const p = await page();
    await p.evaluate(() => window.harness.open("open_ketcher", { smiles: "Cc1ccc(C)cc1" }, { height: 640 }));
    const frame = frameOf(p);
    await frame.waitForFunction(() => /Reported/.test(document.getElementById("status")?.textContent || ""), null, { timeout: 90000 });
    await p.waitForTimeout(1000);
    const seeded = await p.evaluate(() => window.harness.lastContext());
    const first = await shot(p, "14-ketcher-seeded");
    // The person edits in Ketcher's UI: Ctrl+A selects every atom (reported), then the
    // "O" hotkey picks the oxygen tool and a click on empty canvas adds an O atom.
    const canvas = await frame.locator('[class*="StructEditor-module_canvas"]').first().boundingBox();
    await p.mouse.click(canvas.x + canvas.width * 0.85, canvas.y + canvas.height * 0.85);
    await p.keyboard.press("Control+a");
    await p.waitForFunction(() => (window.harness.lastContext()?.structuredContent?.selection?.length ?? 0) > 0, null, { timeout: 15000 });
    const selected = await p.evaluate(() => window.harness.lastContext().structuredContent.selection);
    const selectedShot = await shot(p, "15-ketcher-selected");
    // Click the right-hand CH3 label (selects that atom), then "o" relabels it: p-cresol.
    const methyl = await frame.evaluate(() => {
      const labels = [...document.querySelectorAll("svg text")].filter((t) => t.textContent.trim() === "C");
      const rects = labels.map((t) => t.getBoundingClientRect()).filter((r) => r.width > 0);
      rects.sort((a, b) => b.x - a.x);
      return rects[0] ? { x: rects[0].x + rects[0].width / 2, y: rects[0].y + rects[0].height / 2 } : null;
    });
    const frameBox = await p.locator("iframe").boundingBox();
    await p.mouse.click(canvas.x + canvas.width * 0.95, canvas.y + canvas.height * 0.95);
    await p.mouse.click(frameBox.x + 1 + methyl.x, frameBox.y + 1 + methyl.y);
    await p.waitForTimeout(300);
    await p.keyboard.press("o");
    await p.waitForFunction(() => /O/.test(window.harness.lastContext()?.structuredContent?.smiles || ""), null, { timeout: 15000 });
    const edited = await p.evaluate(() => window.harness.lastContext());
    const second = await shot(p, "16-ketcher-edited");
    const fromServer = await harness.client.callTool({ name: "get_ketcher_structure", arguments: {} });
    const target = path.join(outDir, "work", "ketcher-edit.mol");
    mkdirSync(path.dirname(target), { recursive: true });
    const saved = await harness.client.callTool({ name: "save_ketcher_structure", arguments: { path: target, overwrite: true } });
    return { selected, selectedShot, seeded: seeded?.structuredContent?.smiles, edited: edited.structuredContent.smiles, first, second, getKetcher: fromServer.structuredContent.smiles, saved: saved.content[0].text, molHead: readFileSync(target, "utf8").split("\n").slice(0, 4) };
  },
};

for (const [name, run] of Object.entries(scenarios)) {
  if (only.size && !only.has(name)) continue;
  try {
    results[name] = await run();
    console.log(`ok ${name}`);
  } catch (error) {
    results[name] = { error: error.stack || error.message };
    console.log(`FAILED ${name}: ${error.message}`);
  }
}
results.log = log.slice(-80);
writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
await browser.close();
await harness.close();
console.log(`wrote ${path.join(outDir, "results.json")}`);
