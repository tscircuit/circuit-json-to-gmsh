import { Fragment } from "react"

/** Compact DQS-style regression: route transitions use inner1, while the physical
 * signal barrels continue through all four copper layers and retain their stubs. */
export function DifferentialViasBoard() {
  return (
    <board
      width={8}
      height={6}
      layers={4}
      schematicDisabled
      pcbStyle={{ viaPadDiameter: 0.3, viaHoleDiameter: 0.15 }}
    >
      <net name="GND" />
      <net name="DQS_P" />
      <net name="DQS_N" />
      {[-2, 2].map((x, i) => (
        <chip
          key={i}
          name={`U${i + 1}`}
          pcbX={x}
          pcbY={0}
          pinLabels={
            i === 0 ? { pin1: "P1", pin2: "P2" } : { pin1: "F3", pin2: "G3" }
          }
          footprint={
            <footprint>
              <smtpad
                portHints={["pin1"]}
                pcbY={0.4}
                radius={0.2}
                shape="circle"
              />
              <smtpad
                portHints={["pin2"]}
                pcbY={-0.4}
                radius={0.2}
                shape="circle"
              />
            </footprint>
          }
        />
      ))}
      {[0.4, -0.4].map((y, i) => (
        <Fragment key={i}>
          <trace
            from={`.U1 > .P${i + 1}`}
            to={`.U2 > .${i === 0 ? "F3" : "G3"}`}
            thickness={0.1}
            pcbPathRelativeTo={`.U1 > .P${i + 1}`}
            pcbPath={[
              { x: 0, y },
              { x: 1, y, via: true, fromLayer: "top", toLayer: "inner1" },
              { x: 3, y, via: true, fromLayer: "inner1", toLayer: "top" },
              { x: 4, y },
            ]}
          />
        </Fragment>
      ))}
      <trace from=".U1 > .P1" to="net.DQS_P" />
      <trace from=".U1 > .P2" to="net.DQS_N" />
      {[-1, 1].flatMap((x) =>
        [0.4, -0.4].map((y, i) => (
          <Fragment key={`${x}/${y}`}>
            <via
              name={`SV${x < 0 ? 1 : 2}${i + 1}`}
              pcbX={x}
              pcbY={y}
              fromLayer="top"
              toLayer="bottom"
              holeDiameter={0.15}
              outerDiameter={0.3}
              connectsTo={`net.DQS_${i === 0 ? "P" : "N"}`}
            />
          </Fragment>
        )),
      )}
      <copperpour
        layer="bottom"
        connectsTo="net.GND"
        boardEdgeMargin={0}
        padMargin={0.1}
        traceMargin={0.1}
      />
    </board>
  )
}
