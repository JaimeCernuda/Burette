// Small-molecule CIF to a packed P1 cell. Mol* applies every symmetry operator
// of a core CIF without merging atoms on special positions (magnetite: 576 images
// for a 56-atom cell, 13k duplicate bonds), so the server packs the cell first:
// operators applied, fractional coordinates wrapped into [0, 1), coincident
// atoms merged. Site labels are kept, so a selection still names its source site.

const MERGE_TOLERANCE = 1e-3; // fractional

function tokenize(line) {
  const tokens = [];
  const pattern = /'([^']*)'(?=\s|$)|"([^"]*)"(?=\s|$)|(\S+)/gu;
  for (const match of line.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}

/** Tags and loops of the first data block (enough for cell, symmetry and atom sites). */
export function parseCif(text) {
  const lines = text.split(/\r?\n/u);
  const tags = new Map();
  const loops = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (line.startsWith("loop_")) {
      const header = [];
      index += 1;
      while (index < lines.length && lines[index].trim().startsWith("_")) {
        header.push(lines[index].trim().split(/\s+/u)[0].toLowerCase());
        index += 1;
      }
      const values = [];
      while (index < lines.length) {
        const row = lines[index].trim();
        if (!row || row.startsWith("#")) { index += 1; continue; }
        if (row.startsWith("_") || row.startsWith("loop_") || row.startsWith("data_")) break;
        if (row.startsWith(";")) break; // text fields are not used here
        values.push(...tokenize(row));
        index += 1;
      }
      const rows = [];
      for (let i = 0; i + header.length <= values.length; i += header.length) rows.push(values.slice(i, i + header.length));
      loops.push({ header, rows });
      continue;
    }
    if (line.startsWith("_")) {
      const [tag, ...rest] = tokenize(line);
      tags.set(tag.toLowerCase(), rest.join(" "));
    }
    index += 1;
  }
  return { tags, loops };
}

const number = (value) => Number.parseFloat(String(value).replace(/\(.*\)$/u, ""));

function loopWith(cif, tag) {
  return cif.loops.find((loop) => loop.header.includes(tag)) ?? null;
}

/** "-x+3/4" style operator rows to [[r00, r01, r02, t0], ...]. */
export function parseOperator(op) {
  return op.replace(/\s+/gu, "").toLowerCase().split(",").map((expression) => {
    const row = [0, 0, 0, 0];
    for (const [, sign, body] of expression.matchAll(/([+-]?)([^+-]+)/gu)) {
      const s = sign === "-" ? -1 : 1;
      const axis = "xyz".indexOf(body.at(-1));
      if (axis >= 0) {
        const factor = body.length > 1 ? Number(body.slice(0, -1).replace(/\*$/u, "")) : 1;
        row[axis] += s * factor;
      } else if (body.includes("/")) {
        const [n, d] = body.split("/").map(Number);
        row[3] += (s * n) / d;
      } else {
        row[3] += s * Number(body);
      }
    }
    return row;
  });
}

const wrap = (value) => {
  const w = value - Math.floor(value);
  return w > 1 - MERGE_TOLERANCE ? 0 : w;
};

function sameSite(a, b) {
  for (let k = 0; k < 3; k += 1) {
    let d = Math.abs(a[k] - b[k]);
    d = Math.min(d, 1 - d);
    if (d > MERGE_TOLERANCE) return false;
  }
  return true;
}

/**
 * Pack a symmetric core CIF into P1. Returns null when there is nothing to do
 * (no operator list, only the identity, or no fractional atom sites).
 */
export function packCif(text) {
  const cif = parseCif(text);
  const opsLoop = loopWith(cif, "_symmetry_equiv_pos_as_xyz") ?? loopWith(cif, "_space_group_symop_operation_xyz");
  const sites = loopWith(cif, "_atom_site_fract_x");
  if (!opsLoop || !sites) return null;
  const opColumn = opsLoop.header.findIndex((h) => h === "_symmetry_equiv_pos_as_xyz" || h === "_space_group_symop_operation_xyz");
  const operators = opsLoop.rows.map((row) => parseOperator(row[opColumn]));
  if (operators.length <= 1) return null;
  const column = (name) => sites.header.indexOf(name);
  const [cx, cy, cz] = ["_atom_site_fract_x", "_atom_site_fract_y", "_atom_site_fract_z"].map(column);
  const cLabel = column("_atom_site_label");
  const cType = column("_atom_site_type_symbol");
  const cOcc = column("_atom_site_occupancy");
  const packed = [];
  for (const row of sites.rows) {
    const label = cLabel >= 0 ? row[cLabel] : row[cType];
    const type = cType >= 0 ? row[cType] : String(label).replace(/[^A-Za-z].*$/u, "");
    const fract = [number(row[cx]), number(row[cy]), number(row[cz])];
    const occupancy = cOcc >= 0 ? row[cOcc] : "1";
    const images = [];
    for (const op of operators) {
      const p = op.map((r) => wrap(r[0] * fract[0] + r[1] * fract[1] + r[2] * fract[2] + r[3]));
      if (!images.some((q) => sameSite(p, q))) images.push(p);
    }
    for (const p of images) packed.push({ label, type, fract: p, occupancy });
  }
  const keep = (name) => cif.tags.get(name);
  const header = [
    "data_burette_packed",
    `# Packed by burette-clio: ${operators.length} symmetry operators applied to ${sites.rows.length} sites,`,
    `# wrapped into the cell and merged: ${packed.length} atoms (space group P1).`,
  ];
  for (const name of ["_cell_length_a", "_cell_length_b", "_cell_length_c", "_cell_angle_alpha", "_cell_angle_beta", "_cell_angle_gamma"]) {
    if (keep(name) !== undefined) header.push(`${name} ${keep(name)}`);
  }
  const hm = keep("_symmetry_space_group_name_h-m") ?? keep("_space_group_name_h-m_alt");
  if (hm) header.push(`# Source space group: ${hm}`);
  const body = [
    ...header,
    "_symmetry_space_group_name_H-M 'P 1'",
    "loop_",
    "_symmetry_equiv_pos_as_xyz",
    "'x,y,z'",
    "loop_",
    "_atom_site_label",
    "_atom_site_type_symbol",
    "_atom_site_fract_x",
    "_atom_site_fract_y",
    "_atom_site_fract_z",
    "_atom_site_occupancy",
    ...packed.map((a) => `${a.label} ${a.type} ${a.fract.map((v) => v.toFixed(6)).join(" ")} ${a.occupancy}`),
    "",
  ];
  return { text: body.join("\n"), operators: operators.length, sites: sites.rows.length, atoms: packed.length };
}
