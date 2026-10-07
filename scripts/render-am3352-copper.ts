import { parseArgs } from "node:util"
import { mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { renderGeometry, type PreviewSolid } from "../lib/index"

const { values } = parseArgs({
  options: {
    preview: { type: "string" },
    "section-preview": { type: "string" },
    output: { type: "string", default: "work/am3352-copper" },
  },
})
if (!values.preview)
  throw new Error(
    "Supply --preview path/to/preview.json from the actual AM3352 source-via export",
  )
const previewBytes = await Bun.file(values.preview).bytes()
const provenance: { inputSha256: string; boundsMm: number[]; scope: string } =
  await Bun.file(
    join(dirname(resolve(values.preview)), "provenance.json"),
  ).json()
if (
  provenance.inputSha256 !==
    "c9d7059fe536865784f175855e0dcc76510972319eec848c18b0ef6dcd2adb40" ||
  provenance.scope !== "source_vias"
)
  throw new Error(
    "Expected the pinned actual AM3352 source-via crop and its provenance.json",
  )
const solids: PreviewSolid[] = JSON.parse(
  new TextDecoder().decode(previewBytes),
)
const copper = solids.filter((solid) => solid.material === "copper")
if (!copper.length) throw new Error("No copper in the supplied native preview")
await mkdir(values.output, { recursive: true })
const netColors: Record<string, [number, number, number, number]> = {
  source_trace_15: [0.95, 0.12, 0.08, 1],
  source_trace_16: [0.02, 0.68, 0.9, 1],
}
const render = {
  width: 1400,
  height: 1100,
  camPos: [11, -17, 10] as [number, number, number],
  lookAt: [3.225, -7, 2.25] as [number, number, number],
  fov: 30,
}
await Bun.write(
  join(values.output, "copper-only.png"),
  await renderGeometry({ solids: copper, zScale: 3, netColors, render }),
)
await Bun.write(
  join(values.output, "dqs-copper-only.png"),
  await renderGeometry({
    solids: copper.filter(
      (solid) =>
        solid.netId === "source_trace_15" || solid.netId === "source_trace_16",
    ),
    zScale: 3,
    netColors,
    render,
  }),
)
if (values["section-preview"]) {
  const cut: PreviewSolid[] = await Bun.file(values["section-preview"]).json()
  await Bun.write(
    join(values.output, "copper-cutaway.png"),
    await renderGeometry({
      solids: cut,
      copperOnly: true,
      zScale: 3,
      netColors,
      render: { ...render, camPos: [10, -17, 10], lookAt: [2.1, -7, 2.25] },
    }),
  )
}
await Bun.write(
  join(values.output, "copper-render.json"),
  JSON.stringify(
    {
      source: "Actual AM3352 source-via native Gmsh preview; not a TSX example",
      previewSha256: createHash("sha256").update(previewBytes).digest("hex"),
      boardInputSha256: provenance.inputSha256,
      cropBoundsMm: provenance.boundsMm,
      renderer: "PoppyGL",
      substrateVisible: false,
      displayZScale: 3,
      copperSolids: copper.length,
      colors: {
        red: "DDR_DQS0 (source_trace_15)",
        cyan: "DDR_DQSn0 (source_trace_16)",
        other: "Other copper, colored by layer",
      },
      render,
    },
    null,
    2,
  ),
)
console.log(
  JSON.stringify({ output: values.output, copperSolids: copper.length }),
)
