// Geometry edits for the viewer and the agent: set a bond length, angle or
// dihedral, or move one atom, and write the result to a NEW file next to the
// source. Bonds come from covalent radii x 1.15 (the convention of the ase
// server's set_geometry); the smaller fragment on the moving side of the cut
// bond moves rigidly, and a bond inside a ring is refused.
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ToolInputError } from "./files.mjs";

const BOND_SCALE = 1.15;

// Covalent radii in Å (Cordero et al. 2008, as tabulated in ase.data.covalent_radii).
const RADII = {
  H: 0.31, He: 0.28, Li: 1.28, Be: 0.96, B: 0.84, C: 0.76, N: 0.71, O: 0.66, F: 0.57, Ne: 0.58,
  Na: 1.66, Mg: 1.41, Al: 1.21, Si: 1.11, P: 1.07, S: 1.05, Cl: 1.02, Ar: 1.06, K: 2.03, Ca: 1.76,
  Sc: 1.70, Ti: 1.60, V: 1.53, Cr: 1.39, Mn: 1.39, Fe: 1.32, Co: 1.26, Ni: 1.24, Cu: 1.32, Zn: 1.22,
  Ga: 1.22, Ge: 1.20, As: 1.19, Se: 1.20, Br: 1.20, Kr: 1.16, Rb: 2.20, Sr: 1.95, Y: 1.90, Zr: 1.75,
  Nb: 1.64, Mo: 1.54, Tc: 1.47, Ru: 1.46, Rh: 1.42, Pd: 1.39, Ag: 1.45, Cd: 1.44, In: 1.42, Sn: 1.39,
  Sb: 1.39, Te: 1.38, I: 1.39, Xe: 1.40, Cs: 2.44, Ba: 2.15, La: 2.07, Pt: 1.36, Au: 1.36, Hg: 1.32,
  Pb: 1.46, Bi: 1.48,
};
const radius = (element) => RADII[element] ?? 1.5;

// ---- Reading and writing coordinates, keeping every other line of the file ----

function normalizeElement(raw) {
  const letters = String(raw).replace(/[^A-Za-z]/gu, "");
  if (!letters) return "X";
  const two = letters.slice(0, 2);
  const candidate = two[0].toUpperCase() + (two[1] ?? "").toLowerCase();
  return RADII[candidate] ? candidate : letters[0].toUpperCase();
}

/** Atoms of one frame/model with a writer that puts new coordinates back. */
export function readStructure(text, format, frame = 0) {
  const lines = text.split(/\r?\n/u);
  if (format === "xyz") {
    let start = 0;
    for (let f = 0; ; f += 1) {
      const count = Number.parseInt(lines[start]?.trim(), 10);
      if (!Number.isFinite(count) || count <= 0) throw new ToolInputError("frame_out_of_range", `The file has no frame ${frame}.`);
      if (f === frame) {
        const atoms = lines.slice(start + 2, start + 2 + count).map((line) => {
          const [element, x, y, z] = line.trim().split(/\s+/u);
          return { element: normalizeElement(element), xyz: [Number(x), Number(y), Number(z)] };
        });
        const header = lines.slice(start, start + 2);
        return {
          atoms,
          write: (coords) => [...header, ...atoms.map((a, i) => `${a.element} ${coords[i].map((v) => v.toFixed(6)).join(" ")}`), ""].join("\n"),
          note: "One frame (the edited one) is written.",
        };
      }
      start += count + 2;
    }
  }
  if (format === "pdb" || format === "pdbqt") {
    const rows = [];
    let models = 0;
    let inFrame = frame === 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.startsWith("MODEL")) { inFrame = models === frame; models += 1; continue; }
      if (line.startsWith("ENDMDL")) { if (inFrame && rows.length) break; continue; }
      if (inFrame && (line.startsWith("ATOM") || line.startsWith("HETATM"))) {
        const element = line.slice(76, 78).trim() || line.slice(12, 16).trim();
        rows.push({ index: i, element: normalizeElement(element), xyz: [30, 38, 46].map((s) => Number(line.slice(s, s + 8))) });
      }
    }
    if (!rows.length) throw new ToolInputError("frame_out_of_range", `The file has no model ${frame}.`);
    return {
      atoms: rows,
      write: (coords) => {
        const out = [...lines];
        rows.forEach((row, k) => {
          const line = out[row.index].padEnd(54);
          out[row.index] = line.slice(0, 30) + coords[k].map((v) => v.toFixed(3).padStart(8)).join("") + line.slice(54);
        });
        return out.join("\n");
      },
      note: "Only coordinates changed; CONECT and other records are kept.",
    };
  }
  if (format === "sdf" || format === "mol") {
    const counts = lines[3] ?? "";
    if (/V3000/u.test(counts)) throw new ToolInputError("unsupported_format", "V3000 MOL/SDF files are not supported for geometry edits.");
    const n = Number.parseInt(counts.slice(0, 3), 10);
    const rows = lines.slice(4, 4 + n).map((line, k) => ({
      index: 4 + k,
      element: normalizeElement(line.slice(31, 34)),
      xyz: [0, 10, 20].map((s) => Number(line.slice(s, s + 10))),
    }));
    const end = lines.findIndex((l) => l.startsWith("$$$$"));
    return {
      atoms: rows,
      write: (coords) => {
        const out = (end >= 0 ? lines.slice(0, end + 1) : lines).slice();
        rows.forEach((row, k) => {
          out[row.index] = coords[k].map((v) => v.toFixed(4).padStart(10)).join("") + out[row.index].slice(30);
        });
        return `${out.join("\n").replace(/\s*$/u, "")}\n`;
      },
      note: "The first record is written.",
    };
  }
  throw new ToolInputError("unsupported_format", `Geometry edits work on XYZ, PDB/PDBQT and SDF/MOL files, not ${format}.`);
}

