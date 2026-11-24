import type { PcbSmtPad, PcbPlatedHole, PcbHole, Point } from "circuit-json"
import {
  applyToPoint,
  compose,
  rotateDEG,
  translate,
} from "transformation-matrix"
import { rectangleOutline } from "./geometry"
import { positiveFinite } from "./read-geometry"
import type { SignalSegment } from "./types"

/** Match Shapely's round-ended line buffer with eight chords per quadrant. */
export function traceOutline(segment: SignalSegment): Point[] {
  const dx = segment.end.x - segment.start.x
  const dy = segment.end.y - segment.start.y
  const length = Math.hypot(dx, dy)
  const transform = compose(
    translate(
      (segment.start.x + segment.end.x) / 2,
      (segment.start.y + segment.end.y) / 2,
    ),
    rotateDEG((Math.atan2(dy, dx) * 180) / Math.PI),
  )
  return [-1, 1].flatMap((end) =>
    Array.from({ length: 17 }, (_, index) => {
      const angle =
        (index * Math.PI) / 16 + (end === 1 ? -Math.PI / 2 : Math.PI / 2)
      return applyToPoint(transform, {
        x: (end * length) / 2 + (segment.width / 2) * Math.cos(angle),
        y: (segment.width / 2) * Math.sin(angle),
      })
    }),
  )
}

/** 32-sided circles and rounded capsules are an explicit geometry approximation. */
export function roundedOutline(options: {
  x: number
  y: number
  width: number
  height: number
  radius?: number
  ccwRotationDegrees?: number
}): Point[] {
  positiveFinite(options.width, "outline width")
  positiveFinite(options.height, "outline height")
  const radius = options.radius ?? Math.min(options.width, options.height) / 2
  if (
    !Number.isFinite(radius) ||
    radius <= 0 ||
    radius > Math.min(options.width, options.height) / 2 + 1e-7
  )
    throw new Error("Invalid rounded copper radius")
  const transform = compose(
    translate(options.x, options.y),
    rotateDEG(options.ccwRotationDegrees ?? 0),
  )
  const cornerX = options.width / 2 - radius
  const cornerY = options.height / 2 - radius
  const corners = [
    { x: cornerX, y: cornerY, startAngle: 0 },
    { x: -cornerX, y: cornerY, startAngle: Math.PI / 2 },
    { x: -cornerX, y: -cornerY, startAngle: Math.PI },
    { x: cornerX, y: -cornerY, startAngle: (3 * Math.PI) / 2 },
  ]
  const localPoints = corners.flatMap((corner) =>
    Array.from({ length: 9 }, (_, index) => {
      const angle = corner.startAngle + (index * Math.PI) / 16
      return {
        x: corner.x + radius * Math.cos(angle),
        y: corner.y + radius * Math.sin(angle),
      }
    }),
  )
  const tolerance = Math.max(options.width, options.height) * 1e-12
  const deduplicated: Point[] = []
  for (const point of localPoints) {
    const previous = deduplicated.at(-1)
    if (
      !previous ||
      Math.hypot(point.x - previous.x, point.y - previous.y) > tolerance
    )
      deduplicated.push(point)
  }
  const first = deduplicated[0],
    last = deduplicated.at(-1)
  if (last && Math.hypot(first.x - last.x, first.y - last.y) <= tolerance)
    deduplicated.pop()
  return deduplicated.map((point) => applyToPoint(transform, point))
}

export function smtPadOutline(pad: PcbSmtPad): Point[] {
  if (pad.shape === "polygon") return pad.points
  if (pad.shape === "circle")
    return roundedOutline({
      ...pad,
      width: 2 * pad.radius,
      height: 2 * pad.radius,
    })
  if (pad.shape === "rect" || pad.shape === "rotated_rect")
    return rectangleOutline({
      center: pad,
      width: pad.width,
      height: pad.height,
      rotation: pad.shape === "rotated_rect" ? pad.ccw_rotation : 0,
    })
  if (pad.shape === "pill" || pad.shape === "rotated_pill")
    return roundedOutline({
      ...pad,
      radius: pad.radius,
      ccwRotationDegrees: pad.shape === "rotated_pill" ? pad.ccw_rotation : 0,
    })
  throw new Error("Unsupported SMT pad shape")
}

export function drillOutline(hole: PcbPlatedHole | PcbHole): Point[] {
  if ("hole_diameter" in hole)
    return roundedOutline({
      x: hole.x + ("hole_offset_x" in hole ? (hole.hole_offset_x ?? 0) : 0),
      y: hole.y + ("hole_offset_y" in hole ? (hole.hole_offset_y ?? 0) : 0),
      width: positiveFinite(hole.hole_diameter ?? 0, "hole diameter"),
      height: positiveFinite(hole.hole_diameter ?? 0, "hole diameter"),
    })
  if ("hole_width" in hole)
    return roundedOutline({
      ...hole,
      width: positiveFinite(hole.hole_width ?? 0, "hole width"),
      height: positiveFinite(hole.hole_height ?? 0, "hole height"),
      ccwRotationDegrees: "ccw_rotation" in hole ? hole.ccw_rotation : 0,
    })
  throw new Error("Unsupported drilled hole shape")
}

export function platedPadOutline(hole: PcbPlatedHole): Point[] {
  if ("outer_diameter" in hole)
    return roundedOutline({
      ...hole,
      width: hole.outer_diameter,
      height: hole.outer_diameter,
    })
  if ("outer_width" in hole)
    return roundedOutline({
      ...hole,
      width: hole.outer_width,
      height: hole.outer_height,
      ccwRotationDegrees: "ccw_rotation" in hole ? hole.ccw_rotation : 0,
    })
  if (hole.shape === "circular_hole_with_rect_pad")
    return rectangleOutline({
      center: hole,
      width: hole.rect_pad_width,
      height: hole.rect_pad_height,
      rotation: hole.rect_ccw_rotation,
    })
  throw new Error(`Unsupported plated hole shape: ${hole.shape}`)
}
