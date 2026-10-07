"""PCB void intersection and endpoint checks against saved tetrahedra."""

import numpy as np
from shapely import box
from shapely.geometry import MultiPoint, Polygon
from shapely.strtree import STRtree
from planar import points


def clipped_projection(coordinates, span):
    lower, upper = span
    if (
        np.max(coordinates[:, 2]) <= lower + 1e-10
        or np.min(coordinates[:, 2]) >= upper - 1e-10
    ):
        return Polygon()
    vertices = [p[:2] for p in coordinates if lower <= p[2] <= upper]
    for i in range(4):
        for j in range(i + 1, 4):
            a, b = coordinates[i], coordinates[j]
            for z in span:
                if min(a[2], b[2]) < z < max(a[2], b[2]):
                    vertices.append((a + (b - a) * ((z - a[2]) / (b[2] - a[2])))[:2])
    return MultiPoint(vertices).convex_hull if vertices else Polygon()


def void_intersections(mesh, model):
    layered = model["multilayer"]
    voids = [
        {
            "id": f"drill/{i}",
            "shape": Polygon(points(drill["hole"])).buffer(-2e-6),
            "span": [drill["zMin"], drill["zMax"]],
        }
        for i, drill in enumerate(layered["drills"])
    ]
    voids.extend(
        {
            "id": f"cutout/{i}",
            "shape": Polygon(points(outline)).buffer(-2e-6),
            "span": [-np.inf, np.inf],
        }
        for i, outline in enumerate(layered["boardCutouts"])
    )
    violations = []
    if not voids:
        return violations
    tree = STRtree([v["shape"] for v in voids])
    coordinates = mesh["coordinates"]
    minimum, maximum = (
        np.min(coordinates[:, :, :2], axis=1),
        np.max(coordinates[:, :, :2], axis=1),
    )
    for first in range(0, len(coordinates), 10000):
        boxes = box(
            minimum[first : first + 10000, 0],
            minimum[first : first + 10000, 1],
            maximum[first : first + 10000, 0],
            maximum[first : first + 10000, 1],
        )
        for offset, candidate in tree.query(boxes).T:
            index = first + offset
            void = voids[candidate]
            projected = clipped_projection(coordinates[index], void["span"])
            area = projected.intersection(void["shape"]).area
            # Polygon tessellation/GEOS rounding tolerances are in square mm.
            if area > 1e-10:
                violations.append(
                    {
                        "tetrahedron": int(mesh["tags"][index]),
                        "void": void["id"],
                        "projectionOverlapMm2": float(area),
                        "coordinatesMm": coordinates[index].tolist(),
                    }
                )
                if len(violations) == 20:
                    return violations
    return violations


def terminal_checks(options):
    mesh, ownership, components, requirements = [
        options[k] for k in ["mesh", "ownership", "components", "requirements"]
    ]
    contacts, errors = {}, []
    for terminal in requirements.get("terminals", []):
        position = np.asarray(terminal["positionMm"], dtype=float)
        candidates = np.array(
            [
                ownership.get(int(v)) == "copper:" + terminal["netId"]
                for v in mesh["volumes"]
            ]
        )
        candidates &= np.all(
            position >= np.min(mesh["coordinates"], axis=1) - 1e-8, axis=1
        )
        candidates &= np.all(
            position <= np.max(mesh["coordinates"], axis=1) + 1e-8, axis=1
        )
        indices = np.flatnonzero(candidates)
        if len(indices):
            tetrahedra = mesh["coordinates"][indices]
            edges = np.swapaxes(tetrahedra[:, 1:] - tetrahedra[:, :1], 1, 2)
            try:
                barycentric = np.linalg.solve(
                    edges, (position - tetrahedra[:, 0])[..., None]
                )[..., 0]
                inside = np.all(barycentric >= -1e-7, axis=1) & (
                    np.sum(barycentric, axis=1) <= 1 + 1e-7
                )
                indices = indices[inside]
            except np.linalg.LinAlgError:
                indices = np.array([], dtype=int)
        roots = sorted(set(map(int, components[indices])))
        contacts[terminal["name"]] = {
            "netId": terminal["netId"],
            "positionMm": terminal["positionMm"],
            "components": roots,
            "tetrahedra": list(map(int, mesh["tags"][indices])),
        }
        if len(roots) != 1:
            errors.append(
                {
                    "terminal": terminal["name"],
                    "reason": "terminal must contact exactly one meshed copper component",
                    "components": roots,
                }
            )
    connections = []
    for connection in requirements.get("connections", []):
        a, b = [contacts.get(connection[k]) for k in ["from", "to"]]
        passed = bool(
            a
            and b
            and a["netId"] == b["netId"]
            and len(a["components"]) == 1
            and a["components"] == b["components"]
        )
        connections.append(connection | {"passed": passed})
        if not passed:
            errors.append(
                connection | {"reason": "no meshed copper path between terminals"}
            )
    return {"terminals": contacts, "connections": connections, "errors": errors}
