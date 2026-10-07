# circuit-json-to-gmsh

Convert tscircuit **circuit-json** into physical PCB CAD and Gmsh meshes. Inspect copper, plated barrels, dielectric interfaces and cross-sections with **PoppyGL**. Tests generate their circuit-json from TSX.

<img width="640" height="480" alt="image" src="https://github.com/user-attachments/assets/1af1ab0f-76b9-43f5-b2d8-a478a06cedfc" />

<img width="640" height="480" alt="image" src="https://github.com/user-attachments/assets/00ed291d-a90c-4632-b804-d4333fc834b1" />

## Run on a tscircuit board

Export your circuit's JSON, then supply its manufacturing stackup. Units are millimetres; circuit coordinates use +Y up and +Z towards top copper.

```sh
bun install
python3 -m venv .venv
.venv/bin/pip install -r lib/python/requirements.txt
export GMSH_PYTHON="$PWD/.venv/bin/python"

bun lib/cli.ts board.circuit.json \
  --stackup-file stackup.json \
  --output work/board --conformal --mesh-size 0.5
```

On Linux, install `libglu1-mesa` if the Gmsh wheel needs `libGLU.so.1`.

A two-layer `stackup.json`:

```json
{
  "layers": [
    { "name": "top", "copperThicknessMm": 0.035 },
    { "material": "FR4", "dielectricThicknessMm": 0.8, "dielectricConstant": 4.3 },
    { "name": "bottom", "copperThicknessMm": 0.035 }
  ]
}
```

For multilayer boards, alternate copper and dielectric from top to bottom: `top`, `inner1`, `inner2`, …, `bottom`. Thicknesses and dielectric properties come from your fabricator. Physical via spans come from `pcb_via.layers` and plated-hole metadata; through-via stubs remain present.

The default export writes `board.brep`, `preview.json`, `preview.png`, `report.json`, `model.json` and `gmsh.log`. It is a CAD assembly with independently triangulated solids. `--conformal` partitions shared material interfaces and writes a tetrahedral `board.msh` with named copper-net and dielectric physical groups. `--cad-only` skips triangulation for large assemblies; `--step` adds STEP output.

The mesh size is a maximum target, in mm. Geometric features can force smaller elements. A successful mesh is a geometry check; EM accuracy still requires a solver and convergence testing. This converter does not use a frequency or excitation.

## Validate the saved mesh

Every `--conformal` export reloads `board.msh` in a fresh native Gmsh process and writes `validation.json`. It checks tetrahedron orientation/quality, per-volume material ownership and volume coverage, manifold faces, CAD interface triangle incidence, copper-net separation, and tetrahedra intersecting drill/cutout interiors. All CAD faces are saved as physical boundary groups; `mesh-manifest.json` records their expected adjacent volumes.

Request physical copper paths using refdes and pin aliases:

```sh
bun lib/cli.ts board.circuit.json --stackup-file stackup.json \
  --conformal --output work/board \
  --connection U1.P1:U3.F3 --connection U1.P2:U3.G3
```

These are **connectivity requirements**, not frequency sources or EM ports. Pin names, `pinN`, and `port_hints` resolve from source connectivity and PCB pads. Probes sit inside the physical copper thickness, away from co-located drills. Multi-layer terminal pads require an explicit layer/position through the library API.

```ts
import { createMeshRequirements, exportGmsh, validateMesh } from "circuit-json-to-gmsh"

const requirements = createMeshRequirements({
  circuitJson, model,
  connections: [{ from: "U1.P1", to: "U3.F3" }],
})
const result = await exportGmsh({
  model, outputDirectory: "work/board", conformal: true,
  validationRequirements: requirements,
})
console.log(result.validation?.connections)

// Also check an existing or externally modified saved mesh.
const report = await validateMesh({
  meshPath: result.meshPath!, manifestPath: result.manifestPath,
  model, requirements, outputDirectory: "work/recheck",
})
if (!report.passed) console.log(report.checks.filter((c) => c.passed === false))
```

`exportGmsh` rejects failed checks and retains the mesh, manifest, logs and validation report for reproduction. `validateMesh` returns failed checks for inspection. To recheck from the terminal:

```sh
bun lib/cli.ts validate work/board/board.msh \
  --manifest work/board/mesh-manifest.json --model work/board/model.json \
  --requirements-file work/board/validation-requirements.json \
  --output work/recheck
```

