import type { GeometryModel } from "../lib/index"

/** Choose AM3352 crop boundaries away from near-tangent barrel rims. This changes
 * only the crop, and every requested/expanded coordinate is saved in provenance.
 * The 1% plating margin covers the 32-sided circular barrel's mitred offset. */
export function avoidGrazingBarrels(options: {
  model: GeometryModel
  boundsMm: [number, number, number, number]
}) {
  const boundsMm = [...options.boundsMm] as [number, number, number, number]
  const adjustments: {
    axis: "x" | "y"
    fromMm: number
    toMm: number
    netId: string
  }[] = []
  for (let iteration = 0; iteration < 32; iteration++) {
    let changed = false
    for (const barrel of options.model.multilayer.barrels) {
      const margin = barrel.platingThickness * 1.01
      const limits = [
        Math.min(...barrel.hole.map((p) => p.x)) - margin,
        Math.min(...barrel.hole.map((p) => p.y)) - margin,
        Math.max(...barrel.hole.map((p) => p.x)) + margin,
        Math.max(...barrel.hole.map((p) => p.y)) + margin,
      ]
      for (const axis of [0, 1]) {
        const other = 1 - axis
        if (
          limits[other] > boundsMm[other + 2] ||
          limits[other + 2] < boundsMm[other]
        )
          continue
        for (const boundary of [axis, axis + 2]) {
          if (
            ![limits[axis], limits[axis + 2]].some(
              (edge) => Math.abs(edge - boundsMm[boundary]) < 0.01,
            )
          )
            continue
          const fromMm = boundsMm[boundary]
          const toMm =
            boundary < 2 ? limits[axis] - 0.05 : limits[axis + 2] + 0.05
          if (
            (boundary < 2 && toMm >= fromMm) ||
            (boundary >= 2 && toMm <= fromMm)
          )
            continue
          boundsMm[boundary] = toMm
          adjustments.push({
            axis: axis === 0 ? "x" : "y",
            fromMm,
            toMm,
            netId: barrel.netId,
          })
          changed = true
        }
      }
    }
    if (!changed) return { boundsMm, adjustments }
  }
  throw new Error(
    "Could not find stable crop bounds away from grazing barrel rims",
  )
}
