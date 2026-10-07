import { expect, test } from "bun:test"
import { Circuit } from "@tscircuit/core"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createGeometryModel,
  exportGmsh,
  parseCircuitJson,
  renderGeometry,
} from "lib/index"
import {
  PinchedHoleBoard,
  pinchedHoleStackup,
} from "./fixtures/pinched-hole-board"
import { expectPngSnapshot } from "./fixtures/png-snapshot"
import { expectValidBrep } from "./fixtures/expect-valid-brep"
import { renderRepairDetail } from "./fixtures/render-repair-detail"

export async function pinchedHoleModel() {
  const circuit = new Circuit()
  circuit.add(<PinchedHoleBoard />)
  await circuit.renderUntilSettled()
  return createGeometryModel({
    circuitJson: parseCircuitJson(circuit.getCircuitJson()),
    stackup: pinchedHoleStackup,
  })
}

test("TSX reproduction identifies the exact pinched hole and bounds its repair", async () => {
  const model = await pinchedHoleModel()
  const strictDirectory = await mkdtemp(join(tmpdir(), "gmsh-pinched-strict-"))
  await expect(
    exportGmsh({ model, outputDirectory: strictDirectory, repairRadiusMm: 0 }),
  ).rejects.toThrow("hole touches")
  const failure = JSON.parse(
    await readFile(join(strictDirectory, "failure.json"), "utf8"),
  )
  expect(failure.contactsMm).toEqual([[7.55, 1.15]])
  const result = await exportGmsh({
    model,
    outputDirectory: await mkdtemp(join(tmpdir(), "gmsh-pinched-fixed-")),
    conformal: true,
    meshSizeMm: 0.3,
  })
  expect(result.report.repairs).toHaveLength(1)
  expect(result.report.repairs[0].contactsMm).toEqual([[7.55, 1.15]])
  expect(result.report.repairs[0].notchHalfWidthMm).toBe(0.0001)
  expect(result.report.repairs[0].cadVoidVerified).toBe(true)
  expect(result.report.repairs[0].removedAreaMm2).toBeGreaterThan(0)
  expect(result.report.repairs[0].removedAreaMm2).toBeLessThan(4e-8)
  expect(result.report.removedVolumeMm3).toBeLessThan(1.5e-9)
  expect(result.report.actualVolumeMm3).toBeCloseTo(
    result.report.expectedVolumeMm3,
    8,
  )
  expect(result.report.minimumTetQuality).toBeGreaterThan(0)
  await expectValidBrep(result.brepPath)
  const png = await renderGeometry({
    solids: result.preview,
    copperOnly: true,
    zScale: 3,
    render: {
      camPos: [7.3, 1.1, 4],
      lookAt: [7.3, 1.1, 2.4],
      up: "y+",
      width: 640,
      height: 480,
      debugPoints: [
        {
          label: "repaired point (7.55, 1.15)",
          position: { x: 7.55, y: 1.15, z: 2.505 },
        },
      ],
    },
  })
  await expectPngSnapshot({
    png,
    path: join(import.meta.dir, "__snapshots__/pinched-hole-fixed.png"),
  })
  const detail = await renderRepairDetail({
    solids: result.preview.filter((s) => s.layer === "top"),
    xMm: 7.55,
    yMm: 1.15,
    zMm: 0.835,
  })
  await expectPngSnapshot({
    png: detail,
    path: join(import.meta.dir, "__snapshots__/pinched-hole-detail.png"),
  })
}, 120_000)
