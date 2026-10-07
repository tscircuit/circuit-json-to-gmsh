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
  fragmentStrategy?: "global" | "slab" | "tiled"
  tetrahedralAlgorithm?: "delaunay" | "hxt"
  tileSizeMm?: number | null
  simplificationToleranceMm?: number
  simplification?: {
    layer: string
    netId: string
    accepted: boolean
    verticesBefore: number
    verticesAfter: number
    boundaryDisplacementMm: number
    addedAreaMm2: number
    removedAreaMm2: number
  }[]
  wallSeconds: number
  peakRssMiB: number
  cadSeconds: number
  meshSeconds: number
  volumeCount: number
  expectedVolumeMm3: number
  actualVolumeMm3: number
  tetrahedra: number
  sharedInterfaceFaces: number
  minimumTetQuality?: number | null
  removedVolumeMm3: number
  sliverRepairs?: {
    netId: string
    areaMm2: number
    volumeMm3: number
    boundsMm: number[]
    zMin: number
    zMax: number
    maximumAreaMm2: number
    insetTestMm: number
    copperAddedAreaMm2?: number
    dielectricRemovedAreaMm2?: number
    snappingAddedAreaMm2?: number
    snappingRemovedAreaMm2?: number
    snappingBoundaryDisplacementMm?: number
  }[]
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
  manifestPath?: string
  validation?: MeshValidationReport
}

export interface MeshValidationRequirements {
  terminals: {
    name: string
    netId: string
    positionMm: [number, number, number]
  }[]
  connections: { from: string; to: string }[]
}

export interface MeshValidationReport {
  schemaVersion: 1
  passed: boolean
  /** CAD ownership, PCB voids and requested endpoint paths were all checked. */
  pcbChecksComplete?: boolean
  gmshVersion?: string
  units?: "mm"
  wallSeconds?: number
  meshSha256?: string
  manifestSha256?: string
  modelSha256?: string
  requirementsSha256?: string
  tetrahedra?: number
  nodes?: number
  quality?: {
    minimum: number | null
    percentile01: number | null
    median: number | null
    threshold: number
    worstElements?: {
      tag: number
      volume: number
      material?: string
      minSICN: number
      coordinatesMm: number[][]
    }[]
  }
  copperComponents?: Record<string, number>
  terminals?: Record<
    string,
    {
      netId: string
      positionMm: [number, number, number]
      components: number[]
      tetrahedra: number[]
    }
  >
  checks: {
    name: string
    passed: boolean | null
    errors?: (string | Record<string, unknown>)[]
  }[]
  connections?: { from: string; to: string; passed: boolean }[]
  limitations?: string[]
}
