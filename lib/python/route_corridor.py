"""A recorded analysis-domain crop around selected circuit-json routes."""

from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union
from planar import points, clean


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
    return clean(unary_union([region, *additions])), barrels
