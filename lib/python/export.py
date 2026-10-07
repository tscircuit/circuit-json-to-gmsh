"""Native Gmsh CAD/mesh exporter. Millimetres, +Z towards top copper."""

import argparse
import hashlib
import json
import shutil
import time
import resource
import sys
from pathlib import Path
import gmsh
from cad import build_cad
from planar import layer_copper, nonempty_polygons
from topology import TopologyError
from mesh_manifest import mesh_manifest
from shapely.ops import unary_union
from shapely.geometry import box
from planar import clean
from partition import partition
from tiled import build_tiled_cad
from lumped_ports import prepare_ports, imprint_ports, resolve_ports
from reload_cad import reload_cad, check_node_references, import_owned_cad
from simplify_copper import simplify_copper
from route_corridor import route_corridor
from shapely.geometry import mapping


def preview_solids(solids):
    result = []
    tags, coordinates, _ = gmsh.model.mesh.getNodes()
    vertices = {
        int(tag): list(map(float, coordinates[3 * i : 3 * i + 3]))
        for i, tag in enumerate(tags)
    }
    for solid in solids:
        if solid["material"] == "air":
            continue
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
    gmsh.option.setNumber("General.NumThreads", options.threads)
    gmsh.option.setNumber("Geometry.OCCParallel", int(options.threads > 1))
    gmsh.option.setNumber("Geometry.Tolerance", 1e-6)
    gmsh.option.setNumber("Geometry.ToleranceBoolean", 1e-6)
    gmsh.model.add("pcb")
    try:
        (destination / "progress.json").write_text(
            json.dumps(
                {"stage": "planar_copper", "elapsedSeconds": time.monotonic() - started}
            )
        )
        board, copper = layer_copper(model)
        # Approximate physical contours before clipping the analysis domain.
        # Simplifying a clipped edge and clipping it again creates sub-kernel
        # wedges where the copper nearly follows a curved crop boundary.
        copper, simplifications = simplify_copper(
            {
                "model": model,
                "board": board,
                "copper": copper,
                "toleranceMm": options.simplify_tolerance,
            }
        )
        (destination / "simplification.json").write_text(
            json.dumps(
                {
                    "toleranceMm": options.simplify_tolerance,
                    "contours": simplifications,
                },
                indent=2,
            )
        )
        if options.corridor_nets:
            region, expansions, crop_regularization = route_corridor(
                {
                    "model": model,
                    "netIds": options.corridor_nets.split(","),
                    "marginMm": options.corridor_margin,
                }
            )
            board = clean(board.intersection(region))
            (destination / "route-corridor.json").write_text(
                json.dumps(
                    {
                        "netIds": options.corridor_nets.split(","),
                        "marginMm": options.corridor_margin,
                        "expandedBarrelIndices": expansions,
                        "regularization": crop_regularization,
                        "region": mapping(board),
                    },
                    indent=2,
                )
            )
            copper = {
                layer: {
                    net: clean(
                        unary_union(nonempty_polygons(shape.intersection(board)))
                    )
                    for net, shape in nets.items()
                }
                for layer, nets in copper.items()
            }
        if options.bounds:
            board = clean(board.intersection(box(*options.bounds)))
            copper = {
                layer: {
                    net: clean(
                        unary_union(nonempty_polygons(shape.intersection(board)))
                    )
                    for net, shape in nets.items()
                }
                for layer, nets in copper.items()
            }
        (destination / "progress.json").write_text(
            json.dumps(
                {"stage": "cad_slabs", "elapsedSeconds": time.monotonic() - started}
            )
        )
        air_bounds = None
        if options.air_padding:
            x0, y0, x1, y1 = board.bounds
            p = options.air_padding
            air_bounds = [x0 - p, y0 - p, x1 + p, y1 + p]
        ports = (
            prepare_ports(
                model,
                board,
                copper,
                json.loads(Path(options.port_requirements).read_text()),
            )
            if options.port_requirements
            else []
        )
        native = Path(__file__).parent
        signature = hashlib.sha256(
            json.dumps(
                {
                    "modelSha256": hashlib.sha256(
                        Path(options.model).read_bytes()
                    ).hexdigest(),
                    "boardWkb": board.wkb_hex,
                    "copperWkb": {
                        layer: {n: s.wkb_hex for n, s in nets.items()}
                        for layer, nets in copper.items()
                    },
                    "airBoundsMm": air_bounds,
                    "airPaddingMm": options.air_padding,
                    "cutawayX": options.cutaway_x,
                    "repairRadiusMm": options.repair_radius,
                    "fragmentStrategy": options.fragment_strategy,
                    "tileSizeMm": options.tile_size,
                    "gmshVersion": gmsh.__version__,
                    "ports": [
                        {k: (v.wkb_hex if k == "shape" else v) for k, v in p.items()}
                        for p in ports
                    ],
                    "implementationSha256": hashlib.sha256(
                        b"".join(
                            (native / f).read_bytes()
                            for f in [
                                "cad.py",
                                "planar.py",
                                "topology.py",
                                "partition.py",
                                "tiled.py",
                                "tile_axes.py",
                                "tile_worker.py",
                                "lumped_ports.py",
                                "simplify_copper.py",
                                "route_corridor.py",
                            ]
                        )
                    ).hexdigest(),
                },
                sort_keys=True,
            ).encode()
        ).hexdigest()
        (destination / "cad-geometry-signature.json").write_text(
            json.dumps({"sha256": signature}, indent=2)
        )
        checkpoint = Path(options.cad_checkpoint) if options.cad_checkpoint else None
        builder = (
            build_tiled_cad
            if options.conformal and options.fragment_strategy == "tiled"
            else build_cad
        )
        if checkpoint:
            if not options.conformal:
                raise ValueError("CAD checkpoints require a conformal export")
            metadata = json.loads(
                (checkpoint / "cad-checkpoint-metadata.json").read_text()
            )
            if metadata["geometrySignatureSha256"] != signature:
                raise ValueError(
                    "CAD checkpoint geometry, ports or exporter implementation changed"
                )
            for filename, key in [
                ("cad-checkpoint.brep", "brepSha256"),
                ("cad-checkpoint.json", "solidsSha256"),
            ]:
                if (
                    hashlib.sha256((checkpoint / filename).read_bytes()).hexdigest()
                    != metadata[key]
                ):
                    raise ValueError("CAD checkpoint content hash mismatch")
                if checkpoint.resolve() != destination.resolve():
                    shutil.copyfile(checkpoint / filename, destination / filename)
            solids = json.loads((checkpoint / "cad-checkpoint.json").read_text())
            import_owned_cad(checkpoint / "cad-checkpoint.brep", solids)
        else:
            solids = builder(
                {
                    "model": model,
                    "board": board,
                    "copper": copper,
                    "tileSizeMm": options.tile_size,
                    "tileWorkers": options.tile_workers,
                    "tileCacheDirectory": options.tile_cache,
                    "airBoundsMm": air_bounds,
                    "airPaddingMm": options.air_padding,
                    "cutawayX": options.cutaway_x,
                    "repairRadiusMm": options.repair_radius,
                    "boundsMm": options.bounds,
                    "clipBoard": bool(options.corridor_nets),
                    "progressPath": str(destination / "progress.json"),
                }
            )
        if not solids:
            raise ValueError("No geometry remains in the selected cutaway")
        (destination / "cad-solids.json").write_text(json.dumps(solids, indent=2))
        if (
            options.conformal
            and len(solids) > 1
            and options.fragment_strategy != "tiled"
            and not checkpoint
        ):
            (destination / "progress.json").write_text(
                json.dumps(
                    {
                        "stage": "partition_interfaces",
                        "solids": len(solids),
                        "elapsedSeconds": time.monotonic() - started,
                    }
                )
            )
            partition(
                {
                    "solids": solids,
                    "strategy": options.fragment_strategy,
                    "progressPath": str(destination / "progress.json"),
                }
            )
        gmsh.model.occ.synchronize()
        if ports and not checkpoint:
            receipt = imprint_ports(solids, ports)
        if options.conformal:
            if not checkpoint:
                reload_cad(solids, destination)
            if ports:
                receipt = resolve_ports(ports)
            (destination / "cad-checkpoint-metadata.json").write_text(
                json.dumps(
                    {
                        "geometrySignatureSha256": signature,
                        "brepSha256": hashlib.sha256(
                            (destination / "cad-checkpoint.brep").read_bytes()
                        ).hexdigest(),
                        "solidsSha256": hashlib.sha256(
                            (destination / "cad-checkpoint.json").read_bytes()
                        ).hexdigest(),
                    },
                    indent=2,
                )
            )
        if ports:
            (destination / "ports.json").write_text(json.dumps(receipt, indent=2))
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
        if options.conformal:
            (destination / "mesh-manifest.json").write_text(
                json.dumps(mesh_manifest(solids), indent=2) + "\n"
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
        gmsh.option.setNumber(
            "Mesh.Algorithm3D", 10 if options.tetrahedral_algorithm == "hxt" else 1
        )
        gmsh.option.setNumber("Mesh.ElementOrder", 1)
        mesh_started = time.monotonic()
        if not options.cad_only:
            (destination / "progress.json").write_text(
                json.dumps(
                    {
                        "stage": "tetrahedral_mesh"
                        if options.conformal
                        else "surface_mesh",
                        "volumes": len(gmsh.model.getEntities(3)),
                        "elapsedSeconds": time.monotonic() - started,
                    }
                )
            )
            gmsh.model.mesh.generate(3 if options.conformal else 2)
            if options.optimize_netgen and options.conformal:
                gmsh.model.mesh.optimize("Netgen")
            check_node_references()
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
            "tetrahedralAlgorithm": options.tetrahedral_algorithm,
            "fragmentStrategy": options.fragment_strategy,
            "tileSizeMm": options.tile_size
            if options.fragment_strategy == "tiled"
            else None,
            "simplificationToleranceMm": options.simplify_tolerance,
            "simplification": simplifications,
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
            "sliverRepairs": [r for s in solids for r in s.get("sliverRepairs", [])],
            "removedVolumeMm3": sum(
                s["originalVolumeMm3"] - s["expectedVolumeMm3"] for s in solids
            ),
        }
        report["peakRssMiB"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (
            1024**2 if sys.platform == "darwin" else 1024
        )
        (destination / "report.json").write_text(json.dumps(report, indent=2))
        (destination / "progress.json").write_text(
            json.dumps(
                {
                    "stage": "export_complete",
                    "elapsedSeconds": time.monotonic() - started,
                }
            )
        )
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
    parser.add_argument("--bounds", type=float, nargs=4)
    parser.add_argument("--threads", type=int, default=1)
    parser.add_argument("--optimize-netgen", action="store_true")
    parser.add_argument(
        "--tetrahedral-algorithm", choices=["delaunay", "hxt"], default="delaunay"
    )
    parser.add_argument(
        "--fragment-strategy", choices=["global", "slab", "tiled"], default="global"
    )
    parser.add_argument("--simplify-tolerance", type=float, default=0)
    parser.add_argument("--corridor-nets")
    parser.add_argument("--corridor-margin", type=float, default=1)
    parser.add_argument("--tile-size", type=float, default=2)
    parser.add_argument("--tile-workers", type=int, default=1)
    parser.add_argument("--tile-cache")
    parser.add_argument("--cad-checkpoint")
    parser.add_argument("--air-padding", type=float, default=0)
    parser.add_argument("--port-requirements")
    export(parser.parse_args())
