import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMeshRequirements, exportGmsh, validateMesh } from "lib/index"
import { renderBoard } from "./fixtures/render-board"

test("a connected port gap touching a third TSX conductor is rejected", async () => {
  const board = await renderBoard({ portObstruction: true })
  const requirements = createMeshRequirements({
    ...board,
    connections: [
      { from: "U1.OUT", to: "U2.IN" },
      { from: "U1.GND", to: "U2.GND" },
    ],
  })
  const referenceNetId = requirements.terminals.find(
    (t) => t.name === "U1.GND",
  )!.netId
  await expect(
    exportGmsh({
      model: board.model,
      outputDirectory: await mkdtemp(join(tmpdir(), "gmsh-obstructed-port-")),
      conformal: true,
      airPaddingMm: 1,
      lumpedPorts: [
        { terminal: requirements.terminals[0], referenceNetId, widthMm: 0.08 },
      ],
    }),
  ).rejects.toThrow("third conductor")
})

test("a TSX crop discards zero-area copper contact beside a retained island on the same net", async () => {
  const board = await renderBoard({ cropBoundaryCopper: true })
  const requirements = createMeshRequirements({
    ...board,
    connections: [
      { from: "U1.OUT", to: "U2.IN" },
      { from: "U1.GND", to: "U2.GND" },
    ],
  })
  const referenceNetId = requirements.terminals.find(
    (t) => t.name === "U1.GND",
  )!.netId
  const result = await exportGmsh({
    model: board.model,
    outputDirectory: await mkdtemp(join(tmpdir(), "gmsh-crop-line-contact-")),
    conformal: true,
    meshSizeMm: 0.8,
    boundsMm: [-3, -2, 3, 2],
    simplifyToleranceMm: 0.001,
    airPaddingMm: 1,
    validationRequirements: requirements,
    lumpedPorts: [
      { terminal: requirements.terminals[0], referenceNetId, widthMm: 0.08 },
    ],
  })
  expect(result.validation?.pcbChecksComplete).toBe(true)
  expect(result.validation?.checks.every((c) => c.passed === true)).toBe(true)
  const ports = await Bun.file(join(result.brepPath, "..", "ports.json")).json()
  expect(ports).toHaveLength(1)
}, 120_000)

test("a field mesh can fill a TSX cutout with air while the same laminate cell is rejected", async () => {
  const board = await renderBoard({ cutout: true })
  const requirements = createMeshRequirements({
    ...board,
    connections: [{ from: "U1.OUT", to: "U2.IN" }],
  })
  const outputDirectory = await mkdtemp(join(tmpdir(), "gmsh-air-void-"))
  const result = await exportGmsh({
    model: board.model,
    outputDirectory,
    conformal: true,

    meshSizeMm: 0.8,
    validationRequirements: requirements,
  })
  for (const material of ["air", "dielectric"] as const) {
    const meshPath = join(outputDirectory, `${material}.msh`)
    const subprocess = Bun.spawn(
      [
        process.env.GMSH_PYTHON ?? "python3",
        join(import.meta.dir, "fixtures/add-cutout-cell.py"),
        "--mesh",
        result.meshPath!,
        "--manifest",
        result.manifestPath!,
        "--output",
        meshPath,
        "--material",
        material,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [code, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stderr).text(),
    ])
    if (code) throw new Error(stderr)
    const validation = await validateMesh({
      meshPath,
      manifestPath: `${meshPath}.manifest.json`,
      model: board.model,
      requirements,
      outputDirectory: join(outputDirectory, `${material}-check`),
    })
    expect(validation.pcbChecksComplete).toBe(true)
    expect(
      validation.checks.find((c) => c.name === "material_ownership")?.passed,
    ).toBe(true)
    expect(
      validation.checks.find((c) => c.name === "drill_and_cutout_voids")
        ?.passed,
    ).toBe(material === "air")
    expect(validation.passed).toBe(material === "air")
  }
}, 120_000)

