// Workspace files the views may read. A view never names a path itself: the
// server registers a path when a tool opens it and hands the view an opaque
// handle, which the loopback service and the chunked fallback tool resolve.
import { randomBytes } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { packCif } from "./crystal.mjs";

/** Bytes a single fallback chunk carries through the MCP Apps bridge. */
export const CHUNK_BYTES = 512 * 1024;
/** Files at or below this size travel inline in the opening result as well. */
export const INLINE_BYTES = 384 * 1024;
const MAX_HANDLES = 256;

const handles = new Map();

const EXTENSION_FORMATS = new Map([
  ["pdb", "pdb"], ["ent", "pdb"], ["pdbqt", "pdbqt"],
  ["cif", "cif"], ["mmcif", "mmcif"], ["mcif", "mmcif"],
  ["sdf", "sdf"], ["sd", "sdf"], ["mol", "mol"], ["mol2", "mol2"],
  ["xyz", "xyz"], ["extxyz", "xyz"], ["gro", "gro"],
]);

export const SUPPORTED_EXTENSIONS = [...EXTENSION_FORMATS.keys()];

export class ToolInputError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Mol* format id for a file, reading CIF content to tell mmCIF from small-molecule CIF. */
export function molstarFormat(filePath, head) {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const known = EXTENSION_FORMATS.get(extension);
  if (!known) {
    throw new ToolInputError(
      "unsupported_format",
      `Burette cannot open .${extension || "(no extension)"} files. Supported: ${SUPPORTED_EXTENSIONS.join(", ")}.`,
    );
  }
  if (known !== "cif") return known;
  // A core (small-molecule) CIF has fractional coordinates and no mmCIF atom_site loop.
  const isMmcif = /^_atom_site\.(?:label|auth|Cartn|group_PDB|id)/mu.test(head);
  return isMmcif ? "mmcif" : "cifCore";
}

function newHandle() {
  return randomBytes(12).toString("base64url");
}

function remember(entry) {
  if (handles.size >= MAX_HANDLES) handles.delete(handles.keys().next().value);
  handles.set(entry.handle, entry);
  return entry;
}

/** Register a local file by path; returns its handle and a description. */
export async function registerFile(rawPath, { cwd = process.cwd() } = {}) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new ToolInputError("path_missing", "Give the path of a structure file.");
  }
  const absolute = path.resolve(cwd, rawPath.trim());
  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new ToolInputError("file_not_found", `No file at ${absolute}.`);
  }
  if (!info.isFile()) throw new ToolInputError("not_a_file", `${absolute} is not a file.`);
  const head = await readHead(absolute, 64 * 1024);
  const format = molstarFormat(absolute, head);
  for (const entry of handles.values()) {
    if (entry.path === absolute) return { ...entry, byteCount: info.size, mtimeMs: info.mtimeMs, format };
  }
  return remember({
    handle: newHandle(), path: absolute, label: path.basename(absolute), format,
    byteCount: info.size, mtimeMs: info.mtimeMs,
  });
}

/** Register text that has no file (a PDB entry fetched by id). */
export function registerText(text, { label, format }) {
  return remember({
    handle: newHandle(), path: null, label, format, text,
    byteCount: Buffer.byteLength(text), mtimeMs: Date.now(),
  });
}

export function lookup(handle) {
  const entry = handles.get(String(handle || ""));
  if (!entry) throw new ToolInputError("handle_unknown", "This structure handle is not open in this server; open the file again.");
  return entry;
}

/** Current size and modification time, so a view can reload a file that changed on disk. */
export async function statHandle(handle) {
  const entry = lookup(handle);
  if (!entry.path) return { handle, byteCount: entry.byteCount, mtimeMs: entry.mtimeMs, exists: true };
  try {
    const info = await stat(entry.path);
    return { handle, byteCount: info.size, mtimeMs: info.mtimeMs, exists: true };
  } catch {
    return { handle, byteCount: 0, mtimeMs: 0, exists: false };
  }
}

/**
 * What the view receives for an entry: the file bytes, except that a symmetric
 * small-molecule CIF is packed into a P1 cell (see crystal.mjs). Computed on
 * every read, so a file rewritten on disk is packed again.
 */
export async function readWhole(entry) {
  if (!entry.path) return Buffer.from(entry.text);
  const bytes = await readFile(entry.path);
  if (entry.format !== "cifCore") return bytes;
  const packed = packCif(bytes.toString("utf8"));
  entry.packed = packed ? { operators: packed.operators, sites: packed.sites, atoms: packed.atoms } : null;
  return packed ? Buffer.from(packed.text) : bytes;
}

/** One base64 chunk for hosts without the loopback service. */
export async function readChunk(handle, offset = 0) {
  const entry = lookup(handle);
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  if (!entry.path) {
    const buffer = Buffer.from(entry.text);
    const slice = buffer.subarray(start, start + CHUNK_BYTES);
    return { handle, offset: start, byteCount: buffer.length, data: slice.toString("base64"), done: start + slice.length >= buffer.length };
  }
  if (entry.format === "cifCore") {
    const buffer = await readWhole(entry);
    const slice = buffer.subarray(start, start + CHUNK_BYTES);
    const info = await stat(entry.path);
    return { handle, offset: start, byteCount: buffer.length, mtimeMs: info.mtimeMs, data: slice.toString("base64"), done: start + slice.length >= buffer.length };
  }
  const file = await open(entry.path, "r");
  try {
    const info = await file.stat();
    const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, Math.max(0, info.size - start)));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    return {
      handle, offset: start, byteCount: info.size, mtimeMs: info.mtimeMs,
      data: buffer.subarray(0, bytesRead).toString("base64"),
      done: start + bytesRead >= info.size,
    };
  } finally {
    await file.close();
  }
}

async function readHead(absolute, bytes) {
  const file = await open(absolute, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await file.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

/** Frames in a multi-frame XYZ (counted from the atom-count lines), else null. */
export function countXyzFrames(text) {
  const lines = text.split(/\r?\n/u);
  let frames = 0;
  let index = 0;
  while (index < lines.length) {
    const count = Number.parseInt(lines[index].trim(), 10);
    if (!Number.isFinite(count) || count <= 0) break;
    frames += 1;
    index += count + 2;
  }
  return frames || null;
}
