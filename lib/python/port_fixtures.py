"""Explicit ideal PEC end contacts for a rectangular uniform lumped port.

These are solver fixtures, not manufactured PCB copper. No dielectric/copper
volume is changed. Leave the unexcited side gaps open; never bridge the contacts.
"""

from shapely.geometry import Polygon, box
from shapely.affinity import affine_transform
import math
from planar import nonempty_polygons


def rectangular_fixture(port, width_fraction=0.95, clearance_mm=0.001):
    if not 0 < width_fraction <= 1:
        raise ValueError("Require a width fraction in (0, 1]")
    if not math.isfinite(clearance_mm) or clearance_mm <= 0:
        raise ValueError("Require a positive finite contact clearance")
    direction = port["direction"]
    if abs(direction[2]) > 1e-12:
        raise ValueError("Require a coplanar port")
    norm = (direction[0] ** 2 + direction[1] ** 2) ** 0.5
    if norm == 0:
        raise ValueError("Require a nonzero port direction")
    ux, uy = -direction[0] / norm, -direction[1] / norm
    vx, vy = -uy, ux
    x, y = port["positionMm"][:2]
    original = Polygon(port["outlineMm"])
    local = affine_transform(
        original, [ux, uy, vx, vy, -ux * x - uy * y, -vx * x - vy * y]
    )
    width = port["widthMm"] * width_fraction
    lo, _, hi, _ = local.bounds
    blocked = box(lo, -width / 2, hi, width / 2).difference(local)
    intervals = sorted((p.bounds[0], p.bounds[2]) for p in nonempty_polygons(blocked))
    free, cursor = [], lo
    for a, b in intervals:
        if a > cursor:
            free.append((cursor, a))
        cursor = max(cursor, b)
    if cursor < hi:
        free.append((cursor, hi))
    if not free:
        raise ValueError(f"No rectangular aperture fits {port['name']}")
    a, b = max(free, key=lambda i: i[1] - i[0])
    a, b = a + clearance_mm, b - clearance_mm
    if b - a <= 4 * clearance_mm:
        raise ValueError("No resolvable rectangular port gap")
    aperture = box(a, -width / 2, b, width / 2)
    if aperture.difference(local).area > 1e-12:
        raise ValueError("Rectangle leaves the original validated gap")
    margin = max(1, hi - lo)
    caps = [
        local.intersection(box(lo - margin, -margin, a, margin)),
        local.intersection(box(b, -margin, hi + margin, margin)),
    ]
    if any(
        len(nonempty_polygons(s)) != 1 or len(nonempty_polygons(s)[0].interiors)
        for s in caps
    ):
        raise ValueError("Contact extension is disconnected or has holes")
    if caps[0].distance(caps[1]) <= clearance_mm:
        raise ValueError("PEC fixture contacts short the port")
    inverse = [ux, vx, uy, vy, x, y]
    result = {
        k: v for k, v in port.items() if k not in ["faces", "attribute", "outlineMm"]
    }
    result.update(
        shape=affine_transform(aperture, inverse),
        widthMm=width,
        direction=[-ux, -uy, 0],
        fixtureModel="ideal PEC end-contact extensions",
        originalApertureOutlineMm=port["outlineMm"],
        fixtureWidthFraction=width_fraction,
        fixtureContactClearanceMm=clearance_mm,
        fixtureLengthMm=b - a,
    )
    contacts = [
        {
            "name": port["name"] + ":" + label,
            "zMm": port["zMm"],
            "shape": affine_transform(cap, inverse),
            "expectedNetId": net,
        }
        for label, cap, net in zip(
            ["signal-contact", "reference-contact"],
            caps,
            [port["signalNetId"], port["referenceNetId"]],
        )
    ]
    result["fixtureContactAreasMm2"] = [c["shape"].area for c in contacts]
    return result, contacts
