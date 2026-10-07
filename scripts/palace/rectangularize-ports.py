"""Remesh verified CAD with explicit ideal PEC port contacts, preserving PCB solids.

The resulting port fixture is a modeling assumption, requiring sensitivity checks.
Existing port imprints remain harmless face partitions. No tiled join is repeated.
"""

import argparse
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys
import time
import gmsh

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib/python"))
from cad import ring
from lumped_ports import resolve_ports
from mesh_manifest import mesh_manifest
from port_fixtures import rectangular_fixture
from reload_cad import import_owned_cad, reload_cad, check_node_references


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build(source, output, size, threads, width_fraction):
    started = time.monotonic()
    validation = json.loads((source / "validation.json").read_text())
    if not validation.get("passed") or not validation.get("pcbChecksComplete"):
        raise ValueError("Require complete passing PCB mesh validation")
    for field, filename in [
        ("meshSha256", "board.msh"),
        ("manifestSha256", "mesh-manifest.json"),
        ("modelSha256", "model.json"),
        ("requirementsSha256", "validation-requirements.json"),
    ]:
        if sha(source / filename) != validation[field]:
            raise ValueError(f"Validated {filename} changed")
    metadata = json.loads((source / "cad-checkpoint-metadata.json").read_text())
    for filename, key in [
        ("cad-checkpoint.brep", "brepSha256"),
        ("cad-checkpoint.json", "solidsSha256"),
    ]:
        if sha(source / filename) != metadata[key]:
            raise ValueError("CAD checkpoint hash mismatch")
    if (
        source.resolve() == output.resolve()
        or not math.isfinite(size)
        or size <= 0
        or threads < 1
    ):
        raise ValueError("Require a new output directory and positive size/threads")
    if output.exists() and any(output.iterdir()):
        raise ValueError("Refuse to overwrite an existing fixture export")
    output.mkdir(parents=True, exist_ok=True)
    ports, contacts = [], []
    for p in json.loads((source / "ports.json").read_text()):
        port, caps = rectangular_fixture(p, width_fraction)
        ports.append(port)
        contacts.extend(caps)
    all_surfaces = ports + contacts
    solids = json.loads((source / "cad-checkpoint.json").read_text())
    gmsh.initialize()
    gmsh.option.setNumber("General.NumThreads", threads)
    gmsh.model.add("port-fixtures")
    try:
        import_owned_cad(source / "cad-checkpoint.brep", solids)
        if len({s["id"] for s in solids}) != len(solids):
            raise ValueError("Require unique saved solid ownership")
        before = {
            s["id"]: sum(gmsh.model.occ.getMass(*e) for e in s["entities"])
            for s in solids
        }
        z = {p["zMm"] for p in ports}
        selected = [
            s
            for s in solids
            if any(abs(s[k] - level) < 1e-8 for k in ["zMin", "zMax"] for level in z)
        ]
        entities = [e for s in selected for e in s["entities"]]
        faces = [
            (
                2,
                gmsh.model.occ.addPlaneSurface(
                    [ring(p["shape"].exterior.coords, p["zMm"])]
                ),
            )
            for p in all_surfaces
        ]
        _, history = gmsh.model.occ.fragment(entities, faces)
        offset = 0
        for solid in selected:
            count = len(solid["entities"])
            solid["entities"] = sorted(
                {
                    tuple(e)
                    for h in history[offset : offset + count]
                    for e in h
                    if e[0] == 3
                }
            )
            offset += count
        gmsh.model.occ.synchronize()
        for solid in solids:
            actual = sum(gmsh.model.occ.getMass(*e) for e in solid["entities"])
            expected = before[solid["id"]]
            if abs(actual - expected) > max(1e-9, expected * 1e-7):
                raise ValueError("Port imprint changed a PCB material volume")
        reload_cad(solids, output)
        receipt = resolve_ports(all_surfaces)
        owner = {t: s for s in solids for _, t in s["entities"]}
        for contact in contacts:
            found = set()
            for face in contact["faces"]:
                for _, edge in gmsh.model.getBoundary([(2, face)], oriented=False):
                    if gmsh.model.occ.getMass(1, edge) < 2e-6:
                        continue
                    for neighbor in gmsh.model.getAdjacencies(1, edge)[0]:
                        for vol in gmsh.model.getAdjacencies(2, int(neighbor))[0]:
                            s = owner[int(vol)]
                            if s["material"] == "copper":
                                found.add(s["netId"])
            if found != {contact["expectedNetId"]}:
                raise ValueError(
                    f"Fixture {contact['name']} contacts {found}, expected only {contact['expectedNetId']}"
                )
        for i, p in enumerate(ports):
            receipt[i]["fixturePecFaces"] = [
                f for c in contacts[2 * i : 2 * i + 2] for f in c["faces"]
            ]
            receipt[i]["fixtureContacts"] = receipt[
                len(ports) + 2 * i : len(ports) + 2 * i + 2
            ]
        (output / "ports.json").write_text(json.dumps(receipt[: len(ports)], indent=2))
        groups = {}
        for s in solids:
            groups.setdefault(s["name"], set()).update(t for _, t in s["entities"])
        for attr, (name, tags) in enumerate(sorted(groups.items()), 1):
            gmsh.model.addPhysicalGroup(3, sorted(tags), attr, name)
        (output / "mesh-manifest.json").write_text(
            json.dumps(mesh_manifest(solids), indent=2)
        )
        gmsh.write(str(output / "board.brep"))
        for name in ["Mesh.MeshSizeMin", "Mesh.MeshSizeMax"]:
            gmsh.option.setNumber(name, size)
        for name in ["Mesh.MeshSizeFromCurvature", "Mesh.MeshSizeExtendFromBoundary"]:
            gmsh.option.setNumber(name, 0)
        gmsh.option.setNumber("Mesh.Algorithm", 6)
        gmsh.option.setNumber("Mesh.ElementOrder", 1)
        gmsh.model.mesh.generate(3)
        gmsh.model.mesh.optimize("Netgen")
        check_node_references()
        gmsh.option.setNumber("Mesh.MshFileVersion", 2.2)
        gmsh.write(str(output / "board.msh"))
    finally:
        gmsh.finalize()
    for filename in [
        "model.json",
        "validation-model.json",
        "validation-requirements.json",
    ]:
        (output / filename).write_bytes((source / filename).read_bytes())
    native = Path(__file__).resolve().parents[2] / "lib/python"
    result = subprocess.run(
        [
            sys.executable,
            str(native / "validate_brep.py"),
            "--brep",
            str(output / "board.brep"),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    brep = json.loads(result.stdout)
    (output / "brep-validation.json").write_text(json.dumps(brep, indent=2))
    if not brep["valid"]:
        raise ValueError("Port imprints produced invalid CAD")
    subprocess.run(
        [
            sys.executable,
            str(native / "validate_mesh.py"),
            "--mesh",
            str(output / "board.msh"),
            "--manifest",
            str(output / "mesh-manifest.json"),
            "--model",
            str(output / "validation-model.json"),
            "--requirements",
            str(output / "validation-requirements.json"),
            "--output",
            str(output / "validation.json"),
        ],
        check=True,
    )
    v = json.loads((output / "validation.json").read_text())
    if not v.get("passed") or not v.get("pcbChecksComplete"):
        raise ValueError("Fixture mesh failed full PCB validation")
    report = {
        "sourceMeshSha256": validation["meshSha256"],
        "sourceCadSha256": metadata["brepSha256"],
        "sourcePortsSha256": sha(source / "ports.json"),
        "meshSha256": sha(output / "board.msh"),
        "portsSha256": sha(output / "ports.json"),
        "widthFraction": width_fraction,
        "meshSizeMm": size,
        "wallSeconds": time.monotonic() - started,
        "materialVolumesUnchanged": True,
        "nativeContactNetsValidated": True,
        "pcbChecksComplete": True,
        "limitation": "Ideal PEC end-contact fixtures alter near-port fields; fixture-size and enclosure sensitivity remain unproven.",
    }
    (output / "port-fixtures.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--mesh-directory", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--mesh-size", type=float, default=0.4)
    p.add_argument("--threads", type=int, default=2)
    p.add_argument("--width-fraction", type=float, default=0.95)
    a = p.parse_args()
    build(a.mesh_directory, a.output, a.mesh_size, a.threads, a.width_fraction)
