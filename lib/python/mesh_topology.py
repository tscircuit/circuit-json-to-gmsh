"""Independent tetrahedron/triangle incidence and connectivity checks."""

import gmsh
import numpy as np


def row_keys(rows):
    return (
        np.ascontiguousarray(rows)
        .view(np.dtype([(str(i), rows.dtype) for i in range(rows.shape[1])]))
        .reshape(-1)
    )


def read_tetrahedra():
    node_tags, positions, _ = gmsh.model.mesh.getNodes()
    order = np.argsort(node_tags)
    node_tags = node_tags[order]
    positions = np.asarray(positions).reshape(-1, 3)[order]
    _, first_coordinate, geometric_nodes = np.unique(
        np.round(positions / 1e-7).astype(np.int64),
        axis=0,
        return_index=True,
        return_inverse=True,
    )
    tetrahedra, tags, volumes = [], [], []
    unsupported = []
    for _, volume in gmsh.model.getEntities(3):
        for kind, element_tags, nodes in zip(*gmsh.model.mesh.getElements(3, volume)):
            if kind != 4:
                if len(element_tags):
                    unsupported.append(int(kind))
                continue
            tetrahedra.append(np.asarray(nodes, dtype=np.int64).reshape(-1, 4))
            tags.append(np.asarray(element_tags, dtype=np.int64))
            volumes.append(np.full(len(element_tags), volume, dtype=np.int64))
    tetrahedra = (
        np.concatenate(tetrahedra) if tetrahedra else np.empty((0, 4), dtype=np.int64)
    )
    indices = np.searchsorted(node_tags, tetrahedra)
    if len(indices) and (
        np.any(indices >= len(node_tags)) or np.any(node_tags[indices] != tetrahedra)
    ):
        raise ValueError("Tetrahedron references a missing node")
    return {
        "nodes": node_tags,
        "positions": positions,
        "geometricNodes": geometric_nodes,
        "geometricPositions": positions[first_coordinate],
        "geometricTetrahedra": geometric_nodes[indices],
        "tetrahedra": tetrahedra,
        "coordinates": positions[indices],
        "tags": np.concatenate(tags) if tags else np.empty(0, dtype=np.int64),
        "volumes": np.concatenate(volumes) if volumes else np.empty(0, dtype=np.int64),
        "unsupported": sorted(set(unsupported)),
    }


def physical_ownership(manifest):
    ownership, errors = {}, []
    expected = {v["tag"]: v for v in manifest.get("volumes", [])}
    for _, volume in gmsh.model.getEntities(3):
        groups = list(map(int, gmsh.model.getPhysicalGroupsForEntity(3, volume)))
        names = [gmsh.model.getPhysicalName(3, group) for group in groups]
        if len(names) != 1:
            errors.append(
                {
                    "volume": volume,
                    "physicalGroups": groups,
                    "reason": "expected one volume material",
                }
            )
            continue
        name = names[0]
        if not name.startswith(("copper:", "dielectric:")):
            errors.append(
                {"volume": volume, "name": name, "reason": "unknown material"}
            )
        if manifest and (volume not in expected or name != expected[volume]["name"]):
            errors.append(
                {"volume": volume, "name": name, "reason": "CAD ownership mismatch"}
            )
        ownership[volume] = name
    for volume in set(expected) - set(ownership):
        errors.append({"volume": volume, "reason": "missing CAD volume"})
    return ownership, errors


def face_incidence(mesh):
    faces = np.sort(
        mesh["tetrahedra"][:, [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]]].reshape(
            -1, 3
        ),
        axis=1,
    )
    unique, first, inverse, counts = np.unique(
        faces, axis=0, return_index=True, return_inverse=True, return_counts=True
    )
    last = np.empty(len(unique), dtype=np.int64)
    last[inverse] = np.arange(len(faces))
    return {
        "faces": unique,
        "keys": row_keys(unique),
        "counts": counts,
        "firstTet": first // 4,
        "lastTet": last // 4,
    }


