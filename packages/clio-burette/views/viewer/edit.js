// Edit mode of the Burette viewer. Mol* has no geometry editor, so the person
// picks atoms here and the server does the edit (set_geometry / move_atom):
// 2 bonded atoms set a bond length, 3 an angle, 4 a dihedral, and 1 atom can be
// dragged in the view plane. The server writes a new file next to the source;
// the view opens it with the same camera and reports the edit to the host.

const KIND = { 2: "distance", 3: "angle", 4: "dihedral" };
const RANGE = {
  distance: { min: 0.5, max: 4, step: 0.01, unit: "Å" },
  angle: { min: 1, max: 179, step: 1, unit: "°" },
  dihedral: { min: -180, max: 180, step: 1, unit: "°" },
};

const sub = (a, b) => a.map((v, k) => v - b[k]);
const dot = (a, b) => a.reduce((t, v, k) => t + v * b[k], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(...a);
const deg = (r) => (r * 180) / Math.PI;

function measure(kind, p) {
  if (kind === "distance") return norm(sub(p[0], p[1]));
  if (kind === "angle") {
    const u = sub(p[0], p[1]);
    const v = sub(p[2], p[1]);
    return deg(Math.acos(Math.max(-1, Math.min(1, dot(u, v) / (norm(u) * norm(v))))));
  }
  const b1 = sub(p[2], p[1]);
  const n = b1.map((x) => x / norm(b1));
  const b0 = sub(p[0], p[1]);
  const b2 = sub(p[3], p[2]);
  const v = sub(b0, n.map((x) => x * dot(b0, n)));
  const w = sub(b2, n.map((x) => x * dot(b2, n)));
  return deg(Math.atan2(dot(cross(n, v), w), dot(v, w)));
}

/**
 * ctx: {app, state, ui, viewer(), setStatus, scheduleContext, openStructure,
 *       selectAtoms(indices), projectAtom(index) -> {x, y, z, rect, viewport}, unproject([x, y, z]) -> xyz}
 */
export function installEditMode(ctx) {
  const { ui } = ctx;
  let active = false;
  let dragging = false;
  let busy = false;
  let picks = [];

  const label = (index) => {
    const atom = ctx.state.selection?.atoms.find((a) => a.index === index);
    return atom ? `${atom.element}${index}` : String(index);
  };
  const positions = () => picks.map((index) => ctx.state.selection?.atoms.find((a) => a.index === index)?.xyz);

  function render() {
    ui.edit.setAttribute("aria-pressed", String(active));
    ui.editPanel.hidden = !active;
    if (!active) return;
    const kind = KIND[picks.length];
    ui.editMove.hidden = picks.length !== 1;
    ui.editMove.setAttribute("aria-pressed", String(dragging));
    ui.editValue.hidden = !kind;
    ui.editApply.hidden = !kind;
    ui.editSlider.hidden = !kind;
    if (!picks.length) {
      ui.editInfo.textContent = "Click 2–4 bonded atoms in order (bond, angle, dihedral) or 1 atom to drag.";
      return;
    }
    if (!kind) {
      ui.editInfo.textContent = picks.length === 1
        ? `${label(picks[0])}: press Drag atom, then drag in the view to move it in the screen plane.`
        : `${picks.length} atoms picked; pick 2–4 (bond, angle, dihedral) or 1 to drag.`;
      return;
    }
    const points = positions();
    const current = points.every(Boolean) ? measure(kind, points) : null;
    const range = RANGE[kind];
    ui.editInfo.textContent = `${kind} ${picks.map(label).join("–")}: ${current === null ? "?" : current.toFixed(kind === "distance" ? 3 : 1)}${range.unit}`;
    Object.assign(ui.editSlider, { min: range.min, max: range.max, step: range.step });
    if (current !== null && document.activeElement !== ui.editValue) {
      ui.editValue.value = current.toFixed(kind === "distance" ? 3 : 1);
      ui.editSlider.value = String(current);
    }
  }

  /** Keep the order the person clicked atoms in (Mol* selections are sets). */
  function onSelection(selection) {
    const now = selection?.atoms.map((a) => a.index) ?? [];
    picks = picks.filter((index) => now.includes(index));
    for (const index of now) if (!picks.includes(index)) picks.push(index);
    if (picks.length !== 1) dragging = false;
    render();
  }

  async function run(tool, args) {
    if (busy) return;
    const structure = ctx.state.structure;
    if (!structure?.path) {
      ctx.setStatus("This structure has no workspace file to edit.", "error");
      return;
    }
    busy = true;
    ctx.setStatus("Editing…");
    try {
      const result = await ctx.app.callServerTool({ name: tool, arguments: { path: structure.path, frame: ctx.state.frame, ...args } });
      if (result.isError) {
        ctx.setStatus(result.structuredContent?.error?.message ?? result.content?.[0]?.text ?? "The edit was refused.", "error");
        return;
      }
      const edit = result.structuredContent?.edit;
      let descriptor = (result._meta ?? result.meta)?.["burette/structure"];
      if (!descriptor && edit) {
        const registered = await ctx.app.callServerTool({ name: "register_structure", arguments: { path: edit.edited_path } });
        descriptor = registered.structuredContent?.structure;
      }
      const kept = [...picks];
      await ctx.openStructure({ ...descriptor, keepCamera: true, edit });
      await ctx.selectAtoms(kept);
      picks = kept;
      render();
      const name = edit.edited_path.split(/[\\/]/u).pop();
      ctx.setStatus(edit.kind === "move_atom"
        ? `Moved ${label(edit.atoms[0])} · wrote ${name}`
        : `${edit.kind} ${edit.before} → ${edit.after} · wrote ${name}`);
    } catch (error) {
      ctx.setStatus(error.message || String(error), "error");
    } finally {
      busy = false;
    }
  }

  function applyValue(value) {
    const kind = KIND[picks.length];
    if (!kind || !Number.isFinite(value)) return;
    run("set_geometry", { kind, atoms: [...picks], value });
  }

  ui.edit.addEventListener("click", () => {
    active = !active;
    dragging = false;
    if (active) onSelection(ctx.state.selection);
    render();
  });
  ui.editSlider.addEventListener("input", () => { ui.editValue.value = ui.editSlider.value; });
  ui.editSlider.addEventListener("change", () => applyValue(Number(ui.editSlider.value)));
  ui.editApply.addEventListener("click", () => applyValue(Number(ui.editValue.value)));
  ui.editValue.addEventListener("keydown", (event) => { if (event.key === "Enter") applyValue(Number(ui.editValue.value)); });
  ui.editMove.addEventListener("click", () => {
    dragging = !dragging;
    ui.overlay.hidden = !dragging;
    ui.overlay.dataset.mode = dragging ? "move" : "";
    render();
  });

  // Dragging one atom: the overlay catches the pointer; the atom keeps its depth.
  let start = null;
  ui.overlay.addEventListener("pointerdown", (event) => {
    if (ui.overlay.dataset.mode !== "move") return;
    start = { x: event.clientX, y: event.clientY };
    ui.overlay.setPointerCapture(event.pointerId);
  }, true);
  ui.overlay.addEventListener("pointerup", (event) => {
    if (ui.overlay.dataset.mode !== "move" || !start) return;
    event.stopImmediatePropagation();
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    start = null;
    dragging = false;
    ui.overlay.hidden = true;
    ui.overlay.dataset.mode = "";
    render();
    if (Math.hypot(dx, dy) < 2) return;
    const projected = ctx.projectAtom(picks[0]);
    const ratio = projected.viewport.width / projected.rect.width;
    const position = ctx.unproject([projected.x + dx * ratio, projected.y + dy * ratio, projected.z]);
    run("move_atom", { atom: picks[0], position });
  }, true);

  return { onSelection, render, picks: () => [...picks], isActive: () => active };
}