// ---- Vector helpers --------------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => scale(a, 1 / norm(a));
const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;

export const measure = {
  distance: (c, [a, b]) => norm(sub(c[a], c[b])),
  angle: (c, [a, b, d]) => {
    const cosine = dot(unit(sub(c[a], c[b])), unit(sub(c[d], c[b])));
    return deg(Math.acos(Math.max(-1, Math.min(1, cosine))));
  },
  dihedral: (c, [a, b, d, e]) => {
    const b0 = sub(c[a], c[b]);
    const b1 = unit(sub(c[d], c[b]));
    const b2 = sub(c[e], c[d]);
    const v = sub(b0, scale(b1, dot(b0, b1)));
    const w = sub(b2, scale(b1, dot(b2, b1)));
    return deg(Math.atan2(dot(cross(b1, v), w), dot(v, w)));
  },
};

/** Rodrigues rotation of point p about the axis through o along unit k. */
function rotate(p, o, k, angle) {
  const v = sub(p, o);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add(o, add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c))));
}

// ---- Bonds and fragments ----------------------------------------------------------

export function bondGraph(atoms) {
  const neighbours = atoms.map(() => []);
  for (let i = 0; i < atoms.length; i += 1) {
    for (let j = i + 1; j < atoms.length; j += 1) {
      const cutoff = (radius(atoms[i].element) + radius(atoms[j].element)) * BOND_SCALE;
      if (norm(sub(atoms[i].xyz, atoms[j].xyz)) < cutoff) {
        neighbours[i].push(j);
        neighbours[j].push(i);
      }
    }
  }
  return neighbours;
}

function label(atoms, i) {
  return `${atoms[i].element}${i}`;
}

/** The atoms reachable from `start` without crossing the bond start-other. */
function sideOf(neighbours, start, other) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const atom = queue.shift();
    for (const next of neighbours[atom]) {
      if (atom === start && next === other) continue;
      if (next === other && atom !== start) return null; // reached the other end: a ring
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return seen;
}

function requireBond(atoms, neighbours, i, j) {
  if (!neighbours[i].includes(j)) {
    throw new ToolInputError("not_bonded", `${label(atoms, i)} and ${label(atoms, j)} are not bonded, so that bond cannot be changed.`);
  }
}

/** Split at bond i-j; returns {moving, pivot, fixedEnd, movingEnd} with the smaller side moving. */
function splitAt(atoms, neighbours, i, j, kind) {
  const sideI = sideOf(neighbours, i, j);
  const sideJ = sideOf(neighbours, j, i);
  if (!sideI || !sideJ) {
    throw new ToolInputError("ring_bond", `The bond ${label(atoms, i)}-${label(atoms, j)} is in a ring; changing its ${kind} would break the ring.`);
  }
  return sideJ.size <= sideI.size
    ? { moving: sideJ, movingEnd: j, fixedEnd: i }
    : { moving: sideI, movingEnd: i, fixedEnd: j };
}

function validateIndices(atoms, indices, count) {
  if (!Array.isArray(indices) || indices.length !== count) {
    throw new ToolInputError("atoms_count", `Give ${count} atom indices.`);
  }
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 0 || i >= atoms.length) throw new ToolInputError("atom_out_of_range", `Atom ${i} is not in the structure (0-${atoms.length - 1}).`);
  }
  if (new Set(indices).size !== count) throw new ToolInputError("atoms_repeated", "The atoms must be different.");
}

// ---- Edits -------------------------------------------------------------------------

