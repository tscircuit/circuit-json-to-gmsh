"""Optional, bounded GEOS contour simplification; physical voids remain exact."""

from shapely.geometry import Polygon
from shapely.ops import unary_union
from planar import clean, nonempty_polygons, points, copper_overlaps


def vertices(shape):
    return sum(
        len(p.exterior.coords) + sum(len(h.coords) for h in p.interiors)
        for p in nonempty_polygons(shape)
    )


def topology(shape):
    polygons = nonempty_polygons(shape)
    return (len(polygons), sum(len(p.interiors) for p in polygons))


def simplify_copper(options):
    model, board, copper, tolerance = [
        options[k] for k in ["model", "board", "copper", "toleranceMm"]
    ]
    if tolerance == 0:
        return copper, []
    result, receipts = {}, []
    for foil in model["multilayer"]["stackup"]["copperLayers"]:
        layer = foil["name"]
        drills = clean(
            unary_union(
                [
                    Polygon(points(d["hole"]))
                    for d in model["multilayer"]["drills"]
                    if d["zMin"] <= foil["zMin"] and d["zMax"] >= foil["zMax"]
                ]
            )
        )
        result[layer] = {}
        for net, original in copper[layer].items():
            original = unary_union(nonempty_polygons(original))
            candidate = clean(
                unary_union(
                    nonempty_polygons(
                        original.simplify(tolerance, preserve_topology=True)
                        .intersection(board)
                        .difference(drills)
                    )
                )
            )
            displacement = (
                float(original.boundary.hausdorff_distance(candidate.boundary))
                if not original.is_empty and not candidate.is_empty
                else 0
            )
            accepted = (
                candidate.is_valid
                and topology(candidate) == topology(original)
                and displacement <= tolerance + 2e-6
                and vertices(candidate) <= vertices(original)
            )
            if not accepted:
                candidate = original
            result[layer][net] = candidate
            receipts.append(
                {
                    "layer": layer,
                    "netId": net,
                    "accepted": accepted,
                    "verticesBefore": vertices(original),
                    "verticesAfter": vertices(candidate),
                    "boundaryDisplacementMm": displacement if accepted else 0,
                    "addedAreaMm2": float(candidate.difference(original).area),
                    "removedAreaMm2": float(original.difference(candidate).area),
                }
            )
    overlaps = copper_overlaps(result)
    if overlaps:
        raise ValueError(
            f"Contour simplification introduced copper overlap: {overlaps[:3]}"
        )
    return result, receipts
