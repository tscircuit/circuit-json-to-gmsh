"""Physical planar copper. Adapted from simulate-return-current (see NOTICE)."""

from shapely.geometry import Polygon, LineString
from shapely.ops import unary_union
from shapely import set_precision
from shapely.strtree import STRtree


def points(outline):
    return [(p["x"], p["y"]) for p in outline]


def polygons(shape):
    if shape.is_empty:
        return []
    if shape.geom_type == "Polygon":
        return [shape]
    if shape.geom_type in ("MultiPolygon", "GeometryCollection"):
        return [p for g in shape.geoms for p in polygons(g)]
    return []


def clean(shape):
    return set_precision(shape, grid_size=1e-6)


def nonempty_polygons(shape):
    if shape.is_empty:
        return []
    return [p for p in polygons(shape) if p.area > 1e-12]


def build_layer_copper(model, trace_caps="round"):
    layered = model["multilayer"]
    board = Polygon(points(model["geometry"]["boardOutline"]))
    for cutout in layered["boardCutouts"]:
        board = board.difference(Polygon(points(cutout)))
    if not board.is_valid:
        raise ValueError("Invalid board outline/cutout")
    barrel_shapes = [
        Polygon(points(barrel["hole"])).buffer(
            barrel["platingThickness"], join_style="mitre"
        )
        for barrel in layered["barrels"]
    ]
    barrel_tree = STRtree(barrel_shapes)
    for index, barrel in enumerate(layered["barrels"]):
        outer = barrel_shapes[index]
        for other_index in barrel_tree.query(outer, predicate="intersects"):
            if other_index <= index:
                continue
            other = layered["barrels"][other_index]
            if barrel["netId"] == other["netId"] or min(
                barrel["zMax"], other["zMax"]
            ) <= max(barrel["zMin"], other["zMin"]):
                continue
            other_outer = barrel_shapes[other_index]
            if outer.intersection(other_outer).area > 1e-10:
                raise ValueError("Different-net plated barrels overlap")
    copper = {}
    for foil in layered["stackup"]["copperLayers"]:
        groups = {}
        for group in layered["copper"]:
            if group["layer"] != foil["name"]:
                continue
            regions, planes = [], []
            for region in group["regions"]:
                shape = Polygon(
                    points(region["outer"]), [points(h) for h in region["holes"]]
                )
                if not shape.is_valid:
                    raise ValueError(
                        f"Invalid copper polygon on {foil['name']} for {group['netId']}"
                    )
                (planes if region.get("isPlane") else regions).append(shape)
            strips = [
                LineString([points([s["start"]])[0], points([s["end"]])[0]]).buffer(
                    s["width"] / 2,
                    quad_segs=8,
                    cap_style=trace_caps,
                    join_style="round",
                )
                for s in group["segments"]
            ]
            plane = unary_union(planes)
            if not plane.is_empty:
                clearances = unary_union(
                    [
                        (
                            Polygon(points(barrel["clearance"]))
                            if layered.get("antipadShape", "offset") == "bounding-box"
                            else (
                                Polygon(points(barrel["pads"]))
                                if foil["name"] in barrel["layers"]
                                else Polygon(points(barrel["hole"])).buffer(
                                    barrel["platingThickness"], join_style="mitre"
                                )
                            ).buffer(
                                layered["viaClearance"], quad_segs=8, join_style="round"
                            )
                        )
                        for barrel in layered["barrels"]
                        if barrel["zMin"] <= foil["zMin"]
                        and barrel["zMax"] >= foil["zMax"]
                        and group["netId"] != barrel["netId"]
                    ]
                )
                plane = plane.difference(clearances)
            groups[group["netId"]] = unary_union([*regions, *strips, plane])
        for barrel in layered["barrels"]:
            if barrel["zMin"] <= foil["zMin"] and barrel["zMax"] >= foil["zMax"]:
                hole = Polygon(points(barrel["hole"]))
                footprint = hole.buffer(
                    barrel["platingThickness"], join_style="mitre"
                ).difference(hole)
                if foil["name"] in barrel["layers"]:
                    footprint = unary_union(
                        [footprint, Polygon(points(barrel["pads"]))]
                    )
                groups[barrel["netId"]] = unary_union(
                    [groups.get(barrel["netId"], Polygon()), footprint]
                )
        drilled = unary_union(
            [
                Polygon(points(drill["hole"]))
                for drill in layered["drills"]
                if drill["zMin"] <= foil["zMin"] and drill["zMax"] >= foil["zMax"]
            ]
        )
        for net_id, shape in list(groups.items()):
            shape = shape.difference(drilled)
            if not shape.is_empty and not board.buffer(2e-6).covers(shape):
                raise ValueError(
                    f"Copper for {net_id} on {foil['name']} leaves the PCB"
                )
            groups[net_id] = shape.intersection(board)
        copper[foil["name"]] = groups
    return clean(board), {
        layer: {net: clean(shape) for net, shape in groups.items()}
        for layer, groups in copper.items()
    }


def copper_overlaps(copper):
    """Exact polygon intersections; the spatial index only filters candidates."""
    overlaps = []
    for layer, groups in copper.items():
        names = sorted(groups)
        shapes = [groups[name] for name in names]
        tree = STRtree(shapes)
        for index, shape in enumerate(shapes):
            for other_index in sorted(tree.query(shape, predicate="intersects")):
                if other_index <= index:
                    continue
                overlap = shape.intersection(shapes[other_index])
                if overlap.area > 1e-10:
                    overlaps.append(
                        {
                            "layer": layer,
                            "nets": [names[index], names[other_index]],
                            "areaMm2": overlap.area,
                            "boundsMm": list(overlap.bounds),
                        }
                    )
    return overlaps


def layer_copper(model):
    board, copper = build_layer_copper(model)
    overlaps = copper_overlaps(copper)
    if overlaps:
        first = overlaps[0]
        raise ValueError(
            f"Different nets overlap on {first['layer']}: {', '.join(first['nets'])}; area={first['areaMm2']:.9g} mm², bounds={tuple(first['boundsMm'])}"
        )
    return board, copper
