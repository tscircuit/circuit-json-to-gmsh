import type { AnyCircuitElement, Point } from "circuit-json"
import type {
  CopperLayer,
  FabricationStackup,
  PhysicalStackup,
} from "./stackup"

export type CircuitJson = readonly AnyCircuitElement[]
export interface CopperRegion {
  outer: Point[]
  holes: Point[][]
  isPlane?: boolean
}
export interface SignalSegment {
  start: Point
  end: Point
  width: number
}
export interface GeometryOptions {
  circuitJson: CircuitJson
  stackup: FabricationStackup
  /** Plane antipad clearance in mm. Defaults to board clearance or 0.2 mm. */
  viaClearance?: number
  /** Offset actual pad outlines by default. Bounding boxes reproduce the
   * legacy mesher and support deliberately rectangular generated antipads. */
  antipadShape?: "offset" | "bounding-box"
}
export interface LayeredGeometry {
  stackup: PhysicalStackup
  viaClearance: number
  antipadShape?: "offset" | "bounding-box"
  copper: {
    layer: CopperLayer
    netId: string
    regions: CopperRegion[]
    segments: SignalSegment[]
  }[]
  drills: { hole: Point[]; zMin: number; zMax: number }[]
  barrels: {
    netId: string
    hole: Point[]
    clearance?: Point[]
    pads: Point[]
    layers: CopperLayer[]
    zMin: number
    zMax: number
    platingThickness: number
  }[]
  boardCutouts: Point[][]
  audit: {
    traces: number
    vias: number
    pads: number
    platedHoles: number
    unplatedHoles: number
    pours: number
    omittedCopperElements: number
    warnings: string[]
  }
}
export interface GeometryModel {
  schemaVersion: 1
  geometry: { boardOutline: Point[] }
  multilayer: LayeredGeometry
}
export interface PreviewSolid {
  id: string
  material: "copper" | "dielectric"
  netId?: string
  layer?: string
  positions: number[]
  indices: number[]
}
export interface GeometryReport {
  gmshVersion: string
  wallSeconds: number
  peakRssMiB: number
  cadSeconds: number
  meshSeconds: number
  volumeCount: number
  expectedVolumeMm3: number
  actualVolumeMm3: number
  tetrahedra: number
  sharedInterfaceFaces: number
  minimumTetQuality?: number
  removedVolumeMm3: number
  repairs: {
    solid: {
      name: string
      material: string
      netId?: string
      layer?: string
      zMin: number
      zMax: number
    }
    contactsMm: [number, number][]
    notchHalfWidthMm: number
    removedAreaMm2: number
    cadVoidVerified: boolean
    boundsMm: number[]
  }[]
  materials: { name: string; attribute: number; volumes: number[] }[]
}
export interface GmshResult {
  report: GeometryReport
  preview: PreviewSolid[]
  brepPath: string
  meshPath?: string
}
