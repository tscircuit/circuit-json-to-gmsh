import { expect, test } from "bun:test"
import { Circuit } from "@tscircuit/core"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGeometryModel, exportGmsh, parseCircuitJson } from "lib/index"
import { fourLayerStackup } from "./fixtures/multilayer-board"
import { expectValidBrep } from "./fixtures/expect-valid-brep"

test("a TSX inner foil crop leaves a sub-kernel resin wedge with a bounded single-net repair", async () => {
  const circuit = new Circuit()
  circuit.add(
    <board width={2} height={2} layers={4} schematicDisabled>
      <net name="GND" />
      <copperpour
        layer="inner2"
        connectsTo="net.GND"
        boardEdgeMargin={0}
        outline={[
          { x: -0.9998, y: -1 },
          { x: 1, y: -1 },
          { x: 1, y: 1 },
          { x: -1, y: 1 },
          { x: -1, y: -0.999999 },
        ]}
      />
    </board>,
  )
  await circuit.renderUntilSettled()
  const model = createGeometryModel({
    circuitJson: parseCircuitJson(circuit.getCircuitJson()),
    stackup: fourLayerStackup,
  })
  const result = await exportGmsh({
    model,
    outputDirectory: await mkdtemp(join(tmpdir(), "gmsh-resin-sliver-")),
    boundsMm: [-1, -1, 1, 1],
    conformal: true,
    meshSizeMm: 0.5,
  })
  expect(result.report.sliverRepairs).toHaveLength(1)
  const repair = result.report.sliverRepairs![0]
  expect(repair.areaMm2).toBeCloseTo(1e-10, 16)
  expect(repair.volumeMm3).toBeCloseTo(1.5e-12, 18)
  expect(repair.areaMm2).toBeLessThanOrEqual(repair.maximumAreaMm2)
  expect(result.validation?.passed).toBe(true)
  expect(result.validation?.checks.every((c) => c.passed !== false)).toBe(true)
  // Empty outer foil layers are exterior space in a mesh without an enclosure.
  expect(result.report.actualVolumeMm3).toBeCloseTo(4 * (0.975 - 0.07), 7)
  await expectValidBrep(result.brepPath)
}, 120_000)