test("a TSX PCB enclosure fills drills and cutouts with air and conserves total domain volume", async () => {
  const board = await renderBoard({ cutout: true })
  const requirements = createMeshRequirements({
    ...board,
    connections: [{ from: "U1.OUT", to: "U2.IN" }],
  })
  const result = await exportGmsh({
    model: board.model,
    outputDirectory: await mkdtemp(join(tmpdir(), "gmsh-enclosure-")),
    conformal: true,
    airPaddingMm: 1,
    meshSizeMm: 0.8,
    validationRequirements: requirements,
  })
  expect(result.validation?.checks.every((c) => c.passed)).toBe(true)
  expect(result.report.materials.some((m) => m.name === "air")).toBe(true)
  expect(result.report.actualVolumeMm3).toBeCloseTo(10 * 8 * 2.975, 5)
}, 120_000)

test("explicit outer-pad ports have native surfaces in the validated air mesh", async () => {
  const board = await renderBoard()
  const requirements = createMeshRequirements({
    ...board,
    connections: [
      { from: "U1.OUT", to: "U2.IN" },
      { from: "U1.GND", to: "U2.GND" },
    ],
  })
  const referenceNetId = requirements.terminals.find(
    (t) => t.name === "U1.GND",
  )!.netId
  const result = await exportGmsh({
    model: board.model,
    outputDirectory: await mkdtemp(join(tmpdir(), "gmsh-pad-ports-")),
    conformal: true,
    fragmentStrategy: "tiled",
    tileSizeMm: 4,
    airPaddingMm: 1,
    meshSizeMm: 0.8,
    validationRequirements: requirements,
    lumpedPorts: requirements.terminals
      .filter((t) => t.netId !== referenceNetId)
      .map((terminal) => ({ terminal, referenceNetId, widthMm: 0.08 })),
  })
  expect(result.validation?.checks.every((c) => c.passed)).toBe(true)
  const ports = await Bun.file(join(result.brepPath, "..", "ports.json")).json()
  expect(ports.map((p: { name: string }) => p.name)).toEqual([
    "U1.OUT",
    "U2.IN",
  ])
  expect(ports.every((p: { faces: number[] }) => p.faces.length > 0)).toBe(true)
  const sourceDirectory = join(result.brepPath, "..")
  const refined = await exportGmsh({
    model: board.model,
    outputDirectory: await mkdtemp(join(tmpdir(), "gmsh-pad-ports-refined-")),
    conformal: true,
    fragmentStrategy: "tiled",
    tileSizeMm: 4,
    airPaddingMm: 1,
    meshSizeMm: 0.6,
    cadCheckpointDirectory: sourceDirectory,
    validationRequirements: requirements,
    lumpedPorts: requirements.terminals
      .filter((t) => t.netId !== referenceNetId)
      .map((terminal) => ({ terminal, referenceNetId, widthMm: 0.08 })),
  })
  expect(refined.validation?.checks.every((c) => c.passed)).toBe(true)
  expect(refined.report.actualVolumeMm3).toBeCloseTo(
    result.report.actualVolumeMm3,
    8,
  )
  const solverDirectory = join(sourceDirectory, "palace")
  const preparation = Bun.spawn(
    [
      process.env.GMSH_PYTHON ?? "python3",
      join(import.meta.dir, "../scripts/palace/prepare-channel.py"),
      "--mesh-directory",
      sourceDirectory,
      "--output",
      solverDirectory,
      "--frequency-hz",
      "400000000",
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [code, error] = await Promise.all([
    preparation.exited,
    new Response(preparation.stderr).text(),
  ])
  if (code) throw new Error(error)
  const config = await Bun.file(join(solverDirectory, "palace-1.json")).json()
  expect(config.Solver.Driven.Samples[0].Freq).toEqual([0.4])
  expect(
    config.Boundaries.LumpedPort.map(
      (p: { Excitation: boolean }) => p.Excitation,
    ),
  ).toEqual([true, false])
  const mesh = await Bun.file(join(solverDirectory, "palace.msh")).text()
  const elements = mesh
    .split("$Elements\n")[1]
    .split("$EndElements")[0]
    .trim()
    .split("\n")
    .slice(1)
  const triangles = elements
    .map((e) => e.trim().split(/\s+/).map(Number))
    .filter((e) => e[1] === 2)
    .map((e) =>
      e
        .slice(-3)
        .sort((a, b) => a - b)
        .join(","),
    )
  expect(new Set(triangles).size).toBe(triangles.length)
}, 240_000)
