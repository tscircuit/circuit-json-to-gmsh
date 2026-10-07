import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { crossSection, exportGmsh, renderGeometry } from "lib/index"
import { renderBoard } from "./fixtures/render-board"
import { expectPngSnapshot } from "./fixtures/png-snapshot"

test("TSX board exports a conformal four-layer mesh with physical via spans", async () => {
  const { model } = await renderBoard()
  expect(model.multilayer.stackup.copperLayers.map((l) => l.name)).toEqual([
    "top",
    "inner1",
    "inner2",
    "bottom",
  ])
  const outputDirectory = await mkdtemp(join(tmpdir(), "gmsh-four-layer-"))
  const result = await exportGmsh({
    model,
    outputDirectory,
    conformal: true,
    meshSizeMm: 0.8,
  })
  expect(result.report.tetrahedra).toBeGreaterThan(0)
  expect(result.report.sharedInterfaceFaces).toBeGreaterThan(0)
  expect(result.report.minimumTetQuality).toBeGreaterThan(0)
  expect(result.report.actualVolumeMm3).toBeCloseTo(
    result.report.expectedVolumeMm3,
    7,
  )
  expect(
    result.report.materials.filter((m) => m.name.startsWith("dielectric:")),
  ).toHaveLength(3)
  const copper = result.preview.filter((s) => s.material === "copper")
  expect(copper.some((s) => s.layer === "inner1")).toBe(true)
  const png = await renderGeometry({
    solids: result.preview,
    copperOnly: true,
    zScale: 3,
    render: {
      camPos: [11, -12, 9],
      lookAt: [0, 0, 1],
      width: 640,
      height: 480,
    },
  })
  await expectPngSnapshot({
    png,
    path: join(import.meta.dir, "__snapshots__/four-layer-copper.png"),
  })
}, 120_000)

test("native CAD cutaway exposes plated barrel and dielectric interfaces", async () => {
  const { model } = await renderBoard()
  const result = await exportGmsh({
    model,
    outputDirectory: await mkdtemp(join(tmpdir(), "gmsh-cutaway-")),
    cutawayX: 2,
    meshSizeMm: 0.8,
    conformal: true,
  })
  expect(result.report.actualVolumeMm3).toBeCloseTo(
    result.report.expectedVolumeMm3,
    7,
  )
  for (const solid of result.preview)
    for (let i = 0; i < solid.positions.length; i += 3)
      expect(solid.positions[i]).toBeLessThanOrEqual(2 + 1e-6)
  const png = await renderGeometry({
    solids: result.preview,
    zScale: 4,
    render: {
      camPos: [15, -8, 9],
      lookAt: [0, 0, 1.8],
      width: 640,
      height: 480,
    },
  })
  await expectPngSnapshot({
    png,
    path: join(import.meta.dir, "__snapshots__/four-layer-cutaway.png"),
  })
  const sectionSolids = crossSection({ solids: result.preview, xMm: 2 })
  expect(
    sectionSolids.every((s) =>
      s.positions
        .filter((_, i) => i % 3 === 0)
        .every((x) => Math.abs(x - 2) < 1e-6),
    ),
  ).toBe(true)
  const section = await renderGeometry({
    solids: sectionSolids,
    zScale: 4,
    render: {
      camPos: [15, 1.5, 1.8],
      lookAt: [2, 1.5, 1.8],
      width: 640,
      height: 480,
      fov: 30,
    },
  })
  await expectPngSnapshot({
    png: section,
    path: join(import.meta.dir, "__snapshots__/via-cross-section.png"),
  })
}, 120_000)
