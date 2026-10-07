"""Reload an exported MSH: do not trust the mesher's success exit code."""

import argparse
import hashlib
import json
import time
from pathlib import Path
import gmsh
import numpy as np
from mesh_topology import (
    read_tetrahedra,
    physical_ownership,
    face_incidence,
    boundary_checks,
    copper_components,
)
from mesh_geometry import void_intersections, terminal_checks


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest() if path else None


def progress(stage, context):
    Path(context["output"]).with_name("validation-progress.json").write_text(
        json.dumps(
            {"stage": stage, "elapsedSeconds": time.monotonic() - context["started"]}
        )
    )


def validation(options):
    started = time.monotonic()
    context = {"output": options.output, "started": started}
    progress("read_tetrahedra", context)
    mesh = read_tetrahedra()
    manifest = (
        json.loads(Path(options.manifest).read_text()) if options.manifest else {}
    )
    model = json.loads(Path(options.model).read_text()) if options.model else None
    requirements = (
        json.loads(Path(options.requirements).read_text())
        if options.requirements
        else {}
    )
    ownership, owner_errors = physical_ownership(manifest)
    checks = []
    checks.append(
        {
            "name": "linear_tetrahedra",
            "passed": len(mesh["tags"]) > 0 and not mesh["unsupported"],
            "tetrahedra": len(mesh["tags"]),
            "unsupportedTypes": mesh["unsupported"],
        }
    )
    checks.append(
        {
            "name": "material_ownership",
            "passed": not owner_errors,
            "errors": owner_errors[:20],
        }
    )
    coordinates = mesh["coordinates"]
    progress("element_quality_and_volume", context)
    signed_volumes = np.linalg.det(coordinates[:, 1:] - coordinates[:, :1]) / 6
    qualities = np.asarray(gmsh.model.mesh.getElementQualities(mesh["tags"], "minSICN"))
    positive = len(qualities) > 0 and bool(
        np.all(np.isfinite(qualities))
        and np.all(qualities > options.minimum_quality)
        and np.all(signed_volumes > 0)
    )
    quality = {
        "minimum": float(np.min(qualities)) if len(qualities) else None,
        "percentile01": float(np.percentile(qualities, 1)) if len(qualities) else None,
        "median": float(np.median(qualities)) if len(qualities) else None,
        "threshold": options.minimum_quality,
        "worstElements": [
            {
                "tag": int(mesh["tags"][i]),
                "volume": int(mesh["volumes"][i]),
                "material": ownership.get(int(mesh["volumes"][i])),
                "minSICN": float(qualities[i]),
                "coordinatesMm": coordinates[i].tolist(),
            }
            for i in np.argsort(qualities)[:5]
        ],
    }
    checks.append(
        {
            "name": "positive_tetrahedra",
            "passed": positive,
            **quality,
            "invertedOrDegenerate": int(np.sum(signed_volumes <= 0)),
            "belowQualityThreshold": int(np.sum(qualities <= options.minimum_quality)),
        }
    )
    mass_errors = []
    for volume in manifest.get("volumes", []):
        actual = float(np.sum(signed_volumes[mesh["volumes"] == volume["tag"]]))
        expected = volume["volumeMm3"]
        if abs(actual - expected) > max(1e-9, abs(expected) * 1e-6):
            mass_errors.append(
                {"volume": volume["tag"], "expectedMm3": expected, "actualMm3": actual}
            )
    checks.append(
        {
            "name": "cad_volume_coverage",
            "passed": not mass_errors if manifest else None,
            "errors": mass_errors[:20],
        }
    )
    progress("face_incidence_and_interfaces", context)
    incidence = face_incidence(mesh)
    checks.append(
        {
            "name": "manifold_tetrahedron_faces",
            "passed": bool(np.all(incidence["counts"] <= 2)),
            "nonmanifoldFaces": int(np.sum(incidence["counts"] > 2)),
        }
    )
    boundaries = boundary_checks(mesh, incidence, manifest)
    checks.append(
        {
            "name": "conformal_interfaces",
            "passed": not boundaries,
            "cadOwnershipChecked": bool(manifest),
            "errors": boundaries[:20],
        }
    )
    progress("copper_components", context)
    components, net_components, shorts = copper_components(mesh, incidence, ownership)
    checks.append(
        {
            "name": "copper_net_separation",
            "passed": not shorts,
            "shortedNodes": len(shorts),
            "coordinateToleranceMm": 1e-7,
            "errors": shorts[:20],
        }
    )
    progress("drill_and_cutout_voids", context)
    # A field mesh may explicitly fill drilled holes/cutouts with air. Those
    # cells are valid; copper and laminate must still leave the physical voids.
    pcb_cells = np.asarray([ownership.get(int(v)) != "air" for v in mesh["volumes"]])
    pcb_mesh = mesh | {
        "coordinates": mesh["coordinates"][pcb_cells],
        "tags": mesh["tags"][pcb_cells],
    }
    violations = void_intersections(pcb_mesh, model) if model else []
    checks.append(
        {
            "name": "drill_and_cutout_voids",
            "passed": not violations if model else None,
            "errors": violations,
        }
    )
    progress("terminal_contacts", context)
    terminals = terminal_checks(
        {
            "mesh": mesh,
            "ownership": ownership,
            "components": components,
            "requirements": requirements,
        }
    )
    checks.append(
        {
            "name": "terminal_connectivity",
            "passed": not terminals["errors"] if requirements else None,
            "errors": terminals["errors"],
        }
    )
    return {
        "schemaVersion": 1,
        "passed": all(check["passed"] is not False for check in checks),
        "pcbChecksComplete": bool(
            manifest
            and model
            and requirements.get("terminals")
            and requirements.get("connections")
        ),
        "gmshVersion": gmsh.__version__,
        "units": "mm",
        "wallSeconds": time.monotonic() - started,
        "meshSha256": file_hash(options.mesh),
        "manifestSha256": file_hash(options.manifest),
        "modelSha256": file_hash(options.model),
        "requirementsSha256": file_hash(options.requirements),
        "tetrahedra": len(mesh["tags"]),
        "nodes": len(mesh["nodes"]),
        "quality": quality,
        "copperComponents": net_components,
        "terminals": terminals["terminals"],
        "connections": terminals["connections"],
        "checks": checks,
        "limitations": [
            "Mesh validation is not EM convergence or solver validation.",
            "Void checks exclude a 2e-6 mm boundary tolerance; projection overlap tolerance is 1e-10 mm². Errors are capped at 20 examples.",
            "Only linear tetrahedra and triangular boundaries are supported.",
        ],
    }


def run(options):
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        gmsh.open(options.mesh)
        report = validation(options)
    except Exception as error:
        report = {
            "schemaVersion": 1,
            "passed": False,
            "checks": [
                {"name": "readable_mesh", "passed": False, "errors": [str(error)]}
            ],
        }
    finally:
        gmsh.finalize()
    Path(options.output).write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            {
                "passed": report["passed"],
                "checks": [
                    {"name": c["name"], "passed": c["passed"]} for c in report["checks"]
                ],
            }
        )
    )
    return report["passed"]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mesh", required=True)
    parser.add_argument("--manifest")
    parser.add_argument("--model")
    parser.add_argument("--requirements")
    parser.add_argument("--output", required=True)
    parser.add_argument("--minimum-quality", type=float, default=0)
    run(parser.parse_args())
