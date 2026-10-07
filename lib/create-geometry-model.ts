import type { PcbTrace, Point } from "circuit-json"
import { normalizeLayeredRoute } from "./normalize-layered-route"
import { cutoutOutline, rectangleOutline, pointInPolygon } from "./geometry"
import { positiveFinite, pourRegion } from "./read-geometry"
import { copperConnectivity } from "./copper-connectivity"
import {
  drillOutline,
  platedPadOutline,
  roundedOutline,
  smtPadOutline,
} from "./copper-outlines"
import { physicalStackup, type CopperLayer } from "./stackup"
import type {
  GeometryModel,
  GeometryOptions,
  LayeredGeometry,
  SignalSegment,
} from "./types"
type CopperKey = string
type PcbTraceId = string

/** Physical PCB geometry; no excitation, ground net, or frequency is inferred. */
export function createGeometryModel(options: GeometryOptions): GeometryModel {
  if (
    options.antipadShape !== undefined &&
    !["offset", "bounding-box"].includes(options.antipadShape)
  )
    throw new Error("antipadShape must be offset or bounding-box")
  options = {
    ...options,
    circuitJson: options.circuitJson.map((e) =>
      e.type === "pcb_trace" ? normalizeLayeredRoute(e) : e,
    ),
  }
  const boards = options.circuitJson.filter((e) => e.type === "pcb_board")
  if (boards.length !== 1) throw new Error("Exactly one PCB board is required")
  const board = boards[0]
  if (
    !Number.isInteger(board.num_layers) ||
    board.num_layers < 2 ||
    board.num_layers > 10
  )
    throw new Error("Board needs two to ten copper layers")
  const stackup = physicalStackup({
    stackup: options.stackup,
    numLayers: board.num_layers,
    lossTangent: 0.02,
  })
  const connectivity = copperConnectivity(options.circuitJson)
  const boardOutline = board.outline?.length
    ? board.outline
    : rectangleOutline({
        center: board.center,
        width: board.width ?? 0,
        height: board.height ?? 0,
      })
  const boardCutouts = options.circuitJson
    .filter((e) => e.type === "pcb_cutout")
    .map(cutoutOutline)
  const viaClearance = positiveFinite(
    options.viaClearance ?? board.min_trace_to_pad_edge_clearance ?? 0.2,
    "viaClearance",
  )
  const layered: LayeredGeometry = {
    stackup,
    viaClearance,
    antipadShape: options.antipadShape ?? "offset",
    copper: [],
    drills: [],
    barrels: [],
    boardCutouts,
    audit: {
      traces: 0,
      vias: 0,
      pads: 0,
      platedHoles: 0,
      unplatedHoles: 0,
      pours: 0,
      omittedCopperElements: 0,
      warnings: [
        "Component bodies, package/decoupling impedances, solder mask and silkscreen are not modeled.",
        "Circular copper/drills use 32-sided polygons. Via plating uses 0.025 mm; override support is not yet provided.",
      ],
    },
  }
  const copperByKey = new Map<CopperKey, LayeredGeometry["copper"][number]>()
  const traces = new Map<PcbTraceId, PcbTrace>()
  for (const element of options.circuitJson) {
    if (element.type === "pcb_trace") traces.set(element.pcb_trace_id, element)
    const additions: {
      layer: string
      netId: string
      region?: import("./types").CopperRegion
      segment?: SignalSegment
    }[] = []
    if (element.type === "pcb_copper_pour") {
      if (!element.source_net_id)
        throw new Error("Copper pours require a source_net_id")
      additions.push({
        layer: element.layer,
        netId: connectivity.owner(element.source_net_id),
        region: { ...pourRegion(element), isPlane: true },
      })
      layered.audit.pours++
    }
    if (element.type === "pcb_ground_plane_region") {
      const plane = options.circuitJson.find(
        (e) =>
          e.type === "pcb_ground_plane" &&
          e.pcb_ground_plane_id === element.pcb_ground_plane_id,
      )
      if (!plane || plane.type !== "pcb_ground_plane")
        throw new Error("Missing ground-plane owner")
      additions.push({
        layer: element.layer,
        netId: connectivity.owner(plane.source_net_id),
        region: { outer: element.points, holes: [], isPlane: true },
      })
    }
    if (element.type === "pcb_smtpad") {
      const netId = element.pcb_port_id
        ? connectivity.pcbPorts.get(element.pcb_port_id)
        : undefined
      if (!netId)
        throw new Error(
          `Pad ${element.pcb_smtpad_id} has no PCB port ownership`,
        )
      additions.push({
        layer: element.layer,
        netId,
        region: { outer: smtPadOutline(element), holes: [] },
      })
      layered.audit.pads++
    }
    if (element.type === "pcb_trace") {
      const netId = connectivity.pcbTraces.get(element.pcb_trace_id)!
      validateLayeredRoute(
        element,
        stackup.copperLayers.map((l) => l.name),
      )
      for (let index = 1; index < element.route.length; index++) {
        const start = element.route[index - 1],
          end = element.route[index]
        if (start.route_type !== "wire" || end.route_type !== "wire") continue
        if (start.x === end.x && start.y === end.y) continue
        additions.push({
          layer: start.layer,
          netId,
          segment: {
            start,
            end,
            width: positiveFinite(start.width, "trace width"),
          },
        })
      }
      layered.audit.traces++
    }
    for (const addition of additions) {
      if (!stackup.copperLayers.some((l) => l.name === addition.layer))
        throw new Error(`Copper on absent layer ${addition.layer}`)
      const key = `${addition.layer}:${addition.netId}`
      let copper = copperByKey.get(key)
      if (!copper) {
        copper = {
          layer: addition.layer as CopperLayer,
          netId: addition.netId,
          regions: [],
          segments: [],
        }
        copperByKey.set(key, copper)
        layered.copper.push(copper)
      }
      if (addition.region) copper.regions.push(addition.region)
      if (addition.segment) copper.segments.push(addition.segment)
    }
  }
  const bottom = stackup.copperLayers.at(-1)!,
    top = stackup.copperLayers[0]
  for (const element of options.circuitJson) {
    if (element.type === "pcb_hole") {
      layered.drills.push({
        hole: drillOutline(element),
        zMin: bottom.zMin,
        zMax: top.zMax,
      })
      layered.audit.unplatedHoles++
    }
    if (element.type !== "pcb_via" && element.type !== "pcb_plated_hole")
      continue
    const netId =
      element.type === "pcb_via"
        ? element.source_net_id
          ? connectivity.owner(element.source_net_id)
          : element.pcb_trace_id
            ? connectivity.pcbTraces.get(element.pcb_trace_id)
            : undefined
        : element.pcb_port_id
          ? connectivity.pcbPorts.get(element.pcb_port_id)
          : undefined
    if (!netId)
      throw new Error(
        `Cannot identify copper ownership for ${element.type}; supply source_net_id or pcb_trace_id`,
      )
    const layers = element.layers.map((name) =>
      stackup.copperLayers.find((l) => l.name === name),
    )
    if (!layers.length || layers.some((l) => !l))
      throw new Error("Via/hole references an absent stackup layer")
    const zMin = Math.min(...layers.map((l) => l!.zMin)),
      zMax = Math.max(...layers.map((l) => l!.zMax))
    const hole =
      element.type === "pcb_via"
        ? roundedOutline({
            ...element,
            width: element.hole_diameter,
            height: element.hole_diameter,
          })
        : drillOutline(element)
    const pads =
      element.type === "pcb_via"
        ? roundedOutline({
            ...element,
            width: element.outer_diameter,
            height: element.outer_diameter,
          })
        : platedPadOutline(element)
    // Mesher offsets this hole by plating thickness, including slotted holes.
    layered.barrels.push({
      netId,
      hole,
      pads,
      layers: element.layers as CopperLayer[],
      zMin,
      zMax,
      platingThickness: 0.025,
    })
    layered.drills.push({ hole, zMin, zMax })
    if (element.type === "pcb_via") layered.audit.vias++
    else layered.audit.platedHoles++
  }
  // Every routed layer transition must correspond to a physical plated via.
  for (const trace of traces.values())
    for (const route of trace.route) {
      if (route.route_type !== "via") continue
      const barrel = layered.barrels.find(
        (b) =>
          b.netId === connectivity.pcbTraces.get(trace.pcb_trace_id) &&
          pointInPolygon(route, b.hole) &&
          b.layers.includes(route.from_layer as CopperLayer) &&
          b.layers.includes(route.to_layer as CopperLayer),
      )
      if (!barrel)
        throw new Error(
          `Trace ${trace.pcb_trace_id} changes layer without a matching physical pcb_via`,
        )
    }
  for (const barrel of layered.barrels)
    barrel.clearance = barrelClearanceOutline(barrel, viaClearance)
  return { schemaVersion: 1, geometry: { boardOutline }, multilayer: layered }
}
function validateLayeredRoute(trace: PcbTrace, layers: string[]) {
  for (const [index, route] of trace.route.entries()) {
    if (route.route_type !== "wire" && route.route_type !== "via")
      throw new Error("Unsupported route point type")
    if (![route.x, route.y].every(Number.isFinite))
      throw new Error("Trace coordinates must be finite")
    if (route.route_type === "wire") {
      positiveFinite(route.width, "trace width")
      if (!layers.includes(route.layer))
        throw new Error(`Unknown route layer ${route.layer}`)
      const previous = trace.route[index - 1]
      if (previous?.route_type === "wire" && previous.layer !== route.layer)
        throw new Error("Layer transitions require a via route point")
    } else if (route.route_type === "via") {
      const previous = trace.route[index - 1],
        next = trace.route[index + 1]
      if (
        previous?.route_type !== "wire" ||
        next?.route_type !== "wire" ||
        previous.layer !== route.from_layer ||
        next.layer !== route.to_layer ||
        Math.hypot(previous.x - route.x, previous.y - route.y) > 1e-6 ||
        Math.hypot(next.x - route.x, next.y - route.y) > 1e-6
      )
        throw new Error(
          "Via route must join matching, colocated layer endpoints",
        )
    } else throw new Error("Unsupported route point type")
  }
}

export function barrelClearanceOutline(
  barrel: LayeredGeometry["barrels"][number],
  clearance: number,
): Point[] {
  const xs = barrel.pads.map((p) => p.x),
    ys = barrel.pads.map((p) => p.y)
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys)
  // Rotated/noncircular plated holes use an explicit rectangular bounding
  // antipad. Preserve the manufactured drill/pad; only clearance is conservative.
  return rectangleOutline({
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    width: maxX - minX + 2 * clearance,
    height: maxY - minY + 2 * clearance,
  })
}
