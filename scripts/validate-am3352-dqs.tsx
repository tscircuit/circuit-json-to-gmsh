import { parseArgs } from "node:util"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { gunzipSync } from "node:zlib"
import {
  createGeometryModel,
  createMeshRequirements,
  exportGmsh,
  parseCircuitJson,
  parseFabricationStackup,
  renderGeometry,
  crossSection,
} from "../lib/index"
import { avoidGrazingBarrels } from "./avoid-grazing-barrels"

const { values } = parseArgs({
  options: {
    board: { type: "string" },
    stackup: { type: "string" },
    output: { type: "string", default: "work/am3352-dqs" },
    "mesh-size": { type: "string", default: "0.6" },
    margin: { type: "string", default: "2" },
    threads: { type: "string", default: "1" },
    "source-vias": { type: "boolean", default: false },
    "cad-only": { type: "boolean", default: false },
    "optimize-netgen": { type: "boolean", default: false },
    "fragment-strategy": { type: "string", default: "global" },
    "simplify-tolerance": { type: "string", default: "0" },
    "corridor-margin": { type: "string" },
  },
})
if (!values.board || !values.stackup)
  throw new Error("Supply --board circuit.json --stackup stackup.json")
if (
  values["fragment-strategy"] !== "global" &&
  values["fragment-strategy"] !== "slab"
)
  throw new Error("fragment-strategy must be global or slab")
const boardText = values.board.endsWith(".gz")
  ? gunzipSync(await Bun.file(values.board).arrayBuffer()).toString("utf8")
  : await Bun.file(values.board).text()
const stackupText = await Bun.file(values.stackup).text()
const circuitJson = parseCircuitJson(JSON.parse(boardText))
const model = createGeometryModel({
  circuitJson,
  stackup: parseFabricationStackup(JSON.parse(stackupText)),
})
const sourceTraces = circuitJson.filter(
  (e) =>
    e.type === "source_trace" &&
    ["DDR_DQS0", "DDR_DQSn0"].includes(e.name ?? ""),
)
const ids = sourceTraces.flatMap((e) =>
  e.type === "source_trace" ? [e.source_trace_id] : [],
)
const routes = circuitJson.filter(
  (e) => e.type === "pcb_trace" && ids.includes(e.source_trace_id ?? ""),
)
if (routes.length !== 2 || routes.some((e) => e.type !== "pcb_trace"))
  throw new Error("Expected both routed DQS0 signals")
const coordinates = routes
  .flatMap((e) => (e.type === "pcb_trace" ? e.route : []))
  .filter((p) => p.route_type === "wire" || p.route_type === "via")
const margin = Number(values.margin)
if (!Number.isFinite(margin) || margin <= 0)
  throw new Error("margin must be positive")
