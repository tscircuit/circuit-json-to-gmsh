"""A recorded analysis-domain crop around selected circuit-json routes."""

from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union
from planar import points, clean
from simplify_copper import vertices, topology


def route_corridor(options):
    model, nets, margin = [options[k] for k in ["model", "netIds", "marginMm"]]
    strips = [
        LineString(points([s["start"], s["end"]])).buffer(margin, quad_segs=8)
        for copper in model["multilayer"]["copper"]
        if copper["netId"] in nets
        for s in copper["segments"]
    ]
    if not strips:
        raise ValueError("Route corridor has no selected trace segments")
    region = clean(unary_union(strips))
    # Include entire barrel walls at the crop edge, avoiding artificial caps
    # just a fraction of a micrometre wide. Every expansion is recorded.
    additions, barrels = [], []
    for index, barrel in enumerate(model["multilayer"]["barrels"]):
        outer = clean(
            Polygon(points(barrel["hole"])).buffer(
                barrel["platingThickness"], join_style="mitre"
            )
        )
        if region.intersects(outer) and not region.covers(outer):
            additions.append(outer.buffer(0.05, quad_segs=8))
            barrels.append(index)
    original = clean(unary_union([region, *additions]))
    # Rounded buffer unions can leave almost-collinear, tens-of-nanometres
    # crop edges. These are artificial domain boundaries, not PCB outlines.
    tolerance = 1e-5
    candidate = clean(original.simplify(tolerance, preserve_topology=True))
    displacement = original.boundary.hausdorff_distance(candidate.boundary)
    if topology(candidate) != topology(original) or displacement > tolerance + 2e-6:
        raise ValueError("Route corridor regularization exceeded its bounds")
    for index in barrels:
        barrel = model["multilayer"]["barrels"][index]
        outer = clean(
            Polygon(points(barrel["hole"])).buffer(
                barrel["platingThickness"], join_style="mitre"
            )
        )
        if not candidate.covers(outer):
            raise ValueError("Route corridor regularization clipped a protected barrel")
    receipt = {
        "toleranceMm": tolerance,
        "boundaryDisplacementMm": displacement,
        "verticesBefore": vertices(original),
        "verticesAfter": vertices(candidate),
        "addedAreaMm2": float(candidate.difference(original).area),
        "removedAreaMm2": float(original.difference(candidate).area),
    }
    return candidate, barrels, receipt
