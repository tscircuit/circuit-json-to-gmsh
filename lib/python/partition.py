"""Partition only z-neighbouring slabs; retain OCC history for material owners."""

import json
import time
from pathlib import Path
import gmsh


def fragment(solids):
    if len(solids) < 2:
        return
    entities = [entity for solid in solids for entity in solid["entities"]]
    if len(entities) < 2:
        return
    _, mapping = gmsh.model.occ.fragment(entities[:1], entities[1:])
    cursor = 0
    for solid in solids:
        count = len(solid["entities"])
        solid["entities"] = sorted(
            {
                tuple(e)
                for children in mapping[cursor : cursor + count]
                for e in children
                if e[0] == 3
            }
        )
        cursor += count


def partition(options):
    solids = options["solids"]
    if options["strategy"] == "global":
        fragment(solids)
        return
    started = time.monotonic()
    slabs = {}
    for solid in solids:
        slabs.setdefault((solid["zMin"], solid["zMax"]), []).append(solid)
    ordered = sorted(slabs)
    paired = set()
    for lower, upper in zip(ordered, ordered[1:]):
        if abs(lower[1] - upper[0]) > 1e-9:
            continue
        selected = [*slabs[lower], *slabs[upper]]
        paired.update([lower, upper])
        Path(options["progressPath"]).write_text(
            json.dumps(
                {
                    "stage": "partition_slab_interface",
                    "zMm": lower[1],
                    "solids": len(selected),
                    "partitionSeconds": time.monotonic() - started,
                }
            )
        )
        fragment(selected)
    # Each pair operation also partitions vertical interfaces within its slabs.
    # Only a slab without a z neighbour needs a separate within-slab operation.
    for span in set(ordered) - paired:
        fragment(slabs[span])
