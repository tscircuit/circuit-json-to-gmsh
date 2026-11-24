import { expect, test } from "bun:test"
import { roundedOutline } from "../lib/copper-outlines"
import type { Point } from "circuit-json"

function polygonArea(points: Point[]) {
  let area = 0
  for (const [index, point] of points.entries()) {
    const next = points[(index + 1) % points.length]
    area += point.x * next.y - next.x * point.y
  }
  return area / 2
}

test("rounded pill outlines preserve straight edges outside corner arcs", () => {
  const outline = roundedOutline({
    x: 0,
    y: 0,
    width: 2,
    height: 1,
    radius: 0.4,
  })
  for (const expected of [
    { x: 0.6, y: 0.5 },
    { x: -0.6, y: 0.5 },
    { x: 0.6, y: -0.5 },
    { x: -0.6, y: -0.5 },
    { x: 1, y: 0.1 },
    { x: 1, y: -0.1 },
    { x: -1, y: 0.1 },
    { x: -1, y: -0.1 },
  ])
    expect(
      outline.some(
        (point) =>
          Math.abs(point.x - expected.x) < 1e-9 &&
          Math.abs(point.y - expected.y) < 1e-9,
      ),
    ).toBe(true)
  const exactArea = 2 - (4 - Math.PI) * 0.4 ** 2
  expect(Math.abs(polygonArea(outline) - exactArea)).toBeLessThan(0.004)
})
