import type { PcbCutout, Point } from "circuit-json"
import {
  applyToPoint,
  compose,
  rotateDEG,
  translate,
} from "transformation-matrix"

export function rectangleOutline(rect: {
  center: Point
  width: number
  height: number
  rotation?: number
}): Point[] {
  if (
    ![
      rect.center.x,
      rect.center.y,
      rect.rotation ?? 0,
      rect.width,
      rect.height,
    ].every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0
  )
    throw new Error(
      "Rectangles need finite coordinates, rotation, and positive dimensions",
    )
  const localToWorld = compose(
    translate(rect.center.x, rect.center.y),
    rotateDEG(rect.rotation ?? 0),
  )
  return [
    { x: -rect.width / 2, y: -rect.height / 2 },
    { x: rect.width / 2, y: -rect.height / 2 },
    { x: rect.width / 2, y: rect.height / 2 },
    { x: -rect.width / 2, y: rect.height / 2 },
  ].map((corner) => applyToPoint(localToWorld, corner))
}

/** Tessellate circuit-json bulges (tan of one quarter of the signed sweep).
 * Coordinates are circuit world mm with +Y up. Angular pitch is at most 3°.
 */
export function flattenRing(
  vertices: readonly (Point & { bulge?: number })[],
): Point[] {
  const outline: Point[] = []
  for (let vertexIndex = 0; vertexIndex < vertices.length; vertexIndex++) {
    const start = vertices[vertexIndex]
    const end = vertices[(vertexIndex + 1) % vertices.length]
    outline.push({ x: start.x, y: start.y })
    const bulge = start.bulge ?? 0
    if (Math.abs(bulge) < 1e-12) continue
    const dx = end.x - start.x
    const dy = end.y - start.y
    const center = {
      x: (start.x + end.x) / 2 - (dy * (1 - bulge * bulge)) / (4 * bulge),
      y: (start.y + end.y) / 2 + (dx * (1 - bulge * bulge)) / (4 * bulge),
    }
    const sweep = 4 * Math.atan(bulge)
    const radius = Math.hypot(start.x - center.x, start.y - center.y)
    const startAngle = Math.atan2(start.y - center.y, start.x - center.x)
    const steps = Math.ceil(Math.abs(sweep) / (Math.PI / 60))
    for (let arcIndex = 1; arcIndex < steps; arcIndex++) {
      const angle = startAngle + (sweep * arcIndex) / steps
      outline.push({
        x: center.x + radius * Math.cos(angle),
        y: center.y + radius * Math.sin(angle),
      })
    }
  }
  return outline
}

export function cutoutOutline(cutout: PcbCutout): Point[] {
  if (cutout.shape === "polygon") return cutout.points
  if (cutout.shape === "circle") {
    if (!Number.isFinite(cutout.radius) || cutout.radius <= 0)
      throw new Error("Circular cutouts need a finite positive radius")
    return Array.from({ length: 120 }, (_, circleIndex) => ({
      x:
        cutout.center.x +
        cutout.radius * Math.cos((circleIndex * Math.PI) / 60),
      y:
        cutout.center.y +
        cutout.radius * Math.sin((circleIndex * Math.PI) / 60),
    }))
  }
  if (cutout.shape === "rect" && !cutout.corner_radius)
    return rectangleOutline(cutout)
  throw new Error(
    "Path and rounded rectangular PCB cutouts are not supported; use a polygon cutout",
  )
}

export function pointInPolygon(
  point: Point,
  outline: readonly Point[],
): boolean {
  let inside = false
  for (let cornerIndex = 0; cornerIndex < outline.length; cornerIndex++) {
    const start = outline[cornerIndex]
    const end = outline[(cornerIndex + 1) % outline.length]
    const cross =
      (point.x - start.x) * (end.y - start.y) -
      (point.y - start.y) * (end.x - start.x)
    if (
      Math.abs(cross) < 1e-9 &&
      point.x >= Math.min(start.x, end.x) - 1e-9 &&
      point.x <= Math.max(start.x, end.x) + 1e-9 &&
      point.y >= Math.min(start.y, end.y) - 1e-9 &&
      point.y <= Math.max(start.y, end.y) + 1e-9
    )
      return true
    if (
      start.y > point.y !== end.y > point.y &&
      point.x <
        start.x + ((point.y - start.y) * (end.x - start.x)) / (end.y - start.y)
    )
      inside = !inside
  }
  return inside
}
