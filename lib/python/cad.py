"""Non-overlapping z slabs, formed by planar unions before OCC extrusion.

No overlapping foil/barrel volumes are passed to a global 3D union. Slab
boundaries retain physical foil and drill heights, including through-via stubs.
"""

import gmsh
import json
import time
from pathlib import Path
from shapely.geometry import Polygon, box
from shapely.geometry.polygon import orient
from shapely.ops import unary_union
from planar import clean, nonempty_polygons, points
from topology import regularize


def ring(coordinates, z):
    vertices = [gmsh.model.occ.addPoint(x, y, z) for x, y in list(coordinates)[:-1]]
    lines = [
        gmsh.model.occ.addLine(a, b)
        for a, b in zip(vertices, vertices[1:] + vertices[:1])
    ]
    return gmsh.model.occ.addCurveLoop(lines)


def prism(options):
    polygon, z_min, z_max = [options[k] for k in ["shape", "zMin", "zMax"]]
    polygon = orient(polygon, sign=1)
    loops = [ring(polygon.exterior.coords, z_min)]
    loops.extend(ring(list(h.coords)[::-1], z_min) for h in polygon.interiors)
    face = gmsh.model.occ.addPlaneSurface(loops)
    volumes = [
        entity
        for entity in gmsh.model.occ.extrude([(2, face)], 0, 0, z_max - z_min)
        if entity[0] == 3
    ]
    expected = polygon.area * (z_max - z_min)
    actual = sum(gmsh.model.occ.getMass(*entity) for entity in volumes)
    if abs(expected - actual) > max(1e-10, expected * 1e-7):
        raise ValueError(f"Prism mass mismatch: {actual} != {expected} mm³")
    return volumes, expected


def repair_crop_slivers(substrate, merged, board, voids, lower, upper):
    """Absorb sub-kernel resin wedges at artificial crop edges into one net.

    Never bridge nets or modify drills. Bounds and transferred volume are
    recorded; large or resolvable laminate islands remain physical solids.
    """
    receipts = []
    forbidden = unary_union(voids)
    for polygon in nonempty_polygons(substrate):
        if (
            polygon.area > 1e-8
            or not polygon.buffer(-2e-6).is_empty
            or polygon.distance(board.boundary) > 1e-8
            or polygon.distance(forbidden) < 2e-6
        ):
            continue
        neighbors = [
            net for net, shape in merged.items() if polygon.distance(shape) < 2e-6
        ]
        if len(neighbors) != 1:
            raise ValueError(
                "Sub-kernel crop sliver cannot be assigned to one copper net"
            )
        net = neighbors[0]
        joined = clean(unary_union([merged[net], polygon]))
        added = joined.area - merged[net].area
        if abs(added - polygon.area) > 1e-10:
            raise ValueError("Crop sliver repair changed geometry beyond the wedge")
        merged[net] = joined
        substrate = clean(substrate.difference(polygon))
        receipts.append(
            {
                "netId": net,
                "areaMm2": polygon.area,
                "volumeMm3": polygon.area * (upper - lower),
                "boundsMm": list(polygon.bounds),
                "zMin": lower,
                "zMax": upper,
                "maximumAreaMm2": 1e-8,
                "insetTestMm": 2e-6,
            }
        )
    return substrate, receipts


