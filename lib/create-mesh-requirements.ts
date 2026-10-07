import { copperConnectivity } from "./copper-connectivity"
import { smtPadOutline } from "./copper-outlines"
import { pointInPolygon } from "./geometry"
import type {
  CircuitJson,
  GeometryModel,
  MeshValidationRequirements,
} from "./types"

/** Resolve refdes.pin contacts without inferring an excitation or frequency.
 * Probe the pad centre when possible, or another pad point away from a drill.
 * Multi-layer terminals require an explicit copper position and layer. */
export function createMeshRequirements(options: {
  circuitJson: CircuitJson
  model: GeometryModel
  connections: { from: string; to: string }[]
}): MeshValidationRequirements {
  const connectivity = copperConnectivity(options.circuitJson)
  const terminals = [
    ...new Set(options.connections.flatMap((c) => [c.from, c.to])),
  ].map((name) => {
    const separator = name.indexOf(".")
    if (separator < 1) throw new Error(`Expected refdes.pin, received ${name}`)
    const refdes = name.slice(0, separator),
      pin = name.slice(separator + 1)
    const components = options.circuitJson.filter(
      (e) => e.type === "source_component" && e.name === refdes,
    )
    if (components.length !== 1)
      throw new Error(`Expected one source component for ${refdes}`)
    const component = components[0]
    if (component.type !== "source_component")
      throw new Error("Missing source component")
    const ports = options.circuitJson.filter(
      (e) =>
        e.type === "source_port" &&
        e.source_component_id === component.source_component_id &&
        [e.name, String(e.pin_number), ...(e.port_hints ?? [])].includes(pin),
    )
    if (ports.length !== 1)
      throw new Error(`Expected one source port for ${name}`)
    const port = ports[0]
    if (port.type !== "source_port") throw new Error("Missing source port")
    const pcbPorts = options.circuitJson.filter(
      (e) => e.type === "pcb_port" && e.source_port_id === port.source_port_id,
    )
    if (pcbPorts.length !== 1 || pcbPorts[0].type !== "pcb_port")
      throw new Error(`Expected one PCB port for ${name}`)
    const pcbPort = pcbPorts[0]
    if (pcbPort.layers.length !== 1)
      throw new Error(
        `Choose an explicit copper position and layer for multi-layer terminal ${name}`,
      )
    const layer = options.model.multilayer.stackup.copperLayers.find(
      (l) => l.name === pcbPort.layers[0],
    )
    if (!layer) throw new Error(`Missing physical layer for ${name}`)
    const netId = connectivity.pcbPorts.get(pcbPort.pcb_port_id)
    if (!netId) throw new Error(`Missing copper ownership for ${name}`)
    const outlines = options.circuitJson.flatMap((e) =>
      e.type === "pcb_smtpad" &&
      e.pcb_port_id === pcbPort.pcb_port_id &&
      e.layer === layer.name
        ? [smtPadOutline(e)]
        : [],
    )
    const candidates = [{ x: pcbPort.x, y: pcbPort.y }]
    for (const outline of outlines) {
      const minX = Math.min(...outline.map((p) => p.x)),
        maxX = Math.max(...outline.map((p) => p.x))
      const minY = Math.min(...outline.map((p) => p.y)),
        maxY = Math.max(...outline.map((p) => p.y))
      for (const xFraction of [0.25, 0.5, 0.75])
        for (const yFraction of [0.25, 0.5, 0.75])
          candidates.push({
            x: minX + (maxX - minX) * xFraction,
            y: minY + (maxY - minY) * yFraction,
          })
    }
    const position = candidates.find(
      (p) =>
        (!outlines.length || outlines.some((o) => pointInPolygon(p, o))) &&
        !options.model.multilayer.drills.some(
          (d) =>
            d.zMin <= layer.zMin &&
            d.zMax >= layer.zMax &&
            pointInPolygon(p, d.hole),
        ),
    )
    if (!position)
      throw new Error(
        `No copper probe away from drills for ${name}; specify an explicit terminal position`,
      )
    return {
      name,
      netId,
      positionMm: [position.x, position.y, (layer.zMin + layer.zMax) / 2] as [
        number,
        number,
        number,
      ],
    }
  })
  return { terminals, connections: options.connections }
}
