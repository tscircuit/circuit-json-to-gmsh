import { expect, test } from "bun:test"
import { Circuit } from "@tscircuit/core"
import { mkdtemp } from "node:fs/promises"
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
