"""Native Gmsh CAD/mesh exporter. Millimetres, +Z towards top copper."""

import argparse
import json
import time
import resource
import sys
from pathlib import Path
import gmsh
from cad import build_cad
from planar import layer_copper
from topology import TopologyError


def preview_solids(solids):
    result = []
    tags, coordinates, _ = gmsh.model.mesh.getNodes()
    vertices = {
        int(tag): list(map(float, coordinates[3 * i : 3 * i + 3]))
        for i, tag in enumerate(tags)
    }
    for solid in solids:
        triangles = []
        faces = gmsh.model.getBoundary(solid["entities"], combined=True, oriented=False)
        for dimension, face in faces:
            for element_type, _, nodes in zip(
                *gmsh.model.mesh.getElements(dimension, face)
            ):
                if element_type != 2:
                    continue
                triangles.extend(map(int, nodes))
        unique = sorted(set(triangles))
        index = {tag: i for i, tag in enumerate(unique)}
        result.append(
            {k: solid[k] for k in ["id", "material", "netId", "layer"] if k in solid}
            | {
                "positions": [x for tag in unique for x in vertices[tag]],
                "indices": [index[tag] for tag in triangles],
            }
        )
    return result


def export(options):
    started = time.monotonic()
    destination = Path(options.output)
    destination.mkdir(parents=True, exist_ok=True)
    model = json.loads(Path(options.model).read_text())
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 1)
    gmsh.option.setNumber("Geometry.Tolerance", 1e-6)
    gmsh.option.setNumber("Geometry.ToleranceBoolean", 1e-6)
    gmsh.model.add("pcb")
    try:
        board, copper = layer_copper(model)
        solids = build_cad(
            {
                "model": model,
                "board": board,
                "copper": copper,
                "cutawayX": options.cutaway_x,
                "repairRadiusMm": options.repair_radius,
            }
        )
        if not solids:
            raise ValueError("No geometry remains in the selected cutaway")
        if options.conformal and len(solids) > 1:
            entities = [entity for solid in solids for entity in solid["entities"]]
            _, mapping = gmsh.model.occ.fragment(entities[:1], entities[1:])
            cursor = 0
            for solid in solids:
                count = len(solid["entities"])
                solid["entities"] = sorted(
                    {
                        e
                        for m in mapping[cursor : cursor + len(solid["entities"])]
                        for e in m
                        if e[0] == 3
                    }
                )
                cursor += count
        gmsh.model.occ.synchronize()
        for solid in solids:
            for repair in solid["repairs"]:
                for x, y in repair["contactsMm"]:
                    position = [x, y, (solid["zMin"] + solid["zMax"]) / 2]
                    if any(
                        gmsh.model.isInside(3, tag, position)
                        for _, tag in solid["entities"]
                    ):
                        raise ValueError("Native CAD filled a repaired contact")
                repair["cadVoidVerified"] = True
        expected_volume = sum(s["expectedVolumeMm3"] for s in solids)
        actual_volume = sum(
            gmsh.model.occ.getMass(*e) for e in gmsh.model.getEntities(3)
        )
        if abs(expected_volume - actual_volume) > max(1e-9, expected_volume * 1e-7):
            raise ValueError("Fragmentation changed material volume")
        groups = {}
        for solid in solids:
            groups.setdefault(solid["name"], set()).update(
                tag for _, tag in solid["entities"]
            )
        materials = []
        for attribute, (name, volumes) in enumerate(sorted(groups.items()), 1):
            gmsh.model.addPhysicalGroup(3, sorted(volumes), attribute, name)
            materials.append(
                {"name": name, "attribute": attribute, "volumes": sorted(volumes)}
            )
        gmsh.write(str(destination / "board.brep"))
        if options.step:
            gmsh.write(str(destination / "board.step"))
        cad_seconds = time.monotonic() - started
        (destination / "cad-report.json").write_text(
            json.dumps(
                {
                    "cadSeconds": cad_seconds,
                    "volumeCount": len(gmsh.model.getEntities(3)),
                    "expectedVolumeMm3": sum(s["expectedVolumeMm3"] for s in solids),
                    "actualVolumeMm3": sum(
                        gmsh.model.occ.getMass(*e) for e in gmsh.model.getEntities(3)
                    ),
                },
                indent=2,
            )
        )
        gmsh.option.setNumber("Mesh.MeshSizeMin", options.mesh_size)
        gmsh.option.setNumber("Mesh.MeshSizeMax", options.mesh_size)
        gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 0)
        gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 0)
        gmsh.option.setNumber("Mesh.Algorithm", 6)
        gmsh.option.setNumber("Mesh.ElementOrder", 1)
        mesh_started = time.monotonic()
        if not options.cad_only:
            gmsh.model.mesh.generate(3 if options.conformal else 2)
            gmsh.option.setNumber("Mesh.MshFileVersion", 2.2)
            gmsh.write(str(destination / "board.msh"))
        preview = [] if options.cad_only else preview_solids(solids)
        mesh_seconds = 0 if options.cad_only else time.monotonic() - mesh_started
        (destination / "preview.json").write_text(json.dumps(preview))
        volumes = gmsh.model.getEntities(3)
        tetrahedra = sum(
            len(tags)
            for kind, tags, _ in zip(*gmsh.model.mesh.getElements(3))
            if kind == 4
        )
        tet_tags = [
            int(tag)
            for kind, tags, _ in zip(*gmsh.model.mesh.getElements(3))
            if kind == 4
            for tag in tags
        ]
        qualities = (
            gmsh.model.mesh.getElementQualities(tet_tags, "minSICN") if tet_tags else []
        )
        if len(qualities) and min(qualities) <= 0:
            raise ValueError("Mesh contains inverted or degenerate tetrahedra")
        report = {
            "gmshVersion": gmsh.__version__,
            "wallSeconds": time.monotonic() - started,
            "cadSeconds": cad_seconds,
            "meshSeconds": mesh_seconds,
            "volumeCount": len(volumes),
            "expectedVolumeMm3": sum(s["expectedVolumeMm3"] for s in solids),
            "actualVolumeMm3": sum(
                gmsh.model.occ.getMass(*entity) for entity in volumes
            ),
            "tetrahedra": tetrahedra,
            "materials": materials,
            "sharedInterfaceFaces": sum(
                len(gmsh.model.getAdjacencies(2, face)[0]) == 2
                for _, face in gmsh.model.getEntities(2)
            ),
            "minimumTetQuality": float(min(qualities)) if len(qualities) else None,
            "repairs": [repair for s in solids for repair in s["repairs"]],
            "removedVolumeMm3": sum(
                s["originalVolumeMm3"] - s["expectedVolumeMm3"] for s in solids
            ),
        }
        report["peakRssMiB"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (
            1024**2 if sys.platform == "darwin" else 1024
        )
        (destination / "report.json").write_text(json.dumps(report, indent=2))
        print(
            json.dumps(
                {k: v for k, v in report.items() if k not in ["materials", "repairs"]}
            ),
            flush=True,
        )
    except TopologyError as error:
        (destination / "failure.json").write_text(
            json.dumps(error.reproduction, indent=2)
        )
        raise
    finally:
        gmsh.finalize()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--mesh-size", type=float, default=0.5)
    parser.add_argument("--conformal", action="store_true")
    parser.add_argument("--cutaway-x", type=float)
    parser.add_argument("--cad-only", action="store_true")
    parser.add_argument("--step", action="store_true")
    parser.add_argument("--repair-radius", type=float, default=0.0001)
    export(parser.parse_args())