The validation CLI exits 1 on failure. Checks without their required model/manifest/endpoint requirements are explicitly incomplete; `pcbChecksComplete` requires all three. Floating copper islands are reported by net and only fail when a requested terminal path is broken. Cross-net contacts include coincident nodes with different tags, quantized at 0.0000001 mm. `--minimum-tet-quality` can impose a `minSICN` threshold; the default rejects nonpositive quality. Void intersections exclude a 0.000002 mm boundary tolerance to accommodate the 0.000001 mm CAD precision and reject projected overlap greater than `1e-10 mm²`. Tests include a tetrahedron crossing a drill despite all of its vertices lying outside the hole.

Only first-order tetrahedra and triangular boundaries are currently supported. Passing these checks establishes mesh consistency with the supplied geometry. It does not establish EM accuracy, a valid external-domain boundary condition, or a valid Palace lumped-port aperture.

## DQS mesh regressions

The TSX differential-pair regression checks two separate nets, through-via stubs below the routed `inner1` transition, hollow drills, and physical endpoint paths. Independent corruption tests remove interface triangles, disconnect coincident interface nodes, invert a tetrahedron, alter a material, add a short, fill a drill or board cutout, and remove an inner-layer copper segment.

![Two hollow signal barrels through four layers; thickness at 4×](tests/__snapshots__/differential-via-cross-section.png)

The validated AM3352 source-via crop can be reproduced with:

```sh
bun scripts/validate-am3352-dqs.tsx \
  --board am3352.circuit.json --stackup am3352.stackup.json \
  --source-vias --output work/am3352-dqs --mesh-size 0.2 \
  --threads 1 --optimize-netgen
```

It retains every copper net and physical via span within the crop and checks both source pads through their full via stubs. Omitting `--source-vias` requests the complete paths `U1.P1 → U3.F3` and `U1.P2 → U3.G3`; full-route conformal partitioning remains expensive and has not yielded a validated mesh in the recorded runs. Input hashes, crop bounds, timing and validation results are saved. Cropping truncates other traces and reference planes, so this is a mesh-validation case; an EM extraction must separately validate domain size, boundary conditions, ports and frequency/mesh convergence. The general CLI accepts `--bounds minX,minY,maxX,maxY`; library exports accept `boundsMm`. Native CAD/mesh defaults to one thread for repeatable regressions; the library `threads` option enables native parallelism. `progress.json` and `validation-progress.json` identify the current stage of a long export.

The source-via case also emits a native cross-section. Use `--fragment-strategy slab` to partition material interfaces in batches within and between adjacent z slabs. The saved-mesh validator applies the same requirements to either strategy. `--optimize-netgen` enables native tetrahedron optimization. Reported worst-element coordinates and quality percentiles help distinguish a positive-volume mesh from a mesh with problematic slivers. Run large native jobs serially: they share the workspace memory limit. The AM3352 script's `--cad-only` mode saves the assembly without fragmentation or meshing for isolation and independent CAD validity checks.

The AM3352 script widens crop boundaries that would graze circular barrel rims, recording every change in provenance. Such a crop can otherwise leave a 0.12 µm copper sliver and produce poor tetrahedra despite preserving copper connectivity. A TSX regression reproduces and rejects that case at `minSICN > 0.001`, then verifies the expanded crop. Actual-board measurements, cross-sections and resource-failure receipts are in [the DQS validation evidence](examples/am3352/mesh-validation/README.md).

For exceptionally detailed contours, `--simplify-tolerance 0.001` (library `simplifyToleranceMm: 0.001`) enables a **1 µm geometry approximation**. The default is zero. Physical drill and board-cutout interiors remain exact; changes must preserve per-layer polygon component/hole counts and net separation. Every contour records its measured discrete Hausdorff boundary distance, vertex counts, and added/removed copper area. Approximating contours can affect impedance and loss: validate tolerance sensitivity separately before using an EM result. `simplification.json` and the geometry report retain the audit.

`--corridor-margin 0.5` crops the AM3352 analysis domain to a 0.5 mm neighbourhood of the two complete routes, with recorded expansions around intersected via barrels. The library equivalent is `routeCorridor: { netIds: [positiveNetId, negativeNetId], marginMm: 0.5 }`. All copper inside that domain is retained, including other nets. The exported `route-corridor.json` records the actual polygon. Omitting this option uses the rectangular crop. This reduces CAD workload but truncates reference planes; it is not a validated EM domain size.

## Brief library usage

Run with Bun and the same Python setup:

```tsx
import { Circuit } from "@tscircuit/core"
import {
  createGeometryModel, parseCircuitJson, exportGmsh,
} from "circuit-json-to-gmsh"

const circuit = new Circuit()
circuit.add(<MyBoard />)
await circuit.renderUntilSettled()
const model = createGeometryModel({
  circuitJson: parseCircuitJson(circuit.getCircuitJson()),
  stackup, // fabrication stack, as above
})
const { report, brepPath, meshPath } = await exportGmsh({
  model, outputDirectory: "work/board", conformal: true,
})
```

