#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { join } from "node:path"
import {
  createMeshRequirements,
  createGeometryModel,
  exportGmsh,
  parseCircuitJson,
  parseFabricationStackup,
  renderGeometry,
} from "./index"
import { validateMeshCli } from "./validate-mesh-cli"

if (process.argv[2] === "validate")
  process.exit(await validateMeshCli(process.argv.slice(3)))

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    "stackup-file": { type: "string" },
    output: { type: "string", default: "gmsh-output" },
    "mesh-size": { type: "string", default: "0.5" },
    conformal: { type: "boolean", default: false },
    "cutaway-x": { type: "string" },
    "repair-radius": { type: "string", default: "0.0001" },
    "antipad-shape": { type: "string", default: "offset" },
    "cad-only": { type: "boolean", default: false },
    step: { type: "boolean", default: false },
    help: { type: "boolean" },
    connection: { type: "string", multiple: true },
    "minimum-tet-quality": { type: "string", default: "0" },
    bounds: { type: "string" },
    threads: { type: "string", default: "1" },
    "optimize-netgen": { type: "boolean", default: false },
    "fragment-strategy": { type: "string", default: "global" },
    "simplify-tolerance": { type: "string", default: "0" },
  },
})
if (values.help || !positionals[0] || !values["stackup-file"]) {
  console.log(
    "Usage: circuit-json-to-gmsh circuit.json --stackup-file stackup.json [--output gmsh-output] [--conformal] [--mesh-size 0.5] [--connection U1.P1:U3.F3] [--minimum-tet-quality 0]\nRecheck: circuit-json-to-gmsh validate board.msh --help",
  )
  process.exit(values.help ? 0 : 1)
}
const antipadShape = values["antipad-shape"]
if (antipadShape !== "offset" && antipadShape !== "bounding-box")
  throw new Error("--antipad-shape must be offset or bounding-box")
const fragmentStrategy = values["fragment-strategy"]
if (fragmentStrategy !== "global" && fragmentStrategy !== "slab")
  throw new Error("--fragment-strategy must be global or slab")
const circuitJson = parseCircuitJson(await Bun.file(positionals[0]).json())
const model = createGeometryModel({
  circuitJson,
  antipadShape,
  stackup: parseFabricationStackup(
    await Bun.file(values["stackup-file"]).json(),
  ),
})
const connections = (values.connection ?? []).map((connection) => {
  const terminals = connection.split(":")
  if (terminals.length !== 2 || terminals.some((t) => !t))
    throw new Error(
      "--connection expects refdes.pin:refdes.pin, e.g. U1.OUT:U2.IN",
    )
  return { from: terminals[0], to: terminals[1] }
})
if (connections.length && !values.conformal)
  throw new Error("--connection requires --conformal")
const bounds = values.bounds?.split(",").map(Number)
if (bounds && bounds.length !== 4)
  throw new Error("--bounds expects minX,minY,maxX,maxY")
const result = await exportGmsh({
  model,
  outputDirectory: values.output,
  meshSizeMm: Number(values["mesh-size"]),
  conformal: values.conformal,
  cadOnly: values["cad-only"],
  step: values.step,
  repairRadiusMm: Number(values["repair-radius"]),
  cutawayX:
    values["cutaway-x"] === undefined ? undefined : Number(values["cutaway-x"]),
  validationRequirements: connections.length
    ? createMeshRequirements({ circuitJson, model, connections })
    : undefined,
  minimumTetQuality: Number(values["minimum-tet-quality"]),
  boundsMm: bounds ? [bounds[0], bounds[1], bounds[2], bounds[3]] : undefined,
  threads: Number(values.threads),
  optimizeNetgen: values["optimize-netgen"],
  fragmentStrategy,
  simplifyToleranceMm: Number(values["simplify-tolerance"]),
})
if (result.preview.length)
  await Bun.write(
    join(values.output, "preview.png"),
    await renderGeometry({ solids: result.preview }),
  )
console.log(
  JSON.stringify(
    {
      ...result.report,
      meshValidation: result.validation
        ? {
            passed: result.validation.passed,
            pcbChecksComplete: result.validation.pcbChecksComplete,
            reportPath: join(values.output, "validation.json"),
          }
        : undefined,
    },
    null,
    2,
  ),
)
