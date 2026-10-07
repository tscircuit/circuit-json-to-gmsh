import type { FabricationStackup } from "lib/index"

export const pinchedHoleStackup: FabricationStackup = {
  layers: [
    { name: "top", copperThicknessMm: 0.035 },
    { material: "FR4", dielectricThicknessMm: 0.8, dielectricConstant: 4.3 },
    { name: "bottom", copperThicknessMm: 0.035 },
  ],
}

/** Reproduces AM3352 U1.VSS_OSC_V11 → pcb_via_83 via pcb_trace_105.
 * The trace's horizontal lower edge is tangent to the via pad at (7.55,1.15).
 */
export function PinchedHoleBoard() {
  return (
    <board width={18} height={4} layers={2} schematicDisabled>
      <net name="GND" />
      <chip
        name="U1"
        pcbX={6.8}
        pcbY={1.2}
        pinLabels={{ pin1: "VSS_OSC_V11" }}
        footprint={
          <footprint>
            <smtpad portHints={["pin1"]} shape="circle" radius={0.2} />
          </footprint>
        }
      />
      <chip
        name="V1"
        pcbX={7.55}
        pcbY={1}
        pinLabels={{ pin1: "GND" }}
        footprint={
          <footprint>
            <smtpad portHints={["pin1"]} shape="circle" radius={0.15} />
          </footprint>
        }
      />
      <trace
        from=".U1 > .VSS_OSC_V11"
        to=".V1 > .GND"
        thickness={0.1}
        pcbPathRelativeTo=".U1 > .VSS_OSC_V11"
        pcbPath={[
          { x: 0, y: 0 },
          { x: 1.1, y: 0 },
          { x: 0.75, y: -0.2 },
        ]}
      />
      <trace from=".V1 > .GND" to="net.GND" />
      <via
        name="GV83"
        pcbX={7.55}
        pcbY={1}
        fromLayer="top"
        toLayer="bottom"
        holeDiameter={0.15}
        outerDiameter={0.3}
        connectsTo="net.GND"
      />
    </board>
  )
}
