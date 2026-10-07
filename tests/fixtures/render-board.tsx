import { Circuit } from "@tscircuit/core"
import { createGeometryModel, parseCircuitJson } from "lib/index"
import { MultilayerBoard, fourLayerStackup } from "./multilayer-board"

export async function renderBoard() {
  const circuit = new Circuit()
  circuit.add(<MultilayerBoard innerPlane />)
  await circuit.renderUntilSettled()
  const circuitJson = parseCircuitJson(circuit.getCircuitJson())
  return {
    circuitJson,
    model: createGeometryModel({ circuitJson, stackup: fourLayerStackup }),
  }
}
