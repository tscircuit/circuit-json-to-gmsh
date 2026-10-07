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
    "--refinement-box",
    "-1",
    "-1",
    "-0.2",
    "1",
    "1",
    "0.6",
    "0.3",
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
  expect(receipt.localMeshRefinements).toEqual([
    {
      boundsMm: [-1, -1, -0.2, 1, 1, 0.6],
      meshSizeMm: 0.3,
      transitionThicknessMm: 0.3,
    },
  ])
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
  const compressed = await python("prepare-channel.py", [
    "--mesh-directory",
    output,
    "--output",
    solver,
    "--frequency-hz",
    "400000000",
    "--linear-solver",
    "STRUMPACK",
    "--strumpack-compression",
    "HSS",
    "--strumpack-compression-tolerance",
    "0.000001",
    "--complex-coarse-solve",
    "--preconditioner-side",
    "Right",
  ])
  if (compressed.code) throw new Error(compressed.error)
  const compressedConfig = await Bun.file(join(solver, "palace-1.json")).json()
  const compressedReceipt = await Bun.file(
    join(solver, "solver-input.json"),
  ).json()
  expect(compressedConfig.Solver.Linear.Tol).toBe(1e-8)
  expect(compressedConfig.Solver.Linear.PCSide).toBe("Right")
  expect(compressedConfig.Solver.Linear.ComplexCoarseSolve).toBe(true)
  expect(compressedReceipt.linearSolverSettings).toEqual(
    compressedConfig.Solver.Linear,
  )
  const mismatchedSolver = await python("prepare-channel.py", [
    "--mesh-directory",
    output,
    "--output",
    solver,
    "--frequency-hz",
    "400000000",
    "--linear-solver",
    "AMS",
    "--strumpack-compression",
    "HSS",
  ])
  expect(mismatchedSolver.code).toBe(1)
  expect(mismatchedSolver.error).toContain("Compression requires STRUMPACK")
  const shifted = await python("prepare-channel.py", [
    "--mesh-directory",
    output,
    "--output",
    solver,
    "--frequency-hz",
    "400000000",
    "--linear-solver",
    "MUMPS",
    "--shifted-preconditioner",
    "--preconditioner-side",
    "Right",
    "--compression",
    "BLR",
    "--compression-tolerance",
    "0.00000001",
  ])
  if (shifted.code) throw new Error(shifted.error)
  const shiftedConfig = await Bun.file(join(solver, "palace-1.json")).json()
  expect(shiftedConfig.Solver.Linear.PCMatShifted).toBe(true)
  expect(shiftedConfig.Solver.Linear.Tol).toBe(1e-8)
  expect(shiftedConfig.Solver.Linear.STRUMPACKCompressionType).toBe("BLR")
  expect(shiftedConfig.Solver.Linear.STRUMPACKCompressionTol).toBe(1e-8)
  const invalidComplexShift = await python("prepare-channel.py", [
    "--mesh-directory",
    output,
    "--output",
    solver,
    "--frequency-hz",
    "400000000",
    "--linear-solver",
    "MUMPS",
    "--shifted-preconditioner",
    "--complex-coarse-solve",
  ])
  expect(invalidComplexShift.code).toBe(1)
  expect(invalidComplexShift.error).toContain(
    "Shifted MUMPS requires a real coarse solve",
  )
  const invalidCompression = await python("prepare-channel.py", [
    "--mesh-directory",
    output,
    "--output",
    solver,
    "--frequency-hz",
    "400000000",
    "--linear-solver",
    "MUMPS",
    "--compression",
    "HSS",
  ])
  expect(invalidCompression.code).toBe(1)
  expect(invalidCompression.error).toContain("MUMPS (None/BLR)")
  const invalidBox = await python("rectangularize-ports.py", [
    "--mesh-directory",
    source,
    "--output",
    output,
    "--mesh-size",
    "0.6",
    "--refinement-box",
    "1",
    "-1",
    "-1",
    "-1",
    "1",
    "1",
    "0.3",
  ])
  expect(invalidBox.code).toBe(1)
  expect(invalidBox.error).toContain("ordered XYZ bounds")
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
