import { beforeAll, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createMeshRequirements,
  exportGmsh,
  validateMesh,
  renderGeometry,
  type GeometryModel,
  type GmshResult,
  type MeshValidationRequirements,
} from "lib/index"
import { renderBoard } from "./fixtures/render-board"
import { avoidGrazingBarrels } from "../scripts/avoid-grazing-barrels"
import { expectPngSnapshot } from "./fixtures/png-snapshot"

let model: GeometryModel
let result: GmshResult
let requirements: MeshValidationRequirements
let directory: string
beforeAll(async () => {
  const board = await renderBoard()
  model = board.model
  requirements = createMeshRequirements({
    ...board,
    connections: [
      { from: "U1.OUT", to: "U2.IN" },
      { from: "U1.GND", to: "U2.GND" },
    ],
  })
  directory = await mkdtemp(join(tmpdir(), "gmsh-validation-"))
  result = await exportGmsh({
    model,
    outputDirectory: directory,
    conformal: true,
    meshSizeMm: 0.8,
    validationRequirements: requirements,
  })
}, 120_000)

test("independently reloaded TSX mesh validates materials, interfaces, voids and physical endpoint paths", () => {
  expect(result.validation?.passed).toBe(true)
  expect(result.validation?.pcbChecksComplete).toBe(true)
  expect(result.validation?.checks).toHaveLength(9)
  expect(result.validation?.checks.every((c) => c.passed === true)).toBe(true)
  expect(result.validation?.connections?.every((c) => c.passed)).toBe(true)
  expect(result.validation?.quality?.minimum).toBeGreaterThan(0)
  expect(result.validation?.meshSha256).toHaveLength(64)
})

test("reloading without PCB context explicitly leaves CAD, void and terminal checks incomplete", async () => {
  const validation = await validateMesh({
    meshPath: result.meshPath!,
    outputDirectory: join(directory, "mesh-only"),
  })
  expect(validation.passed).toBe(true)
  expect(validation.pcbChecksComplete).toBe(false)
  for (const name of [
    "cad_volume_coverage",
    "drill_and_cutout_voids",
    "terminal_connectivity",
  ])
    expect(validation.checks.find((c) => c.name === name)?.passed).toBe(null)
}, 120_000)

