/** Small reproducible TSX control, separate from the actual AM3352 case. */
import { parseArgs } from "node:util"
import { createMeshRequirements, exportGmsh } from "../lib/index"
import { renderDifferentialBoard } from "../tests/fixtures/differential-board"
import { renderBoard } from "../tests/fixtures/render-board"

const { values } = parseArgs({
  options: {
    differential: { type: "boolean", default: false },
    output: { type: "string", default: "work/palace-control" },
    "mesh-size": { type: "string", default: "0.8" },
  },
})
const board = values.differential
  ? await renderDifferentialBoard()
  : await renderBoard()
const requirements = createMeshRequirements({
  ...board,
  connections: [
    { from: "U1.OUT", to: "U2.IN" },
    { from: "U1.GND", to: "U2.GND" },
    ...(values.differential
      ? [
          { from: "U3.OUT", to: "U4.IN" },
          { from: "U1.GND", to: "U3.GND" },
          { from: "U1.GND", to: "U4.GND" },
        ]
      : []),
  ],
})
const referenceNetId = requirements.terminals.find(
  (t) => t.name === "U1.GND",
)!.netId
const result = await exportGmsh({
  model: board.model,
  outputDirectory: values.output,
  conformal: true,
  airPaddingMm: 1,
  meshSizeMm: Number(values["mesh-size"]),
  validationRequirements: requirements,
  lumpedPorts: requirements.terminals
    .filter((t) => t.netId !== referenceNetId)
    .map((terminal) => ({ terminal, referenceNetId, widthMm: 0.08 })),
})
console.log(
  JSON.stringify(
    { report: result.report, validation: result.validation },
    null,
    2,
  ),
)
