import { expect, test } from "bun:test"
import { Circuit } from "@tscircuit/core"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createGeometryModel,
  createMeshRequirements,
  crossSection,
  exportGmsh,
  parseCircuitJson,
  renderGeometry,
} from "lib/index"
import { DifferentialViasBoard } from "./fixtures/differential-vias-board"
import { fourLayerStackup } from "./fixtures/multilayer-board"
import { expectPngSnapshot } from "./fixtures/png-snapshot"

test("DQS-style TSX pair retains connected through-via stubs and hollow four-layer cross-sections", async () => {
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
  requirements.terminals.push({
    name: "positive.bottomStub",
    netId: requirements.terminals[0].netId,
    positionMm: [-0.9, 0.4, -0.0175],
  })
  requirements.connections.push({ from: "U1.P1", to: "positive.bottomStub" })
  const result = await exportGmsh({
    model,
    outputDirectory: await mkdtemp(join(tmpdir(), "gmsh-differential-")),
    conformal: true,
    meshSizeMm: 0.6,
    validationRequirements: requirements,
  })
  expect(result.validation?.passed).toBe(true)
  expect(result.validation?.connections).toHaveLength(3)
  expect(result.validation?.connections?.every((c) => c.passed)).toBe(true)
  for (const terminal of requirements.terminals.slice(0, 4))
    expect(result.validation?.copperComponents?.[terminal.netId]).toBe(1)
  await expectPngSnapshot({
    png: await renderGeometry({
      solids: result.preview,
      copperOnly: true,
      zScale: 4,
      render: {
        width: 700,
        height: 550,
        camPos: [9, -11, 9],
        lookAt: [0, 0, 1.5],
      },
    }),
    path: join(import.meta.dir, "__snapshots__/differential-via-stubs.png"),
  })
  const cut = await exportGmsh({
    model,
    outputDirectory: await mkdtemp(
      join(tmpdir(), "gmsh-differential-section-"),
    ),
    conformal: true,
    cutawayX: -1,
    meshSizeMm: 0.6,
  })
  expect(cut.validation?.passed).toBe(true)
  await expectPngSnapshot({
    png: await renderGeometry({
      solids: crossSection({ solids: cut.preview, xMm: -1 }),
      zScale: 4,
      render: {
        width: 700,
        height: 550,
        camPos: [12, 0, 1.8],
        lookAt: [-1, 0, 1.8],
        fov: 30,
      },
    }),
    path: join(
      import.meta.dir,
      "__snapshots__/differential-via-cross-section.png",
    ),
  })
}, 120_000)
