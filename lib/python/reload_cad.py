"""Rebuild Gmsh's model after many OCC mutations, preserving volume ownership.

Gmsh 4.13.1 can otherwise emit zero node references on a multi-cell assembly.
Independent BRep reload avoids that stale model state; it does not repair CAD.
"""

import json
from pathlib import Path
import gmsh
import numpy as np
from tile_worker import fingerprint


def reload_cad(solids, destination):
    destination = Path(destination)
    for solid in solids:
        solid["fingerprints"] = [fingerprint(t) for _, t in solid["entities"]]
    gmsh.write(str(destination / "cad-checkpoint.brep"))
    (destination / "cad-checkpoint.json").write_text(json.dumps(solids))
    gmsh.clear()
    gmsh.model.add("pcb-reloaded")
    import_owned_cad(destination / "cad-checkpoint.brep", solids)


def import_owned_cad(brep, solids):
    entities = gmsh.model.occ.importShapes(str(brep), highestDimOnly=True)
    tags = [t for d, t in entities if d == 3]
    actual = np.array([fingerprint(t) for t in tags])
    used = set()
    for solid in solids:
        restored = []
        for expected in solid.pop("fingerprints"):
            matches = np.flatnonzero(
                np.all(np.isclose(actual, expected, rtol=1e-7, atol=2e-6), axis=1)
            )
            matches = [int(k) for k in matches if int(k) not in used]
            if len(matches) != 1:
                raise ValueError("Ambiguous/lost material ownership on CAD reload")
            used.add(matches[0])
            restored.append((3, tags[matches[0]]))
        solid["entities"] = restored
    if len(used) != len(tags):
        raise ValueError("Unowned CAD volume after reload")
    gmsh.model.occ.synchronize()


def check_node_references():
    node_tags = set(map(int, gmsh.model.mesh.getNodes()[0]))
    for kind, _, connectivity in zip(*gmsh.model.mesh.getElements()):
        missing = sorted(set(map(int, connectivity)) - node_tags)
        if missing:
            raise ValueError(
                f"Native element type {kind} references missing mesh nodes: {missing[:20]}"
            )
