"""Convert an independently validated circuit-json-to-gmsh mesh for Palace.

Copper is excluded from the field domain and replaced by finite-geometry PEC
boundaries. This is explicitly a lossless copper baseline, not bulk skin-depth
resolution. Dielectric loss comes from the supplied fabrication stackup.
"""

import argparse
import hashlib
import json
import math
from pathlib import Path
import gmsh


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(
    source,
    output,
    frequencies,
    order,
    impedance,
    linear_solver,
    max_iterations=500,
    krylov_size=None,
    ams_vector_interpolation=False,
    smoothing_iterations=1,
):
    validation = json.loads((source / "validation.json").read_text())
    if not validation.get("passed") or not validation.get("pcbChecksComplete"):
        raise ValueError("Require a complete, passing saved-mesh PCB validation")
    for field, filename in [
        ("meshSha256", "board.msh"),
        ("modelSha256", "model.json"),
        ("manifestSha256", "mesh-manifest.json"),
    ]:
        if sha(source / filename) != validation[field]:
            raise ValueError(f"Validated {filename} has changed")
    if (
        not frequencies
        or any(not math.isfinite(f) or f <= 0 for f in frequencies)
        or len(set(frequencies)) != len(frequencies)
    ):
        raise ValueError("Specify distinct positive frequencies in Hz")
    if order not in [1, 2, 3] or not math.isfinite(impedance) or impedance <= 0:
        raise ValueError("Require order 1/2/3 and positive reference impedance")
    if (
        max_iterations < 1
        or smoothing_iterations < 1
        or (krylov_size is not None and not 1 <= krylov_size <= max_iterations)
    ):
        raise ValueError(
            "Require positive solver budgets and Krylov size <= maximum iterations"
        )
    if ams_vector_interpolation and linear_solver != "AMS":
        raise ValueError("Vector interpolation requires the AMS solver")
    linear_options = {
        "Type": linear_solver,
        "KSPType": "GMRES",
        "Tol": 1e-8,
        "MaxIts": max_iterations,
    }
    if krylov_size is not None:
        linear_options["MaxSize"] = krylov_size
    if ams_vector_interpolation:
        linear_options["AMSVectorInterpolation"] = True
    if smoothing_iterations != 1:
        linear_options["MGSmoothIts"] = smoothing_iterations
    model = json.loads((source / "model.json").read_text())
    manifest = json.loads((source / "mesh-manifest.json").read_text())
    ports = json.loads((source / "ports.json").read_text())
    if not ports:
        raise ValueError("Require explicit native port apertures")
    owners = {v["tag"]: v for v in manifest["volumes"]}
    pec, absorbing = [], []
    for face in manifest["faces"]:
        materials = [owners[v]["material"] for v in face["volumes"]]
        if "copper" in materials and any(m != "copper" for m in materials):
            pec.append(face["tag"])
        if materials == ["air"]:
            absorbing.append(face["tag"])
    fixture_faces = [f for p in ports for f in p.get("fixturePecFaces", [])]
    if fixture_faces:
        fixture = json.loads((source / "port-fixtures.json").read_text())
        if (
            not fixture.get("materialVolumesUnchanged")
            or not fixture.get("nativeContactNetsValidated")
            or fixture["meshSha256"] != validation["meshSha256"]
            or fixture["portsSha256"] != sha(source / "ports.json")
        ):
            raise ValueError("Require unchanged native-validated PEC contact fixtures")
        face_lookup = {f["tag"]: f for f in manifest["faces"]}
        if set(fixture_faces) & {f for p in ports for f in p["faces"]}:
            raise ValueError("PEC fixture overlaps a port aperture")
        for face in fixture_faces:
            if face not in face_lookup or any(
                owners[v]["material"] == "copper" for v in face_lookup[face]["volumes"]
            ):
                raise ValueError("PEC fixture must occupy the original non-copper gap")
        pec.extend(fixture_faces)
    if not pec or not absorbing:
        raise ValueError("Require conductor cavities and an exterior air enclosure")
    output.mkdir(parents=True, exist_ok=True)
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        gmsh.open(str(source / "board.msh"))
        material_data = []
        copper_attributes = []
        dielectric_by_attribute = {
            d["attribute"]: d for d in model["multilayer"]["stackup"]["dielectrics"]
        }
        for _, attribute in gmsh.model.getPhysicalGroups(3):
            name = gmsh.model.getPhysicalName(3, attribute)
            if name.startswith("copper:"):
                copper_attributes.append((3, attribute))
                continue
            if name == "air":
                er, loss = 1, 0
            else:
                d = dielectric_by_attribute[int(name.split(":")[1])]
                er, loss = d["dielectricConstant"], d["lossTangent"]
            material_data.append(
                {
                    "Attributes": [attribute],
                    "Permittivity": er,
                    "Permeability": 1,
                    "LossTan": loss,
                }
            )
        # MSH 2.2 repeats a boundary triangle when it belongs to both its
        # material-interface group and a port group. After selecting Palace's
        # groups, retain one triangle per geometric face; MFEM rejects repeats.
        for _, face in gmsh.model.getEntities(2):
            for kind, tags, nodes in zip(*gmsh.model.mesh.getElements(2, face)):
                if kind != 2:
                    raise ValueError("Require linear triangular boundaries")
                seen, unique = set(), []
                for i in range(0, len(nodes), 3):
                    triangle = list(map(int, nodes[i : i + 3]))
                    key = tuple(sorted(triangle))
                    if key not in seen:
                        seen.add(key)
                        unique.extend(triangle)
                if len(unique) != len(nodes):
                    gmsh.model.mesh.removeElements(2, face, list(map(int, tags)))
                    gmsh.model.mesh.addElementsByType(face, 2, [], unique)
        gmsh.model.removePhysicalGroups(copper_attributes)
        gmsh.model.removePhysicalGroups(gmsh.model.getPhysicalGroups(2))
        gmsh.model.addPhysicalGroup(2, pec, 1000000, "PEC-copper")
        gmsh.model.addPhysicalGroup(2, absorbing, 1000001, "outer-air")
        for port in ports:
            gmsh.model.addPhysicalGroup(
                2, port["faces"], port["attribute"], "port:" + port["name"]
            )
        gmsh.option.setNumber("Mesh.MshFileVersion", 2.2)
        gmsh.option.setNumber("Mesh.SaveAll", 0)
        gmsh.write(str(output / "palace.msh"))
    finally:
        gmsh.finalize()
    configs = []
    for excited in range(len(ports)):
        config = {
            "Problem": {
                "Type": "Driven",
                "Verbose": 2,
                "Output": f"postpro/port-{excited + 1}",
            },
            "Model": {
                "Mesh": "palace.msh",
                "L0": 0.001,
                "Lc": 1,
                "CrackInternalBoundaryElements": False,
            },
            "Domains": {"Materials": material_data},
            "Boundaries": {
                "PEC": {"Attributes": [1000000]},
                "Absorbing": {"Attributes": [1000001], "Order": 1},
                "LumpedPort": [
                    {
                        "Index": i + 1,
                        "Attributes": [p["attribute"]],
                        "Direction": p["direction"],
                        "R": impedance,
                        "Excitation": i == excited,
                    }
                    for i, p in enumerate(ports)
                ],
            },
            "Solver": {
                "Order": order,
                "Device": "CPU",
                "Driven": {
                    "Samples": [
                        {
                            "Type": "Point",
                            "Freq": [f / 1e9 for f in sorted(frequencies)],
                        }
                    ]
                },
                "Linear": linear_options,
            },
        }
        path = output / f"palace-{excited + 1}.json"
        path.write_text(json.dumps(config, indent=2) + "\n")
        configs.append(path.name)
    receipt = {
        "sourceMeshSha256": validation["meshSha256"],
        "modelSha256": validation["modelSha256"],
        "palaceMeshSha256": sha(output / "palace.msh"),
        "sourcePortsSha256": sha(source / "ports.json"),
        "portFixtureReceiptSha256": sha(source / "port-fixtures.json")
        if fixture_faces
        else None,
        "sourceManifestSha256": validation["manifestSha256"],
        "tetrahedra": validation["tetrahedra"],
        "ports": ports,
        "frequenciesHz": sorted(frequencies),
        "referenceImpedanceOhms": impedance,
        "order": order,
        "linearSolverSettings": linear_options,
        "copperModel": "PEC cavities, no copper loss",
        "portFixtureModel": "ideal PEC end-contact extensions"
        if fixture_faces
        else None,
        "configurations": configs,
        "convergenceProven": False,
        "limitations": [
            "Port references are explicit geometry assumptions, not inferred power/ground AC impedance.",
            "Dielectric material assumptions and crop/enclosure sensitivity require independent checks.",
            *(
                [
                    "Ideal PEC contact extensions alter near-port fields; fixture-size sensitivity and de-embedding are unproven."
                ]
                if fixture_faces
                else []
            ),
        ],
    }
    (output / "solver-input.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--mesh-directory", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--frequency-hz", nargs="+", type=float, required=True)
    p.add_argument("--order", type=int, default=1)
    p.add_argument("--impedance", type=float, default=50)
    p.add_argument("--linear-solver", choices=["SuperLU", "AMS"], default="SuperLU")
    p.add_argument("--max-iterations", type=int, default=500)
    p.add_argument("--krylov-size", type=int)
    p.add_argument("--ams-vector-interpolation", action="store_true")
    p.add_argument("--smoothing-iterations", type=int, default=1)
    a = p.parse_args()
    print(
        json.dumps(
            prepare(
                Path(a.mesh_directory),
                Path(a.output),
                a.frequency_hz,
                a.order,
                a.impedance,
                a.linear_solver,
                a.max_iterations,
                a.krylov_size,
                a.ams_vector_interpolation,
                a.smoothing_iterations,
            ),
            indent=2,
        )
    )
