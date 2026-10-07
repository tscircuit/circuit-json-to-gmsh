import { any_circuit_element } from "circuit-json"
import { z } from "zod"
import type { CircuitJson } from "./types"

const geometryTypes = new Set([
  "pcb_board",
  "pcb_trace",
  "pcb_via",
  "pcb_hole",
  "pcb_plated_hole",
  "pcb_smtpad",
  "pcb_copper_pour",
  "pcb_ground_plane",
  "pcb_ground_plane_region",
  "pcb_cutout",
  "pcb_port",
  "source_net",
  "source_port",
  "source_trace",
  "source_component",
])

/** Validate physical and connectivity elements; display and simulation metadata are ignored. */
export function parseCircuitJson(input: unknown): CircuitJson {
  const elements = z
    .array(z.object({ type: z.string() }).passthrough())
    .parse(input)
  return elements
    .filter((e) => geometryTypes.has(e.type))
    .map((element) => {
      const normalized = { ...element }
      if (element.type === "pcb_board") {
        for (const key of ["display_offset_x", "display_offset_y"])
          if (typeof element[key] === "number")
            normalized[key] = String(element[key])
      }
      if (element.type === "pcb_hole" && element.pcb_component_id === null)
        normalized.pcb_component_id = undefined
      if (
        element.type === "pcb_plated_hole" &&
        element.shape === "circular_hole_with_rect_pad"
      ) {
        normalized.hole_shape = element.hole_shape ?? "circle"
        normalized.pad_shape = element.pad_shape ?? "rect"
      }
      return any_circuit_element.parse(normalized)
    })
}
