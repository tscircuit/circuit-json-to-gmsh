import { useState } from "react"
import copper from "../examples/four-layer/copper.png"
import cutaway from "../examples/four-layer/cutaway.png"
import section from "../examples/four-layer/cross-section.png"

const views = [
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
      <p>Native PCB geometry and PoppyGL snapshots from a TSX circuit.</p>
      <nav style={{ display: "flex", gap: 12 }}>
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
        Orange: copper. Green: dielectric. Exported CAD and mesh retain physical
        millimetres.
      </p>
    </main>
  )
}
