"""One isolated OCC process per CAD batch; materials survive BRep reload."""

import argparse
import hashlib
import json
import time
from pathlib import Path
import gmsh
from shapely.geometry import shape
from cad import build_cad
from partition import partition


def fingerprint(tag):
    return [
        gmsh.model.occ.getMass(3, tag),
        *gmsh.model.occ.getCenterOfMass(3, tag),
        *gmsh.model.occ.getBoundingBox(3, tag),
    ]


def run(job_path, output):
    started = time.monotonic()
    job = json.loads(job_path.read_text())
    options = job["options"]
    options["board"] = shape(job["board"])
    options["copper"] = {
        layer: {n: shape(s) for n, s in groups.items()}
        for layer, groups in job["copper"].items()
    }
    options["progressPath"] = str(output / "progress.json")
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 1)
    gmsh.option.setNumber("General.NumThreads", 1)
    gmsh.option.setNumber("Geometry.Tolerance", 1e-6)
    gmsh.option.setNumber("Geometry.ToleranceBoolean", 1e-6)
    gmsh.model.add("tile")
    try:
        solids = build_cad(options)
        partition(
            {
                "solids": solids,
                "strategy": "slab",
                "progressPath": options["progressPath"],
            }
        )
        gmsh.model.occ.synchronize()
        owners = {}
        for solid in solids:
            for _, tag in solid["entities"]:
                if tag in owners and owners[tag] != solid["name"]:
                    raise ValueError(
                        f"Native volume {tag} assigned to {owners[tag]} and {solid['name']}"
                    )
                owners[tag] = solid["name"]
        gmsh.write(str(output / "tile.brep"))
        for solid in solids:
            solid["fingerprints"] = [fingerprint(t) for _, t in solid["entities"]]
        (output / "solids.json").write_text(json.dumps(solids))
        (output / "complete.json").write_text(
            json.dumps(
                {
                    "jobSha256": job["jobSha256"],
                    "gmshVersion": gmsh.__version__,
                    "brepSha256": hashlib.sha256(
                        (output / "tile.brep").read_bytes()
                    ).hexdigest(),
                    "solidsSha256": hashlib.sha256(
                        (output / "solids.json").read_bytes()
                    ).hexdigest(),
                    "seconds": time.monotonic() - started,
                }
            )
        )
    finally:
        gmsh.finalize()


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--job", required=True)
    p.add_argument("--output", required=True)
    a = p.parse_args()
    run(Path(a.job), Path(a.output))
