import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { crossSection, exportGmsh, renderGeometry } from "lib/index"
import { renderBoard } from "tests/fixtures/render-board"
import { fourLayerStackup } from "tests/fixtures/multilayer-board"

const directory = join(import.meta.dir, "../examples/four-layer")
await mkdir(directory, { recursive: true })
const { circuitJson, model } = await renderBoard()
await Bun.write(
  join(directory, "circuit.json"),
  JSON.stringify(circuitJson, null, 2),
)
await Bun.write(
  join(directory, "stackup.json"),
  JSON.stringify(fourLayerStackup, null, 2),
)
const full = await exportGmsh({
  model,
  outputDirectory: "work/four-layer",
  conformal: true,
  meshSizeMm: 0.8,
})
await Bun.write(
  join(directory, "report.json"),
  JSON.stringify(full.report, null, 2),
)
await Bun.write(
  join(directory, "copper.png"),
  await renderGeometry({
    solids: full.preview,
    copperOnly: true,
    zScale: 3,
    render: { camPos: [11, -12, 9], lookAt: [0, 0, 1] },
  }),
)
const cut = await exportGmsh({
  model,
  outputDirectory: "work/cutaway",
  cutawayX: 2,
  conformal: true,
  meshSizeMm: 0.8,
})
await Bun.write(
  join(directory, "cutaway.png"),
  await renderGeometry({
    solids: cut.preview,
    zScale: 4,
    render: { camPos: [15, -8, 9], lookAt: [0, 0, 1.8] },
  }),
)
await Bun.write(
  join(directory, "cross-section.png"),
  await renderGeometry({
    solids: crossSection({ solids: cut.preview, xMm: 2 }),
    zScale: 4,
    render: { camPos: [15, 1.5, 1.8], lookAt: [2, 1.5, 1.8], fov: 30 },
  }),
)
