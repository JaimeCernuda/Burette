# burette-clio

Burette's molecular viewer (Mol*) and Ketcher editor as one stdio MCP server for
[CLIO](https://github.com/iowarp/clio-agent). One Node process serves the MCP Apps
views as `ui://` resources and the workspace tools beside them. This package is a
thin Python wrapper that runs the prebuilt server with the Node.js from
`nodejs-wheel-binaries`, so nothing is built on the user's machine.

```bash
uvx --from "git+https://github.com/JaimeCernuda/Burette@<sha>#subdirectory=packages/clio-burette" burette-clio
```

## What it merges

| From | Kept | Left out |
| --- | --- | --- |
| Hosted public plugin (`apps/burette-public-plugin`) | The view contracts `ui://burette/molecular-viewer-v21.html` and `ui://burette/ketcher-editor-v1.html` (`text/html;profile=mcp-app`), PDB-ID fetch, Ketcher seed/edit loop, the CSP check on the vendored Mol* bundle | Vercel/Next.js hosting, attachment download and its 3 MiB in-memory cap, analytics, the OpenAI widget globals, the ephemeral relay |
| Local agent plugin (`plugins/burette-agent`) | Structure summaries (`structure-summary.mjs`) and fragment edits (`structure-components.mjs`), imported unchanged | The external browser preview, the macOS app bridge, session directories, capture/report panels, MVS stories |

The views are built from Burette's own runtime: the reviewed Mol* bundle in
`PreviewExtension/Web/molstar.js` and the desktop app's `KetcherEditor`
component with its Ketcher UI plugins. They are not the full React desktop shell
of the hosted widget (about 100 MB of assets); the viewer is a focused page with
the bridge code below.

## Tools

Model-facing:

| Tool | Opens a view | What it does |
| --- | --- | --- |
| `open_structure` | viewer | Opens a workspace file by path: PDB, PDBQT poses, mmCIF, CIF with unit cell, SDF/MOL, XYZ (multi-frame = trajectory), GRO, MOL2. Optional `frame`, `focus`, `supercell`. |
| `play_mode` | viewer | Plays a normal mode or short trajectory written as a multi-frame XYZ, looping (`path` or `mode`, `fps`, `loop`). |
| `open_pdb_entry` | viewer | Fetches one RCSB entry by ID and opens it. |
| `summarize_structure` | no | Atoms, residues, chains, ligands, waters, ions, elements and models of a file. |
| `edit_fragment` | no | Writes a new PDB with a fragment extracted, removed or replaced (topology, not geometry). |
| `open_ketcher` | Ketcher | Opens the 2D editor seeded with SMILES, a MOL block or a .mol/.sdf/.smi file. |
| `get_ketcher_structure` | no | The person's current drawing as SMILES and MOL. |
| `save_ketcher_structure` | no | Writes that drawing to a workspace file as MOL, SDF or SMILES. |

View helpers (`_meta.ui.visibility: ["app"]`): `register_structure`,
`read_structure_chunk`, `stat_structure`, `ketcher_report`.

App tools the viewer registers (CLIO offers them as `app__<server>__<tool>`):
`set_frame({frame})`, `play_mode({path|mode, fps?, playing?})`,
`focus({atoms?|residues?|focus?})`, `describe_region({rect?, relative_to?})`,
`get_view_state()`. The Ketcher view registers `get_ketcher_structure` and
`set_ketcher_structure({smiles?|molfile?})`.

Every path argument is declared in the tool definition as
`_meta["ai.iowarp.clio/paths"] = {"<arg>": {"machine": "local", "access": "read"|"write"}}`.
The viewer-opening tools declare their state keys in
`_meta["ai.iowarp.clio/state"]`: `frame` (set with `set_frame`), `mode` (set with
`play_mode`), `focus` (set with `focus`), `selection`, `region`, `path`,
`frame_count`, `playing`. An A2UI chart can drive the frame, mode and focus
through those channels.

## How the views get their data

The result that opens a view declares a loopback service in its private `_meta`:
`"ai.iowarp.clio/service": {"port", "token"}` (CLIO MA23). CLIO proxies it under the
app's capability route on the sandbox origin and gives the view
`hostContext["ai.iowarp.clio/service"].url`. Through it the view loads Mol*,
Ketcher (with its Indigo WASM worker) and the workspace file, with no size cap.
The service binds `127.0.0.1` and refuses any request without the bearer token.
The view never sees a path it can choose: files are addressed by an opaque handle
the opening tool registered.

A host without the service still gets the viewer: Mol* is read as the resources
`ui://burette/assets/molstar.js` and `.css`, and the file in 512 KiB chunks through
`read_structure_chunk` (`callServerTool`). Files of 384 KiB or less also travel
inline in the opening result. The Ketcher view needs the service.

The viewer polls the file's modification time every 1.5 s and reloads it, keeping
the camera and frame, so a geometry change written by another tool (for example
ASE's `set_geometry`) shows without reopening the view.

A small-molecule CIF with a symmetry operator list is packed by the server into a
P1 cell (operators applied, coordinates wrapped into the cell, coincident atoms
merged) before the view gets it. Mol* applies the operators without merging
special positions (magnetite: 576 images and 13,412 duplicate bonds for a 56-atom
cell). Atom indices of a packed crystal count the packed cell, and each atom
carries its CIF site label as `site`.

## Messages from the views (`ui/update-model-context`)

Viewer, sent on selection, region, focus, frame change and file load (at most
every 150 ms; about once a second while playing):

```json
{
  "content": [{"type": "text", "text": "Burette viewer shows /w/p-xylene.xyz (xyz), frame 1 of 1. The person selected 7 atoms (0-based file indices): C3, H8, C9, …; centroid -2.366, 0, 0 Å."}],
  "structuredContent": {
    "burette": "viewer/v1",
    "path": "/w/p-xylene.xyz", "label": "p-xylene.xyz", "format": "xyz",
    "frame": 0, "frame_count": 1, "playing": false, "mode": null, "focus": null,
    "selection": {
      "path": "/w/p-xylene.xyz", "frame": 0, "count": 7, "truncated": false,
      "indices": [3, 8, 9, 10, 15, 16, 17],
      "elements": {"C": 2, "H": 5},
      "residues": [],
      "centroid": [-2.366, 0, 0],
      "atoms": [{"index": 3, "element": "C", "xyz": [-1.39, 0, 0]}]
    },
    "region": {"rect": {"x": 0.12, "y": 0.26, "width": 0.33, "height": 0.55}, "relative_to": "view",
               "count": 7, "indices": [3, 8, 9, 10, 15, 16, 17], "elements": {"C": 2, "H": 5},
               "residues": [], "centroid": [-2.366, 0, 0]}
  }
}
```

`index` is the 0-based position of the atom in the file (Mol*'s source index).
Atoms with residues also carry `name`, `residue`, `seq` and `chain`; atoms of a
symmetry image carry `image` (the operator name), and atoms of a packed crystal
carry `site`. At most 256 atoms are listed; `count`, `indices` of the listed atoms,
`elements` and `centroid` cover the whole selection.

Ketcher, sent after each edit or selection change (400 ms debounce):

```json
{
  "content": [{"type": "text", "text": "Ketcher (ketcher-…) shows SMILES Cc1ccc(O)cc1. …"}],
  "structuredContent": {"burette": "ketcher/v1", "surfaceId": "ketcher-…", "smiles": "Cc1ccc(O)cc1",
                        "molfile": "…V2000…", "selection": [{"index": 6, "element": "C"}]}
}
```

`molfile` is left out of the context when it exceeds 32 KiB;
`get_ketcher_structure` always returns it.

## Building

The bundle under `src/clio_burette/bundle/` is committed. Rebuild it from the
repository root after `bun install`:

```bash
node packages/clio-burette/scripts/build.mjs
```

It writes `server.mjs` (the MCP SDK, zod and ext-apps inlined; no runtime
`node_modules`), the two view HTML files with their bridge code inlined, Mol*
from `PreviewExtension/Web`, and the Ketcher build (`views/ketcher/vite.config.mjs`).

## Checks

```bash
node packages/clio-burette/tests/stdio-check.mjs            # tools and resources over stdio
node packages/clio-burette/tests/run-views.mjs <out-dir>    # views in the harness host, screenshots
```

`tests/harness/` is a minimal MCP Apps host built on ext-apps' `AppBridge`: it
loads a view resource, sends tool input and results, relays the view's
`tools/call` and `resources/read`, records `ui/update-model-context`, calls the
view's app tools, and proxies the loopback service with its token as CLIO does.
The fixtures (`tests/fixtures/`) are synthetic: `make_fixtures.py` writes
p-xylene and a 20-frame mode; `make_magnetite.py` (ASE) writes magnetite and a
Fe3O4(001) slab with water.

## Licenses

Burette is MIT. The bundle contains Mol* (MIT), Ketcher and Indigo (Apache-2.0,
EPAM Systems), React (MIT), the MCP SDK and ext-apps (MIT) and zod (MIT). See
`bundle/LICENSE`, `bundle/THIRD_PARTY_NOTICES.md` and
`bundle/LICENSE-ketcher-indigo-apache-2.0.txt`.