The initial package is not published to npm. Inside this repo use `./lib/index.ts` for the import, or link the package locally.

## Cross-sections and visual snapshots

```ts
import { exportGmsh, crossSection, renderGeometry } from "circuit-json-to-gmsh"

const cut = await exportGmsh({
  model, outputDirectory: "work/cut", cutawayX: 2, conformal: true,
})
const png = await renderGeometry({
  solids: crossSection({ solids: cut.preview, xMm: 2 }),
  zScale: 4,
  render: { camPos: [15, 1.5, 1.8], lookAt: [2, 1.5, 1.8] },
})
await Bun.write("work/section.png", png)
```

The cutaway is made before native CAD extrusion. The flat section keeps only triangulated Gmsh faces on that cut plane. `zScale` affects the preview; exported CAD and mesh keep their physical thicknesses.

![Native four-layer cross-section, thickness at 4×](examples/four-layer/cross-section.png)

Orange/brown is copper; green is dielectric. The white vertical opening is the drill. Etched inner-foil spaces contain resin from the upper adjacent dielectric; outer-foil spaces remain exterior air. Solder mask and component bodies are omitted.

Run `bun start` for the Cosmos visualizer, `bun run build:site` for its static export, and `bun run generate:examples` to regenerate the TSX example.

## AM3352 CAD reproductions

The legacy AM3352 export's ground assembly contained **two invalid OCC solids out of 801**:

| Solid | Cause | Location (mm) |
| --- | --- | --- |
| `foil/top/102` | A hole touches the exterior at a single point | `(7.55, 1.15)` |
| `foil/bottom/2` | Five pairs of hole boundaries touch at single points | See [reproduction evidence](examples/am3352/README.md) |

The bottom-plane contacts were introduced by the legacy exporter's square antipads. The default now offsets the actual pad outlines by the configured radial clearance, preserving the supplied circular voids. `antipadShape: "bounding-box"` (CLI `--antipad-shape bounding-box`) retains the old shape for reproductions or deliberately rectangular antipads.

The top case is `U1.VSS_OSC_V11` → `pcb_trace_105` → `pcb_via_83`. These polygons are valid in GEOS, and their extruded volumes are correct, but OpenCASCADE's `BRepCheck_Analyzer` rejects the solids. Checking volume or mesh generation alone missed this.

The exporter detects these pinches before extrusion. By default it removes a local square notch with half width **0.0001 mm (0.1 µm)**. It verifies that the repair keeps one connected copper region and adds no copper. Every repair, coordinate, bound, removed area and total volume change appears in `report.json`. The top reproduction loses `3.9015e-8 mm²` of copper. Set `repairRadiusMm: 0`, or CLI `--repair-radius 0`, to reject the input and save the isolated polygon in `failure.json`.

Foils and barrel cross-sections are also united in 2D before extrusion into non-overlapping z intervals, avoiding the former union of 801 overlapping ground volumes. Through-via depths and physical foil thicknesses are retained.

Both defect classes have TSX reproductions, native BREP validity checks, conformal mesh checks and PoppyGL snapshots. The full-board default CAD assembly exported **5,572 solids in 288 seconds**, using **11.7 GiB** peak RSS. Only two local pinches remain after using pad-outline antipads: top GND and inner1 `DDR_VREF`. Their total removed volume is `1.96e-9 mm³`; the input hash and measurements are in [the benchmark receipt](examples/am3352/full-board-cad-benchmark.json).

Full-board **CAD assembly** export is benchmarked separately from a solver-ready, conformal full-board mesh. The original Palace Boolean failure is not a completed Palace simulation.

## Development

```sh
.venv/bin/pip install -r lib/python/requirements-test.txt
GMSH_PYTHON="$PWD/.venv/bin/python" bun test
bun run typecheck
bun run format:check
python -m ruff check lib/python
```

Update reviewed visual baselines with `UPDATE_SNAPSHOTS=1 bun test`. Missing snapshots fail normally. CI runs native Gmsh and OpenCASCADE checks; it also builds the Cosmos visualizer.

For an independent CAD check:

```sh
.venv/bin/python lib/python/validate_brep.py --brep work/board/board.brep
```

Tests pin Gmsh 4.13.1, GEOS through Shapely 2.1.2, and OCP 7.8.1.1.post1. Circular input copper and drills use 32-sided polygons; plating is currently 0.025 mm. Generated foreign-net plane antipads offset the copper footprint on each layer (supplied pads where present, barrel outer wall elsewhere) by the configured `viaClearance` or board clearance. Existing pours, all copper nets, physical holes and cutouts are retained; unresolved ownership, absent layers and cross-net overlap are errors.
