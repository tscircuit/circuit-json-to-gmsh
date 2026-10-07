"""Explicit coplanar conductor-to-reference port apertures for EM consumers.

Port labels do not supply a frequency: that belongs to the solver's sweep.
Apertures must connect the intended copper and cannot cross other conductors.
"""

import gmsh
from shapely.geometry import Point, LineString, Polygon
from shapely.ops import unary_union, nearest_points
from planar import nonempty_polygons
from cad import ring


def prepare_ports(model, board, copper, requirements):
    ports = []
    for requirement in requirements:
        terminal = requirement["terminal"]
        x, y, z = terminal["positionMm"]
        foil = next(
            (
                f
                for f in model["multilayer"]["stackup"]["copperLayers"]
                if f["zMin"] - 1e-8 <= z <= f["zMax"] + 1e-8
            ),
            None,
        )
        if not foil or foil["name"] not in ["top", "bottom"]:
            raise ValueError("Coplanar pad ports require an outer-layer terminal")
        groups = copper[foil["name"]]
        signal = groups.get(terminal["netId"], Polygon())
        reference = groups.get(requirement["referenceNetId"], Polygon())
        contact = Point(x, y)
        width = requirement.get("widthMm", 0.08)
        if width <= 0 or not signal.buffer(1e-6).covers(contact) or reference.is_empty:
            raise ValueError("Port lacks its intended signal/reference copper")
        if requirement["referenceNetId"] == terminal["netId"]:
            raise ValueError("Port terminals must be on different nets")
        source, target = nearest_points(contact, reference)
        dx, dy = target.x - source.x, target.y - source.y
        length = (dx * dx + dy * dy) ** 0.5
        if length < 2e-6:
            raise ValueError("Port has no resolvable signal/reference gap")
        line = LineString(
            [source, (target.x + dx / length * width, target.y + dy / length * width)]
        )
        patch = line.buffer(width / 2, cap_style="flat").difference(
            unary_union(list(groups.values()))
        )
        pieces = nonempty_polygons(patch)
        if len(pieces) != 1 or len(pieces[0].interiors):
            raise ValueError(f"Port {terminal['name']} has an obstructed gap")
        patch = pieces[0]
        for net, conductor in groups.items():
            if conductor.is_empty or conductor.area == 0:
                continue
            if net in [terminal["netId"], requirement["referenceNetId"]]:
                continue
            if (
                patch.boundary.intersection(conductor.boundary.buffer(2e-6)).length
                > 2e-6
            ):
                raise ValueError(
                    f"Port {terminal['name']} contacts a third conductor: {net}"
                )
        if not board.buffer(1e-6).covers(patch):
            raise ValueError("Port aperture leaves the PCB analysis crop")
        for conductor in [signal, reference]:
            if (
                patch.boundary.intersection(conductor.boundary.buffer(2e-6)).length
                < width * 0.5
            ):
                raise ValueError("Port does not contact both intended conductors")
        if any(patch.intersection(p["shape"]).area > 1e-10 for p in ports):
            raise ValueError("Port apertures overlap")
        ports.append(
            {
                "name": terminal["name"],
                "signalNetId": terminal["netId"],
                "referenceNetId": requirement["referenceNetId"],
                "positionMm": terminal["positionMm"],
                "referencePositionMm": [
                    *reference.intersection(target.buffer(width / 3))
                    .representative_point()
                    .coords[0],
                    (foil["zMin"] + foil["zMax"]) / 2,
                ],
                "widthMm": width,
                "direction": [-dx / length, -dy / length, 0],
                "zMm": foil["zMax"] if foil["name"] == "top" else foil["zMin"],
                "shape": patch,
            }
        )
    return ports


def imprint_ports(solids, ports):
    for port in ports:
        z = port["zMm"]
        selected = [
            s for s in solids if abs(s["zMin"] - z) < 1e-8 or abs(s["zMax"] - z) < 1e-8
        ]
        face = (
            2,
            gmsh.model.occ.addPlaneSurface([ring(port["shape"].exterior.coords, z)]),
        )
        entities = [e for s in selected for e in s["entities"]]
        _, history = gmsh.model.occ.fragment(entities, [face])
        offset = 0
        for solid in selected:
            count = len(solid["entities"])
            solid["entities"] = sorted(
                {
                    tuple(e)
                    for h in history[offset : offset + count]
                    for e in h
                    if e[0] == 3
                }
            )
            offset += count
        port["faces"] = [t for d, t in history[-1] if d == 2]
    gmsh.model.occ.synchronize()
    return resolve_ports(ports)


def resolve_ports(ports):
    for index, port in enumerate(ports):
        # Later imprints may replace a coplanar face. Resolve final topology by
        # containment and area, rather than trusting stale OCC face tags.
        tags = []
        for _, face in gmsh.model.getEntities(2):
            x, y, z = gmsh.model.occ.getCenterOfMass(2, face)
            if abs(z - port["zMm"]) > 1e-8 or not port["shape"].buffer(1e-6).covers(
                Point(x, y)
            ):
                continue
            lower = gmsh.model.getBoundingBox(2, face)
            if lower[5] - lower[2] > 1e-6:
                continue
            tags.append(face)
        area = sum(gmsh.model.occ.getMass(2, t) for t in tags)
        if abs(area - port["shape"].area) > max(1e-8, port["shape"].area * 1e-5):
            raise ValueError("Native port surface coverage changed")
        port["faces"] = tags
        port["attribute"] = 100001 + index
        gmsh.model.addPhysicalGroup(2, tags, port["attribute"], "port:" + port["name"])
    return [
        {k: v for k, v in p.items() if k != "shape"}
        | {"outlineMm": list(p["shape"].exterior.coords)}
        for p in ports
    ]