test("a TSX board cutout stays empty through the stack; a saved tetrahedron filling it is rejected", async () => {
  const board = await renderBoard({ cutout: true })
  expect(board.model.multilayer.boardCutouts).toHaveLength(1)
  const contacts = createMeshRequirements({
    ...board,
    connections: [{ from: "U1.OUT", to: "U2.IN" }],
  })
  const cutout = await exportGmsh({
    model: board.model,
    conformal: true,
    meshSizeMm: 0.6,
    outputDirectory: join(directory, "cutout"),
    validationRequirements: contacts,
  })
  expect(cutout.validation?.checks.every((c) => c.passed === true)).toBe(true)
  await expectPngSnapshot({
    png: await renderGeometry({
      solids: cutout.preview,
      zScale: 4,
      render: {
        width: 700,
        height: 550,
        camPos: [9, -11, 9],
        lookAt: [0, 0, 1.5],
      },
    }),
    path: join(import.meta.dir, "__snapshots__/mesh-board-cutout.png"),
  })
  const meshPath = join(directory, "filled-cutout.msh")
  const process = Bun.spawn(
    [
      globalThis.process.env.GMSH_PYTHON ?? "python3",
      join(import.meta.dir, "fixtures/damage-mesh.py"),
      "--mesh",
      cutout.meshPath!,
      "--manifest",
      cutout.manifestPath!,
      "--mode",
      "filled_cutout",
      "--output",
      meshPath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [code, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ])
  if (code) throw new Error(stderr)
  const validation = await validateMesh({
    meshPath,
    manifestPath: cutout.manifestPath,
    model: board.model,
    requirements: contacts,
    outputDirectory: join(directory, "filled-cutout"),
  })
  const check = validation.checks.find(
    (c) => c.name === "drill_and_cutout_voids",
  )!
  expect(validation.passed).toBe(false)
  expect(check.passed).toBe(false)
  expect(JSON.stringify(check.errors)).toContain("cutout/0")
}, 120_000)

test("a bounded mesh retains requested copper paths and material interfaces", async () => {
  const bounded = await exportGmsh({
    model,
    boundsMm: [-3, -2, 3, 2],
    optimizeNetgen: true,
    conformal: true,
    meshSizeMm: 0.6,
    outputDirectory: join(directory, "bounded"),
    validationRequirements: requirements,
  })
  expect(bounded.validation?.passed).toBe(true)
  expect(bounded.report.actualVolumeMm3).toBeLessThan(
    result.report.actualVolumeMm3,
  )
  expect(bounded.validation?.copperComponents).toEqual(
    result.validation?.copperComponents,
  )
  expect(bounded.validation?.connections?.every((c) => c.passed)).toBe(true)
}, 120_000)

test("slab partitioning preserves global-partition material volume, interfaces and copper paths", async () => {
  const slab = await exportGmsh({
    model,
    conformal: true,
    meshSizeMm: 0.8,
    outputDirectory: join(directory, "slab"),
    validationRequirements: requirements,
    fragmentStrategy: "slab",
  })
  expect(slab.validation?.checks.every((c) => c.passed === true)).toBe(true)
  expect(slab.report.actualVolumeMm3).toBeCloseTo(
    result.report.actualVolumeMm3,
    8,
  )
  expect(slab.report.materials.map((m) => m.name)).toEqual(
    result.report.materials.map((m) => m.name),
  )
  expect(slab.validation?.copperComponents).toEqual(
    result.validation?.copperComponents,
  )
  expect(slab.validation?.connections?.every((c) => c.passed)).toBe(true)
}, 120_000)

test("bounded contour simplification preserves physical drills, net separation and requested paths", async () => {
  const simplified = await exportGmsh({
    model,
    conformal: true,
    meshSizeMm: 0.6,
    simplifyToleranceMm: 0.001,
    fragmentStrategy: "slab",
    outputDirectory: join(directory, "simplified"),
    validationRequirements: requirements,
  })
  expect(simplified.validation?.checks.every((c) => c.passed === true)).toBe(
    true,
  )
  expect(simplified.validation?.copperComponents).toEqual(
    result.validation?.copperComponents,
  )
  const receipts = simplified.report.simplification!
  expect(receipts.length).toBeGreaterThan(0)
  expect(receipts.every((r) => r.boundaryDisplacementMm <= 0.001002)).toBe(true)
  expect(receipts.reduce((n, r) => n + r.verticesAfter, 0)).toBeLessThanOrEqual(
    receipts.reduce((n, r) => n + r.verticesBefore, 0),
  )
  // The AM3352 failure came from simplifying an already-clipped boundary.
  // Physical-contour receipts must be identical before an artificial crop;
  // saved-mesh checks also verify its interfaces, drills and terminal paths.
  const cropped = await exportGmsh({
    model,
    conformal: true,
    meshSizeMm: 0.6,
    simplifyToleranceMm: 0.001,
    boundsMm: [-3, -2, 3, 2],
    fragmentStrategy: "slab",
    outputDirectory: join(directory, "simplified-crop"),
    validationRequirements: requirements,
  })
  expect(cropped.report.simplification).toEqual(receipts)
  expect(cropped.validation?.pcbChecksComplete).toBe(true)
  expect(cropped.validation?.checks.every((c) => c.passed === true)).toBe(true)
  expect(cropped.report.actualVolumeMm3).toBeLessThan(
    simplified.report.actualVolumeMm3,
  )
}, 120_000)

test("a route corridor clips barrel slabs and retains other copper inside the analysis domain", async () => {
  const corridor = await exportGmsh({
    model,
    conformal: true,
    meshSizeMm: 0.6,
    routeCorridor: { netIds: [requirements.terminals[0].netId], marginMm: 2 },
    outputDirectory: join(directory, "corridor"),
    validationRequirements: requirements,
  })
  expect(corridor.validation?.checks.every((c) => c.passed === true)).toBe(true)
  expect(corridor.report.actualVolumeMm3).toBeLessThan(
    result.report.actualVolumeMm3,
  )
  expect(corridor.validation?.connections?.every((c) => c.passed)).toBe(true)
  expect(
    corridor.report.materials.some(
      (m) => m.name === `copper:${requirements.terminals[2].netId}`,
    ),
  ).toBe(true)
}, 120_000)

test("a grazing crop creates a detectable barrel sliver; expanding the crop preserves a healthy copper path", async () => {
  const netId = requirements.terminals.find((t) => t.name === "U2.GND")!.netId
  const contacts: MeshValidationRequirements = {
    terminals: [
      { name: "ground.top", netId, positionMm: [2.3, 1.5, 0.9225] },
      { name: "ground.bottom", netId, positionMm: [2.3, 1.5, -0.0175] },
    ],
    connections: [{ from: "ground.top", to: "ground.bottom" }],
  }
  const grazingBounds: [number, number, number, number] = [2.125, 1, 2.6, 2]
  const grazing = await exportGmsh({
    model,
    boundsMm: grazingBounds,
    conformal: true,
    meshSizeMm: 0.2,
    outputDirectory: join(directory, "grazing"),
    validationRequirements: contacts,
  })
  expect(grazing.validation?.passed).toBe(true)
  expect(grazing.validation?.quality?.minimum).toBeLessThan(0.001)
  const strict = await validateMesh({
    meshPath: grazing.meshPath!,
    manifestPath: grazing.manifestPath,
    model,
    requirements: contacts,
    minimumTetQuality: 0.001,
    outputDirectory: join(directory, "grazing-strict"),
  })
  expect(strict.passed).toBe(false)
  const expanded = avoidGrazingBarrels({ model, boundsMm: grazingBounds })
  expect(expanded.adjustments.length).toBeGreaterThan(0)
  const healthy = await exportGmsh({
    model,
    boundsMm: expanded.boundsMm,
    conformal: true,
    meshSizeMm: 0.2,
    optimizeNetgen: true,
    minimumTetQuality: 0.001,
    outputDirectory: join(directory, "grazing-fixed"),
    validationRequirements: contacts,
  })
  expect(healthy.validation?.passed).toBe(true)
  expect(healthy.validation?.connections?.every((c) => c.passed)).toBe(true)
}, 120_000)

for (const [mode, failedCheck] of [
  ["missing_interface", "conformal_interfaces"],
  ["duplicate_interface_nodes", "conformal_interfaces"],
  ["inverted_tetrahedron", "positive_tetrahedra"],
  ["nonmanifold_face", "manifold_tetrahedron_faces"],
  ["unowned_material", "material_ownership"],
  ["filled_drill", "drill_and_cutout_voids"],
  ["copper_short", "copper_net_separation"],
  ["copper_short_duplicate_nodes", "copper_net_separation"],
] as const)
  test(`saved mesh corruption is rejected: ${mode}`, async () => {
    const meshPath = join(directory, `${mode}.msh`)
    const process = Bun.spawn(
      [
        globalThis.process.env.GMSH_PYTHON ?? "python3",
        join(import.meta.dir, "fixtures/damage-mesh.py"),
        "--mesh",
        result.meshPath!,
        "--manifest",
        result.manifestPath!,
        "--mode",
        mode,
        "--output",
        meshPath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [code, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ])
    if (code) throw new Error(stderr)
    const validation = await validateMesh({
      meshPath,
      manifestPath: result.manifestPath,
      model,
      requirements,
      outputDirectory: join(directory, mode),
    })
    expect(validation.passed).toBe(false)
    expect(validation.checks.find((c) => c.name === failedCheck)?.passed).toBe(
      false,
    )
  }, 120_000)

test("endpoint net and quality requirements are enforced, not inferred from source connectivity", async () => {
  const wrongRequirements = structuredClone(requirements)
  wrongRequirements.terminals[0].netId = requirements.terminals[2].netId
  const badContact = await validateMesh({
    meshPath: result.meshPath!,
    manifestPath: result.manifestPath,
    model,
    requirements: wrongRequirements,
    outputDirectory: join(directory, "wrong-contact"),
  })
  expect(
    badContact.checks.find((c) => c.name === "terminal_connectivity")?.passed,
  ).toBe(false)
  const strict = await validateMesh({
    meshPath: result.meshPath!,
    manifestPath: result.manifestPath,
    model,
    minimumTetQuality: 0.99,
    outputDirectory: join(directory, "strict-quality"),
  })
  expect(
    strict.checks.find((c) => c.name === "positive_tetrahedra")?.passed,
  ).toBe(false)
}, 120_000)

test("a removed inner-layer copper segment fails the physical U1.OUT → U2.IN path", async () => {
  const disconnected = structuredClone(model)
  const signal = disconnected.multilayer.copper.find(
    (c) => c.layer === "inner1" && c.netId === requirements.terminals[0].netId,
  )!
  expect(signal.segments.length).toBeGreaterThan(0)
  signal.segments = []
  const outputDirectory = await mkdtemp(join(tmpdir(), "gmsh-disconnected-"))
  await expect(
    exportGmsh({
      model: disconnected,
      conformal: true,
      meshSizeMm: 0.8,
      outputDirectory,
      validationRequirements: requirements,
    }),
  ).rejects.toThrow("terminal_connectivity")
  const report = JSON.parse(
    await readFile(join(outputDirectory, "validation.json"), "utf8"),
  )
  expect(report.copperComponents[requirements.terminals[0].netId]).toBe(2)
  expect(report.connections[0].passed).toBe(false)
}, 120_000)
