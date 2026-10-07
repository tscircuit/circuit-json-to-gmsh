import { z } from "zod"
import { positiveFinite } from "./read-geometry"

export type CopperLayer =
  | "top"
  | "bottom"
  | "inner1"
  | "inner2"
  | "inner3"
  | "inner4"
  | "inner5"
  | "inner6"
  | "inner7"
  | "inner8"

/** Top-to-bottom fabrication stack. Dimensions are physical, in millimetres. */
export interface FabricationStackup {
  nominalBoardThicknessMm?: number
  layers: (
    | { name: CopperLayer; copperThicknessMm: number }
    | {
        material: string
        dielectricThicknessMm: number
        dielectricConstant: number
        lossTangent?: number
      }
  )[]
}

export interface PhysicalCopperLayer {
  name: CopperLayer
  zMin: number
  zMax: number
}
export interface PhysicalDielectricLayer {
  material: string
  zMin: number
  zMax: number
  dielectricConstant: number
  lossTangent: number
  attribute: number
}
export interface PhysicalStackup {
  copperLayers: PhysicalCopperLayer[]
  dielectrics: PhysicalDielectricLayer[]
  physicalThicknessMm: number
  nominalBoardThicknessMm?: number
}

const copperLayer = z.string().regex(/^(top|bottom|inner[1-8])$/)
const fabricationStackupSchema = z.object({
  nominalBoardThicknessMm: z.number().finite().positive().optional(),
  layers: z.array(
    z.union([
      z.object({
        name: copperLayer,
        copperThicknessMm: z.number().finite().positive(),
      }),
      z.object({
        material: z.string().min(1),
        dielectricThicknessMm: z.number().finite().positive(),
        dielectricConstant: z.number().finite().positive(),
        lossTangent: z.number().finite().nonnegative().optional(),
      }),
    ]),
  ),
})

export function parseCopperLayer(input: unknown): CopperLayer {
  return copperLayer.parse(input) as CopperLayer
}

export function parseFabricationStackup(input: unknown): FabricationStackup {
  return fabricationStackupSchema.parse(input) as FabricationStackup
}

export function physicalStackup(options: {
  stackup: FabricationStackup
  numLayers: number
  lossTangent: number
}): PhysicalStackup {
  const stackup = parseFabricationStackup(options.stackup)
  const expected = [
    "top",
    ...Array.from({ length: options.numLayers - 2 }, (_, i) => `inner${i + 1}`),
    "bottom",
  ]
  if (stackup.layers.length !== 2 * options.numLayers - 1)
    throw new Error(
      "Stackup must alternate copper and dielectric, top to bottom",
    )
  const copperLayers: PhysicalCopperLayer[] = []
  const dielectrics: PhysicalDielectricLayer[] = []
  // Bottom foil's upper face is z=0, matching saved two-layer Palace models.
  const bottom = stackup.layers.at(-1)
  if (!bottom || !("name" in bottom) || bottom.name !== "bottom")
    throw new Error("Stackup must end with bottom copper")
  let z = -bottom.copperThicknessMm
  for (let index = stackup.layers.length - 1; index >= 0; index--) {
    const layer = stackup.layers[index]
    if (index % 2 === 0) {
      if (!("name" in layer) || layer.name !== expected[index / 2])
        throw new Error(`Stackup copper order must be ${expected.join(", ")}`)
      const thickness = positiveFinite(
        layer.copperThicknessMm,
        "copper thickness",
      )
      copperLayers.unshift({ name: layer.name, zMin: z, zMax: z + thickness })
      z += thickness
    } else {
      if (!("material" in layer))
        throw new Error("A dielectric is required between copper layers")
      dielectrics.push({
        material: layer.material,
        zMin: z,
        zMax: z + layer.dielectricThicknessMm,
        dielectricConstant: layer.dielectricConstant,
        lossTangent: layer.lossTangent ?? options.lossTangent,
        attribute: 100 + index,
      })
      z += layer.dielectricThicknessMm
    }
  }
  return {
    copperLayers,
    dielectrics,
    physicalThicknessMm: z + bottom.copperThicknessMm,
    nominalBoardThicknessMm: stackup.nominalBoardThicknessMm,
  }
}
