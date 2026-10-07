import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMeshRequirements, exportGmsh } from "lib/index"
import { renderBoard } from "./fixtures/render-board"

async function python(script: string, args: string[]) {
  const child = Bun.spawn(
    [
      process.env.GMSH_PYTHON ?? "python3",
      join(import.meta.dir, "../scripts/palace", script),
      ...args,
    ],
    { stdout: "ignore", stderr: "pipe" },
  )
  const [code, error] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ])
  return { code, error }
}

test("oblique TSX pad ports get native-verified PEC contacts without changing the PCB", async () => {
  const board = await renderBoard({ referenceOffsetXMm: 0.7 })
  const requirements = createMeshRequirements({
    ...board,
    connections: [
      { from: "U1.OUT", to: "U2.IN" },
      { from: "U1.GND", to: "U2.GND" },
    ],
  })
  const referenceNetId = requirements.terminals.find(
    (p) => p.name === "U1.GND",
  )!.netId
  const source = await mkdtemp(join(tmpdir(), "gmsh-oblique-ports-"))
  const original = await exportGmsh({
    model: board.model,
    outputDirectory: source,
    conformal: true,
    fragmentStrategy: "tiled",
    tileSizeMm: 2.5,
    airPaddingMm: 1,
    meshSizeMm: 0.6,
    minimumTetQuality: 0.0001,
    validationRequirements: requirements,
    lumpedPorts: requirements.terminals
      .filter((p) => p.netId !== referenceNetId)
      .map((terminal) => ({ terminal, referenceNetId, widthMm: 0.08 })),
  })
  expect(original.validation?.pcbChecksComplete).toBe(true)
  const output = await mkdtemp(join(tmpdir(), "gmsh-port-fixtures-"))
  const built = await python("rectangularize-ports.py", [
    "--mesh-directory",
    source,
    "--output",
    output,
    "--mesh-size",
    "0.6",
    "--threads",
    "1",
  ])
  if (built.code) throw new Error(built.error)
  const validation = await Bun.file(join(output, "validation.json")).json()
  expect(validation.pcbChecksComplete).toBe(true)
  expect(validation.quality.threshold).toBe(0.0001)
  expect(validation.checks.every((c: { passed: boolean }) => c.passed)).toBe(
    true,
  )
  const receipt = await Bun.file(join(output, "port-fixtures.json")).json()
  expect(receipt.materialVolumesUnchanged).toBe(true)
  expect(receipt.nativeContactNetsValidated).toBe(true)
  expect(receipt.contactClearanceMm).toBe(0.001)
  const brep = await Bun.file(join(output, "brep-validation.json")).json()
  expect(brep.valid).toBe(true)
  const ports = await Bun.file(join(output, "ports.json")).json()
  expect(ports).toHaveLength(2)
  expect(
    ports.every(
      (p: { fixturePecFaces: number[] }) => p.fixturePecFaces.length >= 2,
    ),
  ).toBe(true)
  const solver = await mkdtemp(join(tmpdir(), "palace-oblique-ports-"))
  const prepared = await python("prepare-channel.py", [
    "--mesh-directory",
    output,
    "--output",
    solver,
    "--frequency-hz",
    "400000000",
    "--linear-solver",
    "AMS",
    "--max-iterations",
    "1200",
    "--krylov-size",
    "200",
    "--ams-vector-interpolation",
    "--smoothing-iterations",
    "2",
  ])
  if (prepared.code) throw new Error(prepared.error)
  const config = await Bun.file(join(solver, "palace-1.json")).json()
  expect(config.Boundaries.PEC.Attributes).toEqual([1000000])
  expect(config.Boundaries.LumpedPort).toHaveLength(2)
  expect(config.Solver.Linear).toEqual({
    Type: "AMS",
    KSPType: "GMRES",
    Tol: 1e-8,
    MaxIts: 1200,
    MaxSize: 200,
    AMSVectorInterpolation: true,
    MGSmoothIts: 2,
  })
  ports[0].fixturePecFaces = ports[1].fixturePecFaces
  await Bun.write(join(output, "ports.json"), JSON.stringify(ports))
  const rejected = await python("prepare-channel.py", [
    "--mesh-directory",
    output,
    "--output",
    solver,
    "--frequency-hz",
    "400000000",
  ])
  expect(rejected.code).toBe(1)
  expect(rejected.error).toContain("native-validated PEC contact fixtures")
}, 360_000)
