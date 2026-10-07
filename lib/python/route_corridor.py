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
    # A wall-only envelope plus 0.05 mm can nearly graze a larger pad, leaving
    # nanometre boundary edges. Protect the full pad and wall with clearance.
    footprints = [
        clean(
            unary_union(
                [
                    Polygon(points(b["hole"])).buffer(
                        b["platingThickness"], join_style="mitre"
                    ),
                    Polygon(points(b["pads"])),
                ]
            )
        )
        for b in model["multilayer"]["barrels"]
    ]
    original = region
    barrels = []
    protected = set()
    for _ in range(len(footprints) + 1):
        additions = []
        inset = original.buffer(-0.01)
        for index, footprint in enumerate(footprints):
            if index in protected or not original.intersects(footprint):
                continue
            protected.add(index)
            if not inset.covers(footprint):
                additions.append(footprint.buffer(0.05, quad_segs=8))
                barrels.append(index)
        if not additions:
            break
        original = clean(unary_union([original, *additions]))
    else:
        raise ValueError("Pad-envelope crop expansion did not terminate")
    # Rounded buffer unions can leave almost-collinear, tens-of-nanometres
    # crop edges. These are artificial domain boundaries, not PCB outlines.
    tolerance = 1e-5
    candidate = clean(original.simplify(tolerance, preserve_topology=True))
    displacement = original.boundary.hausdorff_distance(candidate.boundary)
    if topology(candidate) != topology(original) or displacement > tolerance + 2e-6:
        raise ValueError("Route corridor regularization exceeded its bounds")
    for index in protected:
        if not candidate.buffer(-0.00998).covers(footprints[index]):
            raise ValueError(
                "Route corridor clipped a protected via pad or its clearance"
            )
    receipt = {
        "toleranceMm": tolerance,
        "protectedEnvelope": "whole via pads and plated walls",
        "minimumPadClearanceMm": 0.00998,
        "expansionPaddingMm": 0.05,
        "protectedBarrelIndices": sorted(protected),
        "boundaryDisplacementMm": displacement,
        "verticesBefore": vertices(original),
        "verticesAfter": vertices(candidate),
        "addedAreaMm2": float(candidate.difference(original).area),
        "removedAreaMm2": float(original.difference(candidate).area),
    }
    return candidate, barrels, receipt