/** Apply one geometry edit to coordinates; returns new coordinates and what moved. */
export function applyEdit(atoms, { kind, atoms: indices, value, position, displacement }) {
  const coords = atoms.map((a) => [...a.xyz]);
  const neighbours = bondGraph(atoms);
  if (kind === "move_atom") {
    validateIndices(atoms, indices, 1);
    const [i] = indices;
    const before = [...coords[i]];
    if (Array.isArray(position)) coords[i] = position.map(Number);
    else if (Array.isArray(displacement)) coords[i] = add(coords[i], displacement.map(Number));
    else throw new ToolInputError("move_target_missing", "Give a position or a displacement in Å.");
    return { coords, before, after: coords[i], moved: [i] };
  }
  const count = { distance: 2, angle: 3, dihedral: 4 }[kind];
  if (!count) throw new ToolInputError("kind_unknown", "kind is distance, angle or dihedral.");
  validateIndices(atoms, indices, count);
  if (!Number.isFinite(Number(value))) throw new ToolInputError("value_missing", `Give the new ${kind}.`);
  const target = Number(value);
  for (let k = 0; k + 1 < count; k += 1) requireBond(atoms, neighbours, indices[k], indices[k + 1]);
  const before = measure[kind](coords, indices);
  let moving;
  if (kind === "distance") {
    if (target <= 0.1) throw new ToolInputError("value_invalid", "A bond length must be longer than 0.1 Å.");
    const [a, b] = indices;
    const split = splitAt(atoms, neighbours, a, b, "length");
    moving = split.moving;
    const direction = unit(sub(coords[split.movingEnd], coords[split.fixedEnd]));
    const shift = scale(direction, target - before);
    for (const m of moving) coords[m] = add(coords[m], shift);
  } else if (kind === "angle") {
    if (target <= 0 || target >= 180) throw new ToolInputError("value_invalid", "An angle must be between 0 and 180 degrees.");
    const [a, b, c] = indices;
    // Move the smaller end fragment that does not hold the vertex; a ring bond is skipped.
    const options = [];
    let refusal = null;
    for (const end of [c, a]) {
      try {
        const split = splitAt(atoms, neighbours, b, end, "angle");
        if (split.movingEnd === end) options.push(split);
      } catch (error) {
        refusal = error;
      }
    }
    if (!options.length) {
      throw refusal ?? new ToolInputError("vertex_fragment", "Both ends are larger than the vertex side; the angle cannot be changed by moving one end.");
    }
    options.sort((x, y) => x.moving.size - y.moving.size);
    const chosen = options[0];
    const useC = chosen.movingEnd === c;
    moving = chosen.moving;
    const axis = unit(cross(sub(coords[a], coords[b]), sub(coords[c], coords[b])));
    if (!Number.isFinite(axis[0])) throw new ToolInputError("linear", "The three atoms are colinear; the rotation plane is undefined.");
    const turn = (angle) => { for (const m of moving) coords[m] = rotate(coords[m], coords[b], axis, angle); };
    const delta = rad(target - before) * (useC ? 1 : -1);
    turn(delta);
    if (Math.abs(measure.angle(coords, indices) - target) > 1e-3) turn(-2 * delta);
  } else {
    const [a, b, c, d] = indices;
    const split = splitAt(atoms, neighbours, b, c, "dihedral");
    moving = split.moving;
    const axis = unit(sub(coords[c], coords[b]));
    const wrap = (x) => ((x + 540) % 360) - 180;
    const delta = rad(wrap(target - before));
    const turn = (angle) => { for (const m of moving) coords[m] = rotate(coords[m], coords[b], axis, angle); };
    turn(delta);
    if (Math.abs(wrap(measure.dihedral(coords, indices) - target)) > 1e-3) turn(-2 * delta);
  }
  return { coords, before, after: measure[kind](coords, indices), moved: [...moving].sort((x, y) => x - y) };
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** A new file next to the source: name.edit1.ext, name.edit2.ext, … (never overwritten). */
export async function nextEditPath(source) {
  const dir = path.dirname(source);
  const ext = path.extname(source);
  const stem = path.basename(source, ext).replace(/\.edit\d+$/u, "");
  for (let n = 1; n < 10000; n += 1) {
    const candidate = path.join(dir, `${stem}.edit${n}${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new ToolInputError("no_free_name", "No free edit file name next to the source.");
}

/** Read the source, apply the edit, write a new file; returns the edit record. */
export async function editFile(source, format, edit) {
  if (format === "cifCore" || format === "mmcif") {
    throw new ToolInputError("unsupported_format", "Geometry edits work on XYZ, PDB/PDBQT and SDF/MOL files.");
  }
  const text = await readFile(source, "utf8");
  const frame = Number.isInteger(edit.frame) ? edit.frame : 0;
  const structure = readStructure(text, format, frame);
  const result = applyEdit(structure.atoms, edit);
  const output = await nextEditPath(source);
  await writeFile(output, structure.write(result.coords), { flag: "wx" });
  const round = (v) => (Array.isArray(v) ? v.map((x) => Math.round(x * 1000) / 1000) : Math.round(v * 1000) / 1000);
  return {
    source_path: source,
    edited_path: output,
    kind: edit.kind,
    atoms: edit.atoms,
    frame,
    before: round(result.before),
    after: round(result.after),
    moved_atoms: result.moved,
    note: structure.note,
  };
}
