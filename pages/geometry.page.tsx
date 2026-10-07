import { useState } from "react"
import copper from "../examples/four-layer/copper.png"
import cutaway from "../examples/four-layer/cutaway.png"
import section from "../examples/four-layer/cross-section.png"
import differentialSection from "../tests/__snapshots__/differential-via-cross-section.png"
import differentialStubs from "../tests/__snapshots__/differential-via-stubs.png"
import boardCutout from "../tests/__snapshots__/mesh-board-cutout.png"
import am3352Copper from "../examples/am3352/mesh-validation/dqs-source-vias-corrected/copper-only.png"
import am3352Dqs from "../examples/am3352/mesh-validation/dqs-source-vias-corrected/dqs-copper-only.png"
import am3352Cutaway from "../examples/am3352/mesh-validation/dqs-source-vias-corrected/copper-cutaway.png"
import am3352PadCrop from "../examples/am3352/palace-channel/pad-crop/actual-copper-tile.png"

const views = [
  {
    label: "AM3352 copper",
    image: am3352Copper,
    description:
      "Actual AM3352 source-via crop with substrate hidden and every copper net retained. Red: DQS0. Cyan: DQSn0. Other copper is brown/gold. Thickness at 3×.",
  },
  {
    label: "AM3352 DQS",
    image: am3352Dqs,
    description:
      "The actual DQS0/DQSn0 copper in the same crop, with other nets hidden to inspect the transitions and lower via stubs. Thickness at 3×.",
  },
  {
    label: "AM3352 cutaway",
    image: am3352Cutaway,
    description:
      "Actual native CAD cut at x = 2.7 mm through the DQS0 source via. Substrate hidden; the hollow barrel is exposed. Thickness at 3×.",
  },
  {
    label: "AM3352 pad crop",
    image: am3352PadCrop,
    description:
      "Actual AM3352 native CAD tile around via 230 after preserving whole pads at the analysis boundary. Substrate hidden, physical thickness at 1×. Green: DDR_1V5; blue-gray: GND. Geometry only, not an EM field or complete-route validation.",
  },
  {
    label: "Board cutout",
    image: boardCutout,
    description:
      "TSX-generated cutout through all four layers. The saved-mesh validator rejects a tetrahedron inserted into this opening. Thickness at 4×.",
  },
  {
    label: "DQS via stubs",
    image: differentialStubs,
    description:
      "Two independent signal nets with full through-via spans and retained lower-layer stubs. Thickness at 4×.",
  },
  {
    label: "DQS cross-section",
    image: differentialSection,
    description:
      "Native four-layer section through two hollow signal barrels. Saved-mesh validation checks their copper paths and voids. Thickness at 4×.",
  },
  {
    label: "Copper",
    image: copper,
    description:
      "Four physical copper layers and plated barrels. Thickness shown at 3×.",
  },
  {
    label: "Cutaway",
    image: cutaway,
    description: "Native CAD cut at x = 2 mm. Thickness shown at 4×.",
  },
  {
    label: "Cross-section",
    image: section,
    description:
      "Only Gmsh faces on x = 2 mm. Hollow drills and copper walls; thickness shown at 4×.",
  },
]

export default function GeometryPage() {
  const [selected, setSelected] = useState(0)
  const view = views[selected]
  return (
    <main
      style={{
        fontFamily: "system-ui",
        maxWidth: 1000,
        margin: "32px auto",
        padding: 24,
      }}
    >
      <h1>Circuit JSON → Gmsh</h1>
      <p>
        Native PCB geometry rendered with PoppyGL: actual AM3352 copper and TSX
        regression fixtures.
      </p>
      <nav style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {views.map((v, i) => (
          <button
            key={v.label}
            onClick={() => setSelected(i)}
            aria-pressed={selected === i}
          >
            {v.label}
          </button>
        ))}
      </nav>
      <p>{view.description}</p>
      <img src={view.image} alt={view.description} style={{ width: "100%" }} />
      <p>
        Colors and displayed thickness are described for each view. Exported CAD
        and mesh retain physical millimetres.
      </p>
    </main>
  )
}
