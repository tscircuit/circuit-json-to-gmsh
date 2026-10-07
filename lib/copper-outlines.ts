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
  return Array.from({ length: 32 }, (_, index) => {
    const angle = (index * 2 * Math.PI) / 32
    const x = Math.cos(angle),
      y = Math.sin(angle)
    return applyToPoint(transform, {
      x: Math.sign(x) * (options.width / 2 - radius) + radius * x,
      y: Math.sign(y) * (options.height / 2 - radius) + radius * y,
    })
  })
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