let boundsMm: [number, number, number, number] = [
  Math.min(...coordinates.map((p) => p.x)) - margin,
  Math.min(...coordinates.map((p) => p.y)) - margin,
  Math.max(...coordinates.map((p) => p.x)) + margin,
  Math.max(...coordinates.map((p) => p.y)) + margin,
]
let requirements = createMeshRequirements({
  circuitJson,
  model,
  connections: [
    { from: "U1.P1", to: "U3.F3" },
    { from: "U1.P2", to: "U3.G3" },
  ],
})
const sourceVias = routes.flatMap((r) =>
  r.type === "pcb_trace"
    ? r.route.filter((p) => p.route_type === "via").slice(0, 1)
    : [],
)
if (values["source-vias"]) {
  if (sourceVias.length !== 2)
    throw new Error("Expected one source transition per DQS route")
  boundsMm = [
    Math.min(...sourceVias.map((p) => p.x)) - 1,
    Math.min(...sourceVias.map((p) => p.y)) - 1,
    Math.max(...sourceVias.map((p) => p.x)) + 1,
    Math.max(...sourceVias.map((p) => p.y)) + 1,
  ]
  requirements = {
    terminals: requirements.terminals.filter((p) => p.name.startsWith("U1.")),
    connections: [],
  }
  for (const [index, via] of sourceVias.entries()) {
    const terminal = requirements.terminals[index]
    const name = `${terminal.name}.bottomStub`
    requirements.terminals.push({
      name,
      netId: terminal.netId,
      positionMm: [via.x + 0.0875, via.y, -0.0175],
    })
    requirements.connections.push({ from: terminal.name, to: name })
  }
}
const requestedBoundsMm = [...boundsMm]
const expanded = avoidGrazingBarrels({ model, boundsMm })
boundsMm = expanded.boundsMm
await mkdir(values.output, { recursive: true })
const started = performance.now()
await Bun.write(
  join(values.output, "provenance.json"),
  JSON.stringify(
    {
      boardUrl: "https://tscircuit.com/astra/am3352-sbc#files",
      inputSha256: createHash("sha256").update(boardText).digest("hex"),
      stackupSha256: createHash("sha256").update(stackupText).digest("hex"),
      boundsMm,
      requestedBoundsMm,
      cropAdjustments: expanded.adjustments,
      marginMm: margin,
      meshSizeMm: Number(values["mesh-size"]),
      scope: values["source-vias"] ? "source_vias" : "full_route",
      mode: values["cad-only"] ? "cad_assembly" : "conformal_mesh",
      threads: Number(values.threads),
      optimizeNetgen: values["optimize-netgen"],
      fragmentStrategy: values["fragment-strategy"],
      simplifyToleranceMm: Number(values["simplify-tolerance"]),
      corridorMarginMm:
        values["corridor-margin"] === undefined
          ? undefined
          : Number(values["corridor-margin"]),
      requirements,
      limitations: [
        "All copper nets and physical via spans are retained inside the crop.",
        "Crop boundaries truncate planes and other routes. They are not validated EM boundaries.",
        "Terminal probes validate copper contact/connectivity, not Palace lumped-port apertures.",
      ],
    },
    null,
    2,
  ),
)
const result = await exportGmsh({
  model,
  boundsMm,
  outputDirectory: values.output,
  conformal: !values["cad-only"],
  cadOnly: values["cad-only"],
  meshSizeMm: Number(values["mesh-size"]),
  validationRequirements: requirements,
  threads: Number(values.threads),
  optimizeNetgen: values["optimize-netgen"],
  fragmentStrategy: values["fragment-strategy"],
  simplifyToleranceMm: Number(values["simplify-tolerance"]),
  routeCorridor:
    values["corridor-margin"] === undefined
      ? undefined
      : {
          netIds: [...new Set(requirements.terminals.map((p) => p.netId))],
          marginMm: Number(values["corridor-margin"]),
        },
})
await Bun.write(
  join(values.output, "benchmark.json"),
  JSON.stringify(
    {
      exportAndValidationSeconds: (performance.now() - started) / 1000,
      report: result.report,
      validation: result.validation,
    },
    null,
    2,
  ),
)
if (values["cad-only"]) {
  console.log(
    JSON.stringify({ output: values.output, report: result.report }, null, 2),
  )
  process.exit(0)
}
for (const layer of ["top", "inner1", "inner2", "bottom"]) {
  const solids = result.preview.filter(
    (s) => s.material === "copper" && s.layer === layer,
  )
  await Bun.write(
    join(values.output, `${layer}.png`),
    await renderGeometry({
      solids,
      render: {
        camPos: [
          (boundsMm[0] + boundsMm[2]) / 2,
          (boundsMm[1] + boundsMm[3]) / 2,
          Math.max(boundsMm[2] - boundsMm[0], boundsMm[3] - boundsMm[1]) * 1.5 +
            2,
        ],
        lookAt: [
          (boundsMm[0] + boundsMm[2]) / 2,
          (boundsMm[1] + boundsMm[3]) / 2,
          1,
        ],
        up: "y+",
        width: 900,
        height: 1100,
      },
    }),
  )
}
if (values["source-vias"]) {
  const xMm = sourceVias[0].x
  const cut = await exportGmsh({
    model,
    boundsMm,
    cutawayX: xMm,
    outputDirectory: join(values.output, "section"),
    conformal: true,
    meshSizeMm: Number(values["mesh-size"]),
    threads: Number(values.threads),
  })
  const yMm = (boundsMm[1] + boundsMm[3]) / 2
  await Bun.write(
    join(values.output, "cross-section.png"),
    await renderGeometry({
      solids: crossSection({ solids: cut.preview, xMm }),
      zScale: 3,
      render: {
        camPos: [xMm + 11, yMm, 2.3],
        lookAt: [xMm, yMm, 2.3],
        fov: 30,
        width: 900,
        height: 800,
      },
    }),
  )
}
console.log(
  JSON.stringify(
    {
      output: values.output,
      report: result.report,
      validation: result.validation,
    },
    null,
    2,
  ),
)
