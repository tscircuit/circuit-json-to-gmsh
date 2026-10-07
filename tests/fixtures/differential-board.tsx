import { Fragment } from "react"
import { Circuit } from "@tscircuit/core"
import { createGeometryModel, parseCircuitJson } from "lib/index"
import { fourLayerStackup } from "./multilayer-board"

/** Symmetric four-port field control; independent of AM3352 routing. */
export async function renderDifferentialBoard() {
  const circuit = new Circuit()
  circuit.add(
    <board width={4} height={3} layers={4} thickness={0.975} schematicDisabled>
      <net name="GND" />
      {[1, -1].flatMap((sign, pair) =>
        [-1.5, 1.5].map((x, end) => {
          const name = `U${pair * 2 + end + 1}`
          return (
            <chip
              key={name}
              name={name}
              pcbX={x}
              pcbY={sign * 0.55}
              pinLabels={{ pin1: end === 0 ? "OUT" : "IN", pin2: "GND" }}
              footprint={
                <footprint>
                  <smtpad
                    portHints={["pin1"]}
                    shape="rect"
                    width={0.3}
                    height={0.3}
                  />
                  <smtpad
                    portHints={["pin2"]}
                    pcbY={sign * 0.65}
                    shape="rect"
                    width={0.4}
                    height={0.4}
                  />
                </footprint>
              }
            />
          )
        }),
      )}
      {[0, 1].map((pair) => (
        <Fragment key={pair}>
          <trace
            from={`.U${pair * 2 + 1} > .OUT`}
            to={`.U${pair * 2 + 2} > .IN`}
            thickness={0.15}
            pcbPathRelativeTo={`.U${pair * 2 + 1} > .OUT`}
            pcbPath={[
              { x: 0, y: 0 },
              { x: 3, y: 0 },
            ]}
          />
        </Fragment>
      ))}
      {[1, 2, 3, 4].map((index) => (
        <Fragment key={index}>
          <trace from={`.U${index} > .GND`} to="net.GND" />
        </Fragment>
      ))}
      {[1, -1].flatMap((sign) =>
        [-1.5, 1.5].map((x) => (
          <Fragment key={`${sign}/${x}`}>
            <via
              pcbX={x}
              pcbY={sign * 1.2}
              fromLayer="top"
              toLayer="bottom"
              connectsTo="net.GND"
              holeDiameter={0.2}
              outerDiameter={0.4}
            />
          </Fragment>
        )),
      )}
      <copperpour
        layer="inner1"
        connectsTo="net.GND"
        boardEdgeMargin={0}
        padMargin={0}
        traceMargin={0}
      />
      <copperpour
        layer="bottom"
        connectsTo="net.GND"
        boardEdgeMargin={0}
        padMargin={0}
        traceMargin={0}
      />
    </board>,
  )
  await circuit.renderUntilSettled()
  const circuitJson = parseCircuitJson(circuit.getCircuitJson())
  return {
    circuitJson,
    model: createGeometryModel({ circuitJson, stackup: fourLayerStackup }),
  }
}