def slab_shapes(options):
    model, board, copper = [options[k] for k in ["model", "board", "copper"]]
    layered = model["multilayer"]
    boundaries = sorted(
        {
            z
            for layer in [
                *layered["stackup"]["copperLayers"],
                *layered["stackup"]["dielectrics"],
                *layered["barrels"],
                *layered["drills"],
            ]
            for z in [layer["zMin"], layer["zMax"]]
        }
    )
    air_bounds = options.get("airBoundsMm")
    if air_bounds:
        padding = options["airPaddingMm"]
        boundaries = sorted(
            {*boundaries, boundaries[0] - padding, boundaries[-1] + padding}
        )
        enclosure = box(*air_bounds)
    barrels = [
        (
            b,
            clean(
                Polygon(points(b["hole"]))
                .buffer(b["platingThickness"], join_style="mitre")
                .difference(Polygon(points(b["hole"])))
            ),
        )
        for b in layered["barrels"]
    ]
    drills = [(d, Polygon(points(d["hole"]))) for d in layered["drills"]]
    for lower, upper in zip(boundaries, boundaries[1:]):
        middle = (lower + upper) / 2
        groups = {}
        foil = next(
            (
                f
                for f in layered["stackup"]["copperLayers"]
                if f["zMin"] < middle < f["zMax"]
            ),
            None,
        )
        if foil:
            groups = {net: [p] for net, p in copper[foil["name"]].items()}
        for barrel, shape in barrels:
            if barrel["zMin"] < middle < barrel["zMax"]:
                groups.setdefault(barrel["netId"], []).append(shape)
        merged = {net: clean(unary_union(shapes)) for net, shapes in groups.items()}
        if options.get("crop"):
            merged = {
                net: clean(shape.intersection(board)) for net, shape in merged.items()
            }
        dielectric = next(
            (
                d
                for d in layered["stackup"]["dielectrics"]
                if d["zMin"] < middle < d["zMax"]
            ),
            None,
        )
        if dielectric is None and foil and foil["name"].startswith("inner"):
            # Etched inner foil spaces contain laminate resin. Use the upper
            # adjacent fabrication dielectric, including its material attribute.
            dielectric = next(
                d
                for d in layered["stackup"]["dielectrics"]
                if abs(d["zMin"] - foil["zMax"]) < 1e-8
            )
        substrate = Polygon()
        sliver_repairs = []
        if dielectric:
            voids = [
                shape
                for drill, shape in drills
                if drill["zMin"] < middle < drill["zMax"]
            ]
            substrate = clean(board.difference(unary_union([*merged.values(), *voids])))
            if options.get("crop"):
                substrate, sliver_repairs = repair_crop_slivers(
                    substrate, merged, board, voids, lower, upper
                )
        for net, shape in sorted(merged.items()):
            yield {
                "name": f"copper:{net}",
                "material": "copper",
                "netId": net,
                "layer": foil["name"] if foil else "barrel",
                "shape": shape,
                "zMin": lower,
                "zMax": upper,
                "sliverRepairs": [r for r in sliver_repairs if r["netId"] == net],
            }
        if dielectric:
            yield {
                "name": f"dielectric:{dielectric['attribute']}",
                "material": "dielectric",
                "layer": dielectric["material"],
                "shape": substrate,
                "zMin": lower,
                "zMax": upper,
            }
        if air_bounds:
            yield {
                "name": "air",
                "material": "air",
                "layer": "air",
                "shape": clean(
                    enclosure.difference(unary_union([*merged.values(), substrate]))
                ),
                "zMin": lower,
                "zMax": upper,
            }


def build_cad(options):
    model, board, copper = [options[k] for k in ["model", "board", "copper"]]
    cutaway_x = options.get("cutawayX")
    repair_radius = options.get("repairRadiusMm", 0.0001)
    region = box(*options["boundsMm"]) if options.get("boundsMm") else None
    solids = []
    started = time.monotonic()
    for slab_index, slab in enumerate(
        slab_shapes(
            {
                "model": model,
                "board": board,
                "copper": copper,
                "crop": region is not None or options.get("clipBoard", False),
                "airBoundsMm": options.get("airBoundsMm"),
                "airPaddingMm": options.get("airPaddingMm"),
            }
        )
    ):
        shape = slab["shape"]
        if region is not None:
            shape = clean(shape.intersection(region))
        if cutaway_x is not None:
            min_x, min_y, _, max_y = board.bounds
            shape = clean(
                shape.intersection(box(min_x - 1, min_y - 1, cutaway_x, max_y + 1))
            )
        for polygon_index, polygon in enumerate(nonempty_polygons(shape)):
            context = {
                k: slab[k]
                for k in ["name", "material", "netId", "layer", "zMin", "zMax"]
                if k in slab
            }
            original_volume = polygon.area * (slab["zMax"] - slab["zMin"])
            if options.get("progressPath"):
                Path(options["progressPath"]).write_text(
                    json.dumps(
                        {
                            "stage": "cad_prism",
                            "completedSolids": len(solids),
                            "solid": context,
                            "vertices": len(polygon.exterior.coords)
                            + sum(len(h.coords) for h in polygon.interiors),
                            "cadElapsedSeconds": time.monotonic() - started,
                        }
                    )
                )
            polygon, repairs = regularize(
                polygon, {"radiusMm": repair_radius, "context": context}
            )
            volumes, expected = prism(
                {"shape": polygon, "zMin": slab["zMin"], "zMax": slab["zMax"]}
            )
            solids.append(
                {k: v for k, v in slab.items() if k not in ["shape", "sliverRepairs"]}
                | {
                    "id": f"slab/{slab_index}/{polygon_index}",
                    "entities": volumes,
                    "expectedVolumeMm3": expected,
                    "originalVolumeMm3": original_volume,
                    "repairs": repairs,
                    "sliverRepairs": slab.get("sliverRepairs", [])
                    if polygon_index == 0
                    else [],
                }
            )
    return solids
