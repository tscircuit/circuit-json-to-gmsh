"""Add an independently constructed tetrahedron to a TSX board's physical void."""

import argparse
import json
from pathlib import Path
import gmsh
import numpy as np

p = argparse.ArgumentParser()
p.add_argument("--mesh", required=True)
p.add_argument("--manifest", required=True)
p.add_argument("--output", required=True)
p.add_argument("--material", choices=["air", "dielectric"], required=True)
a = p.parse_args()
manifest = json.loads(Path(a.manifest).read_text())
gmsh.initialize()
gmsh.option.setNumber("General.Terminal", 0)
gmsh.open(a.mesh)
face_tag = max(t for _, t in gmsh.model.getEntities(2)) + 1
faces = [gmsh.model.addDiscreteEntity(2, face_tag + i) for i in range(4)]
volume_tag = gmsh.model.addDiscreteEntity(
    3, max(t for _, t in gmsh.model.getEntities(3)) + 1, faces
)
node_tag = int(max(gmsh.model.mesh.getNodes()[0])) + 1
nodes = list(range(node_tag, node_tag + 4))
xyz = np.array([[-0.3, -1.8, 0.3], [0.3, -1.8, 0.3], [0, -1.2, 0.3], [0, -1.5, 0.32]])
gmsh.model.mesh.addNodes(3, volume_tag, nodes, xyz.flatten())
gmsh.model.mesh.addElementsByType(volume_tag, 4, [], nodes)
for face, indices in zip(faces, [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]]):
    gmsh.model.mesh.addElementsByType(face, 2, [], [nodes[i] for i in indices])
name = "air" if a.material == "air" else "dielectric:test-cell"
attribute = max(t for _, t in gmsh.model.getPhysicalGroups(3)) + 1
gmsh.model.addPhysicalGroup(3, [volume_tag], attribute, name)
attribute = max(t for _, t in gmsh.model.getPhysicalGroups(2)) + 1
gmsh.model.addPhysicalGroup(2, faces, attribute, "exterior:" + name)
manifest["volumes"].append(
    {
        "tag": volume_tag,
        "name": name,
        "material": a.material,
        "volumeMm3": float(np.linalg.det(xyz[1:] - xyz[:1]) / 6),
    }
)
manifest["faces"].extend(
    {"tag": face, "volumes": [volume_tag], "name": "exterior:" + name} for face in faces
)
gmsh.option.setNumber("Mesh.MshFileVersion", 2.2)
gmsh.write(a.output)
Path(a.output + ".manifest.json").write_text(json.dumps(manifest))
gmsh.finalize()
