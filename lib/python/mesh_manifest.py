"""Preserve CAD ownership and boundary triangles in a reloadable MSH export."""

import gmsh


def mesh_manifest(solids):
    volumes = {}
    for solid in solids:
        for _, tag in solid["entities"]:
            owner = {
                k: solid[k]
                for k in ("name", "material", "netId", "layer", "zMin", "zMax")
                if k in solid
            }
            if tag in volumes and volumes[tag]["name"] != owner["name"]:
                raise ValueError(f"CAD volume {tag} belongs to multiple materials")
            volumes[tag] = owner | {
                "tag": tag,
                "volumeMm3": gmsh.model.occ.getMass(3, tag),
            }
    if set(volumes) != {tag for _, tag in gmsh.model.getEntities(3)}:
        raise ValueError("CAD has unowned volumes")
    faces = []
    boundaries = {}
    for _, face in gmsh.model.getEntities(2):
        owners = sorted(map(int, gmsh.model.getAdjacencies(2, face)[0]))
        if not 1 <= len(owners) <= 2:
            raise ValueError(f"CAD face {face} has {len(owners)} adjacent volumes")
        names = sorted({volumes[tag]["name"] for tag in owners})
        name = ("exterior:" if len(owners) == 1 else "interface:") + "|".join(names)
        boundaries.setdefault(name, []).append(face)
        faces.append({"tag": face, "volumes": owners, "name": name})
    for attribute, (name, tags) in enumerate(sorted(boundaries.items()), 1001):
        gmsh.model.addPhysicalGroup(2, tags, attribute, name)
    return {
        "schemaVersion": 1,
        "units": "mm",
        "volumes": list(volumes.values()),
        "faces": faces,
    }
