import { renderGeometry, type PreviewSolid } from "lib/index"

/** Native upper-face triangles displayed in micrometres relative to the contact.
 * Scaling avoids PoppyGL's 0.01-unit near plane for this tiny detail. */
export function renderRepairDetail(options: {
  solids: PreviewSolid[]
  xMm: number
  yMm: number
  zMm: number
}) {
  const solids: PreviewSolid[] = []
  for (const solid of options.solids) {
    const selected: number[] = []
    for (let index = 0; index < solid.indices.length; index += 3) {
      const triangle = solid.indices.slice(index, index + 3)
      if (
        triangle.every(
          (i) => Math.abs(solid.positions[3 * i + 2] - options.zMm) < 1e-8,
        )
      )
        selected.push(...triangle)
    }
    if (!selected.length) continue
    const unique = Array.from(new Set(selected))
    const mapping = new Map(unique.map((i, index) => [i, index]))
    solids.push({
      ...solid,
      indices: selected.map((i) => mapping.get(i)!),
      positions: unique.flatMap((i) =>
        solid.positions
          .slice(3 * i, 3 * i + 3)
          .map(
            (value, axis) =>
              1000 * (value - [options.xMm, options.yMm, options.zMm][axis]),
          ),
      ),
    })
  }
  return renderGeometry({
    solids,
    copperOnly: true,
    render: {
      camPos: [0, 0, 2],
      lookAt: [0, 0, 0],
      up: "y+",
      width: 640,
      height: 480,
    },
  })
}
