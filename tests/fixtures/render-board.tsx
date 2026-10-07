import { Circuit } from "@tscircuit/core"
import { createGeometryModel, parseCircuitJson } from "lib/index"
import { MultilayerBoard, fourLayerStackup } from "./multilayer-board"

export async function renderBoard(
  options: {
    cutout?: boolean
    portObstruction?: boolean
    cropBoundaryCopper?: boolean
  } = {},
) {
  const circuit = new Circuit()
  circuit.add(
    <MultilayerBoard
      innerPlane
      cutout={options.cutout}
      portObstruction={options.portObstruction}
      cropBoundaryCopper={options.cropBoundaryCopper}
    />,
  )
  await circuit.renderUntilSettled()
  const circuitJson = parseCircuitJson(circuit.getCircuitJson())
  return {
    circuitJson,
    model: createGeometryModel({ circuitJson, stackup: fourLayerStackup }),
  }
}
