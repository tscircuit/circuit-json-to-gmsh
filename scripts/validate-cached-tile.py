"""Mesh one hash-verified CAD tile before an expensive complete-route join.

This does not validate cross-tile conformity, complete-route terminal paths or
EM accuracy. The assembled PCB must still pass its independent saved-mesh gates.
"""

import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib/python"))
import gmsh
from reload_cad import import_owned_cad, check_node_references
from mesh_manifest import mesh_manifest


def file_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(a):
    a.output.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    result = {"schemaVersion": 1, "passed": False, "completeRouteValidated": False}
    initialized = False
    try:
        receipt = json.loads((a.tile / "complete.json").read_text())
        job = json.loads((a.tile / "job.json").read_text())
        digest = job.pop("jobSha256")
        actual = hashlib.sha256(json.dumps(job, sort_keys=True).encode()).hexdigest()
        if digest != actual or digest != receipt["jobSha256"]:
            raise ValueError("Cached tile job hash mismatch")
        for name, key in [("tile.brep", "brepSha256"), ("solids.json", "solidsSha256")]:
            if file_hash(a.tile / name) != receipt[key]:
                raise ValueError(f"Cached tile {name} hash mismatch")
        if receipt["gmshVersion"] != gmsh.__version__:
            raise ValueError("Cached tile Gmsh version mismatch")
        result.update(
            {
                "jobSha256": digest,
                "brepSha256": receipt["brepSha256"],
                "solidsSha256": receipt["solidsSha256"],
                "boundsMm": job["options"]["boundsMm"],
                "modelSha256": file_hash(a.model),
                "meshSizeMm": a.mesh_size,
            }
        )
        if a.check_brep:
            from validate_brep import validate

            result["brepValidation"] = validate(str(a.tile / "tile.brep"))
            if not result["brepValidation"]["valid"]:
                raise ValueError("Cached tile BRep is invalid")
        gmsh.initialize()
        initialized = True
        for key, value in [
            ("General.NumThreads", 1),
            ("Geometry.Tolerance", 1e-6),
            ("Geometry.ToleranceBoolean", 1e-6),
        ]:
            gmsh.option.setNumber(key, value)
        solids = json.loads((a.tile / "solids.json").read_text())
        import_owned_cad(a.tile / "tile.brep", solids)
        groups = {}
        expected_total, actual_total = 0.0, 0.0
        differences = []
        for solid in solids:
            volume = sum(gmsh.model.occ.getMass(*e) for e in solid["entities"])
            expected = solid["expectedVolumeMm3"]
            expected_total += expected
            actual_total += volume
            differences.append(
                {
                    "id": solid["id"],
                    "material": solid["material"],
                    "expectedVolumeMm3": expected,
                    "actualVolumeMm3": volume,
                    "differenceMm3": volume - expected,
                }
            )
            groups.setdefault(solid["name"], set()).update(
                t for _, t in solid["entities"]
            )
        # Apply the existing complete-export mass criterion to each tile.
        # Record individual differences rather than assigning the same relative
        # threshold to a nanometre-sized fragment and to the whole assembly.
        maximum_difference = max(1e-9, expected_total * 1e-7)
        result["cadVolumeValidation"] = {
            "expectedVolumeMm3": expected_total,
            "actualVolumeMm3": actual_total,
            "maximumDifferenceMm3": maximum_difference,
            "solids": differences,
        }
        if abs(actual_total - expected_total) > maximum_difference:
            raise ValueError("Cached tile changed total material volume")
        for attribute, (name, tags) in enumerate(sorted(groups.items()), 1):
            gmsh.model.addPhysicalGroup(3, sorted(tags), attribute, name)
        manifest = a.output / "mesh-manifest.json"
        manifest.write_text(json.dumps(mesh_manifest(solids), indent=2))
        for key, value in [
            ("Mesh.MeshSizeMin", a.mesh_size),
            ("Mesh.MeshSizeMax", a.mesh_size),
            ("Mesh.MeshSizeFromCurvature", 0),
            ("Mesh.MeshSizeExtendFromBoundary", 0),
            ("Mesh.Algorithm", 6),
            ("Mesh.ElementOrder", 1),
        ]:
            gmsh.option.setNumber(key, value)
        gmsh.model.mesh.generate(3)
        gmsh.model.mesh.optimize("Netgen")
        check_node_references()
        gmsh.option.setNumber("Mesh.MshFileVersion", 2.2)
        mesh = a.output / "board.msh"
        gmsh.write(str(mesh))
        gmsh.finalize()
        initialized = False
        report = a.output / "validation.json"
        subprocess.run(
            [
                sys.executable,
                str(
                    Path(__file__).resolve().parents[1] / "lib/python/validate_mesh.py"
                ),
                "--mesh",
                str(mesh),
                "--manifest",
                str(manifest),
                "--model",
                str(a.model),
                "--minimum-quality",
                str(a.minimum_quality),
                "--output",
                str(report),
            ],
            check=True,
        )
        validation = json.loads(report.read_text())
        result["validation"] = validation
        result["passed"] = validation["passed"] and all(
            c["passed"] is True
            for c in validation["checks"]
            if c["name"] != "terminal_connectivity"
        )
    except Exception as error:
        result["error"] = str(error)
    finally:
        if initialized:
            gmsh.finalize()
    result["wallSeconds"] = time.monotonic() - started
    (a.output / "preflight.json").write_text(json.dumps(result, indent=2) + "\n")
    print(
        json.dumps(
            {k: result[k] for k in ["passed", "completeRouteValidated", "wallSeconds"]}
        )
    )
    return result["passed"]


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--tile", type=Path, required=True)
    p.add_argument("--model", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--mesh-size", type=float, default=0.4)
    p.add_argument("--minimum-quality", type=float, default=0)
    p.add_argument("--check-brep", action="store_true")
    args = p.parse_args()
    if args.mesh_size <= 0 or not 0 <= args.minimum_quality <= 1:
        p.error("Mesh size must be positive; minimum quality must be in [0, 1]")
    sys.exit(0 if run(args) else 1)
