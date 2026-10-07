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
  renderGeometry,
} from "lib/index"
import { fourLayerStackup } from "./fixtures/multilayer-board"
import { expectPngSnapshot } from "./fixtures/png-snapshot"

test("a route crop retains whole plated pads and supports a verified conformal CAD remesh", async () => {
  const circuit = new Circuit()
  circuit.add(
    <board width={4} height={3} layers={4} thickness={0.975} schematicDisabled>
      <net name="GND" />
      {[-1, 1].map((x, index) => (
        <chip
          key={index}
          name={`U${index + 1}`}
          pcbX={x}
          pinLabels={{ pin1: index ? "IN" : "OUT" }}
          footprint={
            <footprint>
              <smtpad portHints={["pin1"]} shape="circle" radius={0.1} />
            </footprint>
          }
        />
      ))}
      <trace
        from=".U1 > .OUT"
        to=".U2 > .IN"
        thickness={0.1}
        pcbPathRelativeTo=".U1 > .OUT"
        pcbPath={[
          { x: 0, y: 0 },
          { x: 2, y: 0 },
        ]}
      />
      <chip
        name="J1"
        pcbX={0}
        pcbY={0.4}
        pinLabels={{ pin1: "GND" }}
        footprint={
          <footprint>
            <platedhole
              portHints={["pin1"]}
              shape="circle"
              holeDiameter={0.15}
              outerDiameter={0.3}
            />
          </footprint>
        }
      />
      <trace from=".J1 > .GND" to="net.GND" />
    </board>,
  )
  await circuit.renderUntilSettled()
  const circuitJson = parseCircuitJson(circuit.getCircuitJson())
  const model = createGeometryModel({ circuitJson, stackup: fourLayerStackup })
  const requirements = createMeshRequirements({
    circuitJson,
    model,
    connections: [{ from: "U1.OUT", to: "U2.IN" }],
  })
  const layered = model.multilayer!
  const barrel = layered.barrels[0]!
  const top = layered.stackup.copperLayers.find((l) => l.name === "top")!
  const bottom = layered.stackup.copperLayers.find((l) => l.name === "bottom")!
  for (const [name, foil] of [
    ["ground.top", top],
    ["ground.bottom", bottom],
  ] as const) {
    requirements.terminals.push({
      name,
      netId: barrel.netId,
      positionMm: [0.11, 0.4, (foil.zMin + foil.zMax) / 2],
    })
  }
  requirements.connections.push({ from: "ground.top", to: "ground.bottom" })
  const source = await mkdtemp(join(tmpdir(), "gmsh-whole-pad-"))
  const options = {
    model,
    conformal: true,
    fragmentStrategy: "slab" as const,
    airPaddingMm: 0.3,
    routeCorridor: {
      netIds: [requirements.terminals[0]!.netId],
      marginMm: 0.4,
    },
    validationRequirements: requirements,
    minimumTetQuality: 0.001,
    optimizeNetgen: true,
  }
  const result = await exportGmsh({
    ...options,
    outputDirectory: source,
    meshSizeMm: 0.3,
  })
  expect(result.validation?.checks.every((c) => c.passed)).toBe(true)
  const crop = await Bun.file(join(source, "route-corridor.json")).json()
  expect(crop.regularization.protectedEnvelope).toBe(
    "whole via pads and plated walls",
  )
  expect(crop.expandedBarrelIndices).toContain(0)
  const child = Bun.spawn(
    [
      process.env.GMSH_PYTHON ?? "python3",
      "-c",
      `
import json,sys
from shapely.geometry import Polygon
from shapely import set_precision
m=json.load(open(sys.argv[1])); b=m['multilayer']['barrels'][0]
hole=Polygon([(p['x'],p['y']) for p in b['hole']]); pad=Polygon([(p['x'],p['y']) for p in b['pads']])
wall=set_precision(hole.buffer(b['platingThickness'],join_style='mitre').difference(hole),1e-6).area
pad_area=set_precision(pad.difference(hole),1e-6).area
height=b['zMax']-b['zMin']; foil=sum(l['zMax']-l['zMin'] for l in m['multilayer']['stackup']['copperLayers'] if l['name'] in b['layers'])
print(pad_area*foil+wall*(height-foil))
`,
      join(source, "model.json"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const expectedVolume = Number(await new Response(child.stdout).text())
  expect(await child.exited).toBe(0)
  const manifest = await Bun.file(join(source, "mesh-manifest.json")).json()
  const actualVolume = manifest.volumes
    .filter((v: { netId?: string }) => v.netId === barrel.netId)
    .reduce((sum: number, v: { volumeMm3: number }) => sum + v.volumeMm3, 0)
  expect(actualVolume).toBeCloseTo(expectedVolume, 7)
  const finer = await exportGmsh({
    ...options,
    outputDirectory: await mkdtemp(join(tmpdir(), "gmsh-pad-remesh-")),
    meshSizeMm: 0.2,
    cadCheckpointDirectory: source,
    tetrahedralAlgorithm: "hxt",
  })
  expect(finer.validation?.checks.every((c) => c.passed)).toBe(true)
  expect(finer.report.tetrahedra).toBeGreaterThan(result.report.tetrahedra)
  expect(finer.report.tetrahedralAlgorithm).toBe("hxt")
  await expectPngSnapshot({
    png: await renderGeometry({
      solids: result.preview.filter((s) => s.netId === barrel.netId),
      copperOnly: true,
      render: {
        width: 500,
        height: 500,
        camPos: [1.5, -2, 1.5],
        lookAt: [0, 0.4, 0.5],
      },
    }),
    path: join(import.meta.dir, "__snapshots__/whole-corridor-pad.png"),
  })
}, 180_000)
