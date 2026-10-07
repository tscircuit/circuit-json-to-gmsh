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
import { TouchingAntipadsBoard } from "./fixtures/touching-antipads-board"
import { pinchedHoleStackup } from "./fixtures/pinched-hole-board"
import { expectPngSnapshot } from "./fixtures/png-snapshot"
import { expectValidBrep } from "./fixtures/expect-valid-brep"
import { renderRepairDetail } from "./fixtures/render-repair-detail"

test("diagonal antipads produce a reported, local repair without merging nets", async () => {
  const circuit = new Circuit()
  circuit.add(<TouchingAntipadsBoard />)
  await circuit.renderUntilSettled()
  const model = createGeometryModel({
    circuitJson: parseCircuitJson(circuit.getCircuitJson()),
    stackup: pinchedHoleStackup,
    viaClearance: 0.1,
    antipadShape: "bounding-box",
  })
  const strict = await mkdtemp(join(tmpdir(), "gmsh-antipads-strict-"))
  await expect(
    exportGmsh({ model, outputDirectory: strict, repairRadiusMm: 0 }),
  ).rejects.toThrow("hole touches")
  const failure = JSON.parse(
    await readFile(join(strict, "failure.json"), "utf8"),
  )
  expect(failure.contactsMm).toEqual([[0.25, 0.25]])
  const fixed = await exportGmsh({
    model,
    outputDirectory: await mkdtemp(join(tmpdir(), "gmsh-antipads-fixed-")),
    meshSizeMm: 0.4,
    conformal: true,
  })
  expect(fixed.report.repairs).toHaveLength(1)
  expect(fixed.report.repairs[0].removedAreaMm2).toBeLessThan(4e-8)
  expect(
    fixed.report.materials.filter((m) => m.name.startsWith("copper:")),
  ).toHaveLength(3)
  expect(fixed.report.minimumTetQuality).toBeGreaterThan(0)
  await expectValidBrep(fixed.brepPath)
  const png = await renderGeometry({
    solids: fixed.preview.filter((s) => s.layer === "bottom"),
    copperOnly: true,
    render: {
      camPos: [0.25, 0.25, 4],
      lookAt: [0.25, 0.25, 0],
      up: "y+",
      width: 640,
      height: 480,
      debugPoints: [
        {
          label: "antipad contact (0.25, 0.25)",
          position: { x: 0.25, y: 0.25, z: 0 },
        },
      ],
    },
  })
  await expectPngSnapshot({
    png,
    path: join(import.meta.dir, "__snapshots__/touching-antipads-fixed.png"),
  })
  const detail = await renderRepairDetail({
    solids: fixed.preview.filter((s) => s.layer === "bottom"),
    xMm: 0.25,
    yMm: 0.25,
    zMm: 0,
  })
  await expectPngSnapshot({
    png: detail,
    path: join(import.meta.dir, "__snapshots__/touching-antipads-detail.png"),
  })
  const offsetModel = createGeometryModel({
    circuitJson: parseCircuitJson(circuit.getCircuitJson()),
    stackup: pinchedHoleStackup,
    viaClearance: 0.1,
  })
  const offset = await exportGmsh({
    model: offsetModel,
    outputDirectory: await mkdtemp(join(tmpdir(), "gmsh-antipads-offset-")),
    meshSizeMm: 0.4,
    conformal: true,
    repairRadiusMm: 0,
  })
  expect(offset.report.repairs).toHaveLength(0)
  expect(offset.report.expectedVolumeMm3).toBeGreaterThan(
    fixed.report.expectedVolumeMm3,
  )
  await expectValidBrep(offset.brepPath)
  const offsetPng = await renderGeometry({
    solids: offset.preview.filter((s) => s.layer === "bottom"),
    copperOnly: true,
    render: {
      camPos: [0.25, 0.25, 4],
      lookAt: [0.25, 0.25, 0],
      up: "y+",
      width: 640,
      height: 480,
    },
  })
  await expectPngSnapshot({
    png: offsetPng,
    path: join(import.meta.dir, "__snapshots__/offset-antipads.png"),
  })
}, 120_000)
