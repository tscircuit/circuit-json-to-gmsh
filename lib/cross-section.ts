import type { PreviewSolid } from "./types"

/** Keep triangulated CAD faces on a cutaway plane. Export with cutawayX first;
 * filtering arbitrary uncut surface meshes does not create an interior section. */
export function crossSection(options: {
  solids: PreviewSolid[]
  xMm: number
}): PreviewSolid[] {
  if (!Number.isFinite(options.xMm)) throw new Error("xMm must be finite")
  const result: PreviewSolid[] = []
  for (const solid of options.solids) {
    const selected: number[] = []
    for (let offset = 0; offset < solid.indices.length; offset += 3) {
      const triangle = solid.indices.slice(offset, offset + 3)
      if (
        triangle.every(
          (i) => Math.abs(solid.positions[3 * i] - options.xMm) < 1e-6,
        )
      )
        selected.push(...triangle)
    }
    if (!selected.length) continue
    const unique = Array.from(new Set(selected)).sort((a, b) => a - b)
    const indices = new Map(unique.map((id, index) => [id, index]))
    result.push({
      ...solid,
      positions: unique.flatMap((i) => solid.positions.slice(3 * i, 3 * i + 3)),
      indices: selected.map((i) => indices.get(i)!),
    })
  }
  if (!result.length)
    throw new Error("No CAD faces on this cut plane; export a cutaway first")
  return result
}
