import {
  computeSmoothNormals,
  encodePNG,
  renderDrawCalls,
  type DrawCall,
  type RenderOptionsInput,
} from "poppygl"
import type { PreviewSolid } from "./types"

const layerColors: Record<string, [number, number, number, number]> = {
  top: [0.9, 0.5, 0.12, 1],
  inner1: [0.78, 0.28, 0.08, 1],
  inner2: [0.96, 0.72, 0.21, 1],
  bottom: [0.78, 0.45, 0.15, 1],
  barrel: [0.85, 0.56, 0.26, 1],
}

/** Render triangles exported by native Gmsh with PoppyGL. zScale exaggerates
 * thickness for inspection only; CAD and mesh files keep physical dimensions. */
export async function renderGeometry(options: {
  solids: PreviewSolid[]
  copperOnly?: boolean
  zScale?: number
  render?: RenderOptionsInput
}): Promise<Uint8Array> {
  const zScale = options.zScale ?? 1
  if (!Number.isFinite(zScale) || zScale <= 0)
    throw new Error("zScale must be positive")
  const drawCalls: DrawCall[] = options.solids
    .filter((solid) => !options.copperOnly || solid.material === "copper")
    .map((solid) => {
      const positions = Float32Array.from(solid.positions, (v, i) =>
        i % 3 === 2 ? v * zScale : v,
      )
      const indices = Uint32Array.from(solid.indices)
      return {
        positions,
        indices,
        normals: computeSmoothNormals(positions, indices),
        uvs: null,
        model: Float32Array.from([
          1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
        ]),
        material: {
          baseColorFactor:
            solid.material === "dielectric"
              ? [0.11, 0.32, 0.22, 1]
              : (layerColors[solid.layer ?? "barrel"] ?? layerColors.barrel),
          baseColorTexture: null,
          metallicFactor: solid.material === "copper" ? 0.65 : 0,
          roughnessFactor: 0.65,
        },
      }
    })
  if (!drawCalls.length) throw new Error("No triangulated solids to render")
  return encodePNG(
    renderDrawCalls(drawCalls, {
      realistic: true,
      width: 800,
      height: 600,
      supersampling: 2,
      up: "z+",
      grid: false,
      backgroundColor: "#eef1f5",
      ...options.render,
    }).bitmap,
  )
}
