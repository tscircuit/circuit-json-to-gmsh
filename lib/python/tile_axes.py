"""Move artificial partition planes away from near-parallel copper edges.

Only interior CAD subdivisions move. The board, copper, drills and analysis
boundary do not change. Avoiding grazing partitions prevents tiny CAD pieces
that a nominal grid can create through otherwise resolvable physical solids.
"""

from bisect import bisect_left
from planar import nonempty_polygons


def safe_axes(bounds, size, copper, barrels, drills):
    clearance, maximum_shift = 0.002, 0.025
    coordinates = [set(), set()]
    for nets in copper.values():
        for shape in nets.values():
            for polygon in nonempty_polygons(shape):
                for ring in [polygon.exterior, *polygon.interiors]:
                    for a, b in zip(ring.coords, list(ring.coords)[1:]):
                        if abs(a[0] - b[0]) <= 1e-7 and abs(a[1] - b[1]) >= 0.01:
                            coordinates[0].add((a[0] + b[0]) / 2)
                        if abs(a[1] - b[1]) <= 1e-7 and abs(a[0] - b[0]) >= 0.01:
                            coordinates[1].add((a[1] + b[1]) / 2)
    for _, shape in [*barrels, *drills]:
        x0, y0, x1, y1 = shape.bounds
        coordinates[0].update([x0, x1])
        coordinates[1].update([y0, y1])
    axes, adjustments = [], []
    for axis, (low, high) in enumerate(
        [(bounds[0], bounds[2]), (bounds[1], bounds[3])]
    ):
        forbidden = []
        for coordinate in sorted(coordinates[axis]):
            start, end = coordinate - clearance, coordinate + clearance
            if forbidden and start <= forbidden[-1][1]:
                forbidden[-1][1] = max(end, forbidden[-1][1])
            else:
                forbidden.append([start, end])
        starts = [interval[0] for interval in forbidden]
        values, nominal = [low], low + size
        while nominal < high - 1e-8:
            actual = nominal
            index = bisect_left(starts, nominal) - 1
            if index >= 0 and forbidden[index][0] <= nominal <= forbidden[index][1]:
                start, end = forbidden[index]
                candidates = [start - 1e-6, end + 1e-6]
                candidates = [
                    v for v in candidates if values[-1] + 1e-4 < v < high - 1e-4
                ]
                if not candidates:
                    raise ValueError("No room for a safe internal tile plane")
                actual = min(candidates, key=lambda v: (abs(v - nominal), v))
                if abs(actual - nominal) > maximum_shift:
                    raise ValueError(
                        "Safe internal tile plane would exceed 0.025 mm shift"
                    )
                adjustments.append(
                    {
                        "axis": "xy"[axis],
                        "nominalMm": nominal,
                        "actualMm": actual,
                        "shiftMm": actual - nominal,
                    }
                )
            if not values[-1] + 1e-8 < actual < high - 1e-8:
                raise ValueError("Safe tile axes must remain strictly ordered")
            values.append(actual)
            nominal += size
        values.append(high)
        axes.append(values)
    return axes, {
        "axesMm": axes,
        "nominalSizeMm": size,
        "minimumParallelClearanceMm": clearance,
        "maximumShiftMm": maximum_shift,
        "adjustments": adjustments,
        "physicalGeometryChanged": False,
    }
