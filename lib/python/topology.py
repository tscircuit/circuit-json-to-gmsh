"""Detect pinched polygon holes that are legal in GEOS but invalid OCC solids."""

from shapely.geometry import LineString, box, mapping
from shapely.ops import unary_union
from shapely.strtree import STRtree
from shapely import difference, set_precision
from planar import nonempty_polygons


class TopologyError(ValueError):
    def __init__(self, reproduction):
        self.reproduction = reproduction
        super().__init__("Polygon hole touches another boundary; see failure.json")


def contacts(polygon):
    rings = [
        LineString(polygon.exterior.coords),
        *[LineString(r.coords) for r in polygon.interiors],
    ]
    tree = STRtree(rings)
    result = []
    for index, ring in enumerate(rings):
        for other in tree.query(ring, predicate="intersects"):
            if other <= index:
                continue
            intersection = ring.intersection(rings[other])
            if intersection.geom_type == "Point":
                result.append((intersection.x, intersection.y))
            elif intersection.geom_type == "MultiPoint":
                result.extend((p.x, p.y) for p in intersection.geoms)
            elif not intersection.is_empty:
                raise ValueError("Copper boundaries share an edge, not just a point")
    return sorted(set(result))


def regularize(polygon, options):
    radius = options["radiusMm"]
    context = options.get("context", {})
    touching = contacts(polygon)
    if not touching:
        return polygon, []
    reproduction = {"solid": context, "contactsMm": touching, "shape": mapping(polygon)}
    if radius == 0:
        raise TopologyError(reproduction)
    notches = unary_union(
        [box(x - radius, y - radius, x + radius, y + radius) for x, y in touching]
    )
    # Keep exact intersections at the notch. Re-snapping these new vertices can
    # move a long boundary outside the declared local repair rectangle.
    polygon = set_precision(polygon, 0)
    fixed = difference(polygon, notches, grid_size=0)
    if (
        fixed.is_empty
        or len(nonempty_polygons(fixed)) != 1
        or not fixed.is_valid
        or contacts(fixed)
    ):
        raise ValueError(
            "Topology repair would split copper or leaves invalid boundaries"
        )
    if not polygon.buffer(1e-9).covers(fixed):
        raise ValueError("Topology repair unexpectedly adds copper")
    removed = polygon.area - fixed.area
    if removed < -1e-10 or removed > notches.area + 1e-10:
        raise ValueError("Topology repair exceeds its declared bounds")
    return fixed, [
        {
            "solid": context,
            "contactsMm": touching,
            "notchHalfWidthMm": radius,
            "removedAreaMm2": removed,
            "boundsMm": list(notches.bounds),
        }
    ]
