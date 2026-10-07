#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { join } from "node:path"
import {
  createGeometryModel,
  exportGmsh,
  parseCircuitJson,
  parseFabricationStackup,
  renderGeometry,
} from "./index"

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
  },
})
if (values.help || !positionals[0] || !values["stackup-file"]) {
  console.log(
    "Usage: bun lib/cli.ts circuit.json --stackup-file stackup.json [--output gmsh-output] [--conformal] [--mesh-size 0.5] [--cutaway-x 2]",
  )
  process.exit(values.help ? 0 : 1)
}
const antipadShape = values["antipad-shape"]
if (antipadShape !== "offset" && antipadShape !== "bounding-box")
  throw new Error("--antipad-shape must be offset or bounding-box")
const model = createGeometryModel({
  circuitJson: parseCircuitJson(await Bun.file(positionals[0]).json()),
  antipadShape,
  stackup: parseFabricationStackup(
    await Bun.file(values["stackup-file"]).json(),
  ),
})
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
})
if (result.preview.length)
  await Bun.write(
    join(values.output, "preview.png"),
    await renderGeometry({ solids: result.preview }),
  )
console.log(JSON.stringify(result.report, null, 2))
