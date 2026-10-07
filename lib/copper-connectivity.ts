import type { CircuitJson } from "./types"

type ConnectivityId = string
type PcbPortId = string
type PcbTraceId = string

/** One union/find pass over source connectivity, including unnamed point-to-point nets. */
export function copperConnectivity(circuitJson: CircuitJson) {
  const parents = new Map<ConnectivityId, ConnectivityId>()
  const find = (id: ConnectivityId): ConnectivityId => {
    const parent = parents.get(id)
    if (!parent) {
      parents.set(id, id)
      return id
    }
    if (parent === id) return id
    const root = find(parent)
    parents.set(id, root)
    return root
  }
  for (const element of circuitJson) {
    if (element.type !== "source_trace") continue
    const ids = [
      element.source_trace_id,
      ...element.connected_source_net_ids,
      ...element.connected_source_port_ids,
    ]
    for (const id of ids) parents.set(find(id), find(ids[0]))
  }
  // Prefer stable source_net IDs for groups that have a named net.
  const netIds = new Map<ConnectivityId, string>()
  for (const element of circuitJson)
    if (element.type === "source_net") {
      const root = find(element.source_net_id)
      const existing = netIds.get(root)
      if (existing && existing !== element.source_net_id)
        throw new Error(
          `Source connectivity joins distinct nets ${existing} and ${element.source_net_id}`,
        )
      netIds.set(root, element.source_net_id)
    }
  const owner = (id: string) => netIds.get(find(id)) ?? find(id)
  const pcbPorts = new Map<PcbPortId, string>()
  const pcbTraces = new Map<PcbTraceId, string>()
  for (const element of circuitJson) {
    if (element.type === "pcb_port")
      pcbPorts.set(element.pcb_port_id, owner(element.source_port_id))
    if (element.type === "pcb_trace")
      pcbTraces.set(
        element.pcb_trace_id,
        owner(element.source_trace_id ?? element.pcb_trace_id),
      )
  }
  return { owner, pcbPorts, pcbTraces }
}
