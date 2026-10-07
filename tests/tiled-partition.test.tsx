import { expect, test } from "bun:test"
import { Circuit } from "@tscircuit/core"
import { cp, mkdtemp, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createGeometryModel,
  createMeshRequirements,
  exportGmsh,
  parseCircuitJson,
} from "lib/index"
import { DifferentialViasBoard } from "./fixtures/differential-vias-board"
import { fourLayerStackup } from "./fixtures/multilayer-board"

test("XY batches join into a conformal TSX DQS mesh with both through-via paths intact", async () => {
  const circuit = new Circuit()
  circuit.add(<DifferentialViasBoard />)
  await circuit.renderUntilSettled()
  const circuitJson = parseCircuitJson(circuit.getCircuitJson())
  const model = createGeometryModel({
    circuitJson,
    stackup: fourLayerStackup,
    viaClearance: 0.1,
  })
  const requirements = createMeshRequirements({
    circuitJson,
    model,
    connections: [
      { from: "U1.P1", to: "U2.F3" },
      { from: "U1.P2", to: "U2.G3" },
    ],
  })
  const directory = await mkdtemp(join(tmpdir(), "gmsh-tiled-"))
  const result = await exportGmsh({
    model,
    outputDirectory: directory,
    conformal: true,
    fragmentStrategy: "tiled",
    // Twelve cells exercise successive joins, not only one four-cell block.
    tileSizeMm: 2,
    meshSizeMm: 0.6,
    validationRequirements: requirements,
  })
  expect(result.validation?.passed).toBe(true)
  expect(result.validation?.pcbChecksComplete).toBe(true)
  expect(result.validation?.checks.every((c) => c.passed)).toBe(true)
  expect(result.validation?.connections?.every((c) => c.passed)).toBe(true)
  expect(
    result.validation?.copperComponents?.[requirements.terminals[0].netId],
  ).toBe(1)
  expect(
    result.validation?.copperComponents?.[requirements.terminals[2].netId],
  ).toBe(1)
  expect(result.report.sharedInterfaceFaces).toBeGreaterThan(0)
  const entry = (await readdir(join(directory, "tile-cache")))[0]!
  const tile = join(directory, "tile-cache", entry)
  const preflight = async (input: string, output: string) => {
    const subprocess = Bun.spawn(
      [
        process.env.GMSH_PYTHON ?? "python3",
        join(import.meta.dir, "../scripts/validate-cached-tile.py"),
        "--tile",
        input,
        "--model",
        join(directory, "model.json"),
        "--output",
        output,
        "--mesh-size",
        "0.6",
        "--check-brep",
      ],
      { stdout: "ignore", stderr: "pipe" },
    )
    const [code, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stderr).text(),
    ])
    const report = await Bun.file(join(output, "preflight.json")).json()
    if (!report && code) throw new Error(stderr)
    return { code, report }
  }
  const local = await preflight(tile, join(directory, "preflight"))
  expect(local.code).toBe(0)
  expect(local.report.passed).toBe(true)
  expect(local.report.brepValidation.valid).toBe(true)
  expect(local.report.completeRouteValidated).toBe(false)
  expect(local.report.validation.pcbChecksComplete).toBe(false)
  const corrupt = join(directory, "corrupt-cache")
  await cp(tile, corrupt, { recursive: true })
  const receipt = await Bun.file(join(corrupt, "complete.json")).json()
  receipt.brepSha256 = "0".repeat(64)
  await Bun.write(join(corrupt, "complete.json"), JSON.stringify(receipt))
  const rejected = await preflight(
    corrupt,
    join(directory, "rejected-preflight"),
  )
  expect(rejected.code).toBe(1)
  expect(rejected.report.passed).toBe(false)
  expect(rejected.report.error).toContain("hash mismatch")
  const finer = await exportGmsh({
    model,
    outputDirectory: await mkdtemp(join(tmpdir(), "gmsh-remesh-")),
    conformal: true,
    fragmentStrategy: "tiled",
    tileSizeMm: 2,
    meshSizeMm: 0.4,
    cadCheckpointDirectory: directory,
    validationRequirements: requirements,
  })
  expect(finer.validation?.checks.every((c) => c.passed)).toBe(true)
  expect(finer.report.tetrahedra).toBeGreaterThan(result.report.tetrahedra)
  expect(finer.report.actualVolumeMm3).toBeCloseTo(
    result.report.actualVolumeMm3,
    8,
  )
  await expect(
    exportGmsh({
      model,
      outputDirectory: await mkdtemp(
        join(tmpdir(), "gmsh-changed-checkpoint-"),
      ),
      conformal: true,
      fragmentStrategy: "tiled",
      tileSizeMm: 2,
      meshSizeMm: 0.4,
      airPaddingMm: 1,
      cadCheckpointDirectory: directory,
      validationRequirements: requirements,
    }),
  ).rejects.toThrow("checkpoint geometry")
}, 360_000)

test("a partition plane avoids grazing a TSX copper edge without changing physical volume", async () => {
  const circuit = new Circuit()
  circuit.add(
    <board width={4} height={4} layers={4} schematicDisabled>
      <net name="GND" />
      <copperpour
        layer="inner2"
        connectsTo="net.GND"
        boardEdgeMargin={0}
        outline={[
          { x: -0.000231, y: -2 },
          { x: 2, y: -2 },
          { x: 2, y: 2 },
          { x: -0.000231, y: 2 },
        ]}
      />
    </board>,
  )
  await circuit.renderUntilSettled()
  const model = createGeometryModel({
    circuitJson: parseCircuitJson(circuit.getCircuitJson()),
    stackup: fourLayerStackup,
  })
  const directory = await mkdtemp(join(tmpdir(), "gmsh-grazing-tile-"))
  const result = await exportGmsh({
    model,
    outputDirectory: directory,
    conformal: true,
    fragmentStrategy: "tiled",
    tileSizeMm: 2,
    meshSizeMm: 0.2,
    minimumTetQuality: 0.001,
  })
  const partition = await Bun.file(
    join(directory, "tile-partition.json"),
  ).json()
  expect(partition.physicalGeometryChanged).toBe(false)
  expect(partition.adjustments).toHaveLength(1)
  expect(partition.adjustments[0].axis).toBe("x")
  expect(partition.adjustments[0].nominalMm).toBe(0)
  expect(
    Math.abs(partition.adjustments[0].actualMm + 0.000231),
  ).toBeGreaterThanOrEqual(0.002)
  expect(
    result.validation?.checks.every((check) => check.passed !== false),
  ).toBe(true)
  expect(result.report.minimumTetQuality).toBeGreaterThan(0.001)
  expect(result.report.actualVolumeMm3).toBeCloseTo(16 * (0.975 - 0.07), 7)
}, 120_000)
