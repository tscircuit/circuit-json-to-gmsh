import type { PcbCopperPour } from "circuit-json"
import { flattenRing, rectangleOutline } from "./geometry"
import type { CopperRegion } from "./types"
export function pourRegion(pour: PcbCopperPour): CopperRegion {
  if (pour.shape === "rect") return { outer: rectangleOutline(pour), holes: [] }
  if (pour.shape === "polygon") return { outer: pour.points, holes: [] }
  return {
    outer: flattenRing(pour.brep_shape.outer_ring.vertices),
    holes: pour.brep_shape.inner_rings.map((ring) =>
      flattenRing(ring.vertices),
    ),
  }
}

export function positiveFinite(number: number, label: string): number {
  if (!Number.isFinite(number) || number <= 0)
    throw new Error(`${label} must be finite and greater than zero`)
  return number
}
