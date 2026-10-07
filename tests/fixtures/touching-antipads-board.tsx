/** Diagonal foreign-net antipads touch at one corner, as on the AM3352 bottom plane. */
export function TouchingAntipadsBoard() {
  return (
    <board width={3} height={3} layers={2} schematicDisabled>
      <net name="GND" />
      <net name="SIG1" />
      <net name="SIG2" />
      <via
        name="V1"
        pcbX={0}
        pcbY={0}
        fromLayer="top"
        toLayer="bottom"
        holeDiameter={0.15}
        outerDiameter={0.3}
        connectsTo="net.SIG1"
      />
      <via
        name="V2"
        pcbX={0.5}
        pcbY={0.5}
        fromLayer="top"
        toLayer="bottom"
        holeDiameter={0.15}
        outerDiameter={0.3}
        connectsTo="net.SIG2"
      />
      <copperpour
        layer="bottom"
        connectsTo="net.GND"
        boardEdgeMargin={0}
        padMargin={0.13}
        traceMargin={0.13}
      />
    </board>
  )
}
