import { Fragment } from "react"
import type { FabricationStackup } from "lib/index"

export const fourLayerStackup: FabricationStackup = {
  nominalBoardThicknessMm: 0.975,
  layers: [
    { name: "top", copperThicknessMm: 0.035 },
    {
      material: "prepreg",
      dielectricThicknessMm: 0.2,
      dielectricConstant: 4.1,
    },
    { name: "inner1", copperThicknessMm: 0.015 },
    {
      material: "core",
      dielectricThicknessMm: 0.475,
      dielectricConstant: 4.42,
    },
    { name: "inner2", copperThicknessMm: 0.015 },
    {
      material: "prepreg",
      dielectricThicknessMm: 0.2,
      dielectricConstant: 4.1,
    },
    { name: "bottom", copperThicknessMm: 0.035 },
  ],
}

/** Core emits routed blind vias, ground through vias and circular BGA-style pads. */
export function MultilayerBoard({
  innerPlane = false,
  layers = 4,
  sourceLayer = "top",
  referenceLayer = "top",
  cutout = false,
  portObstruction = false,
  cropBoundaryCopper = false,
  referenceOffsetXMm = 0,
}: {
  innerPlane?: boolean
  layers?: 4 | 6
  referenceLayer?: "top" | "inner2"
  sourceLayer?: "top" | "bottom"
  cutout?: boolean
  portObstruction?: boolean
  cropBoundaryCopper?: boolean
  referenceOffsetXMm?: number
}) {
  return (
    <board
      width={8}
      height={6}
      layers={layers}
      thickness={0.975}
      schematicDisabled
    >
      <net name="GND" />
      {cropBoundaryCopper && (
        <>
          <net name="FLOAT" />
          {[
            [0, -1.5, 0.1, -1.4],
            [3, -1.5, 3.2, -1.4],
          ].map(([x0, y0, x1, y1], index) => (
            <Fragment key={index}>
              <copperpour
                layer="top"
                connectsTo="net.FLOAT"
                outline={[
                  { x: x0!, y: y0! },
                  { x: x1!, y: y0! },
                  { x: x1!, y: y1! },
                  { x: x0!, y: y1! },
                ]}
                boardEdgeMargin={0}
                traceMargin={0}
                padMargin={0}
              />
            </Fragment>
          ))}
        </>
      )}
      {portObstruction && (
        <chip
          name="U3"
          pcbX={-1.965}
          pcbY={0.75}
          pinLabels={{ pin1: "FLOAT" }}
          footprint={
            <footprint>
              <smtpad
                portHints={["pin1"]}
                shape="rect"
                width={0.04}
                height={0.2}
              />
            </footprint>
          }
        />
      )}
      {cutout && (
        <cutout shape="rect" pcbX={0} pcbY={-1.5} width={0.8} height={0.8} />
      )}
      {[-2, 2].map((x, index) => (
        <chip
          key={index}
          name={`U${index + 1}`}
          pcbX={x}
          pcbY={0}
          pinLabels={{ pin1: index === 0 ? "OUT" : "IN", pin2: "GND" }}
          footprint={
            <footprint>
              <smtpad
                portHints={["pin1"]}
                pcbX={0}
                pcbY={0}
                layer={index === 0 ? sourceLayer : "top"}
                radius={0.4}
                shape="circle"
              />
              <smtpad
                portHints={["pin2"]}
                pcbX={referenceOffsetXMm}
                pcbY={1.5}
                layer={referenceLayer}
                width={0.8}
                height={0.8}
                shape="rect"
              />
            </footprint>
          }
        />
      ))}
      <trace
        from=".U1 > .OUT"
        to=".U2 > .IN"
        thickness={0.18}
        pcbPathRelativeTo=".U1 > .OUT"
        pcbPath={[
          { x: 0, y: 0 },
          { x: 1, y: 0, via: true, fromLayer: sourceLayer, toLayer: "inner1" },
          { x: 3, y: 0, via: true, fromLayer: "inner1", toLayer: "top" },
          { x: 4, y: 0 },
        ]}
      />
      <trace from=".U1 > .GND" to="net.GND" />
      <trace from=".U2 > .GND" to="net.GND" />
      {[-2, 2].map((x, index) => (
        <Fragment key={index}>
          <via
            name={`GV${index + 1}`}
            pcbX={x + referenceOffsetXMm}
            pcbY={referenceLayer === "inner2" ? 1.8 : 1.5}
            fromLayer="top"
            toLayer="bottom"
            connectsTo="net.GND"
            holeDiameter={0.2}
            outerDiameter={0.6}
          />
        </Fragment>
      ))}
      <copperpour
        layer="bottom"
        connectsTo="net.GND"
        boardEdgeMargin={0}
        padMargin={0}
        traceMargin={0}
      />
      {innerPlane && (
        <copperpour
          layer="inner2"
          connectsTo="net.GND"
          boardEdgeMargin={0}
          padMargin={0}
          traceMargin={0}
        />
      )}
    </board>
  )
}