def boundary_checks(mesh, incidence, manifest):
    errors, covered = [], np.zeros(len(incidence["faces"]), dtype=bool)
    expected_faces = {face["tag"]: face for face in manifest.get("faces", [])}
    actual_faces = {tag for _, tag in gmsh.model.getEntities(2)}
    for face in set(expected_faces) - actual_faces:
        errors.append({"face": face, "reason": "missing CAD boundary triangles"})
    for _, face in gmsh.model.getEntities(2):
        expected = expected_faces.get(face)
        triangles = []
        for kind, tags, nodes in zip(*gmsh.model.mesh.getElements(2, face)):
            if kind == 2:
                triangles.extend(np.asarray(nodes).reshape(-1, 3))
            elif len(tags):
                errors.append({"face": face, "reason": "unsupported boundary element"})
        if not triangles:
            errors.append({"face": face, "reason": "empty boundary"})
            continue
        keys = row_keys(np.sort(np.asarray(triangles, dtype=np.int64), axis=1))
        indices = np.searchsorted(incidence["keys"], keys)
        present = indices < len(incidence["keys"])
        present[present] &= incidence["keys"][indices[present]] == keys[present]
        if not np.all(present):
            errors.append(
                {
                    "face": face,
                    "reason": "triangle is not a tetrahedron face",
                    "triangles": int(np.sum(~present)),
                }
            )
        indices = indices[present]
        covered[indices] = True
        if expected:
            owners = expected["volumes"]
            adjacent = np.sort(
                np.column_stack(
                    (
                        mesh["volumes"][incidence["firstTet"][indices]],
                        mesh["volumes"][incidence["lastTet"][indices]],
                    )
                ),
                axis=1,
            )
            required = sorted(owners * (2 if len(owners) == 1 else 1))
            wrong = (incidence["counts"][indices] != len(owners)) | np.any(
                adjacent != required, axis=1
            )
            if np.any(wrong):
                errors.append(
                    {
                        "face": face,
                        "reason": "nonconformal CAD interface",
                        "triangles": int(np.sum(wrong)),
                        "expectedVolumes": owners,
                    }
                )
    exterior = incidence["counts"] == 1
    # Catch coincident triangles using different node tags even without a CAD
    # ownership manifest. Coordinate tolerance: 1e-7 mm, below CAD precision.
    exterior_nodes = np.searchsorted(mesh["nodes"], incidence["faces"][exterior])
    geometric_faces = np.sort(mesh["geometricNodes"][exterior_nodes], axis=1)
    _, coincident = np.unique(geometric_faces, axis=0, return_counts=True)
    if np.any(coincident > 1):
        errors.append(
            {
                "reason": "coincident interface triangles use disconnected node tags",
                "triangles": int(np.sum(coincident[coincident > 1])),
            }
        )
    if np.any(exterior & ~covered):
        errors.append(
            {
                "reason": "tetrahedron exterior is missing boundary triangles",
                "triangles": int(np.sum(exterior & ~covered)),
            }
        )
    return errors


def copper_components(mesh, incidence, ownership):
    parents = np.arange(len(mesh["tags"]), dtype=np.int64)
    names = np.array([ownership.get(int(v), "") for v in mesh["volumes"]])
    shared = incidence["counts"] == 2
    first, last = incidence["firstTet"][shared], incidence["lastTet"][shared]
    same_copper = (names[first] == names[last]) & np.char.startswith(
        names[first], "copper:"
    )
    for a, b in zip(first[same_copper], last[same_copper]):
        while parents[a] != a:
            parents[a] = parents[parents[a]]
            a = parents[a]
        while parents[b] != b:
            parents[b] = parents[parents[b]]
            b = parents[b]
        if a != b:
            parents[max(a, b)] = min(a, b)
    while np.any(parents != parents[parents]):
        parents = parents[parents]
    components = {
        name.removeprefix("copper:"): int(len(np.unique(parents[names == name])))
        for name in np.unique(names)
        if name.startswith("copper:")
    }
    # Coincident nodes with different tags also count as cross-net contacts.
    # Coordinate tolerance: 1e-7 mm, below the native CAD precision.
    contacts = {}
    for name in np.unique(names):
        if not name.startswith("copper:"):
            continue
        for node in np.unique(mesh["geometricTetrahedra"][names == name]):
            contacts.setdefault(int(node), set()).add(name)
    shorts = [
        {
            "positionMm": mesh["geometricPositions"][node].tolist(),
            "nets": sorted(n.removeprefix("copper:") for n in nets),
        }
        for node, nets in contacts.items()
        if len(nets) > 1
    ]
    return parents, components, shorts
