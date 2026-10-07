"""Parallel-plate TEM benchmark with an exact matched scattering response."""

import argparse
import json
import math
from pathlib import Path
import gmsh

p = argparse.ArgumentParser()
p.add_argument("--out", required=True)
p.add_argument("--size", type=float, default=1)
a = p.parse_args()
out = Path(a.out)
out.mkdir(parents=True, exist_ok=True)
length, width, height, er = 10, 5, 0.2, 4
impedance = 376.730313668 / math.sqrt(er) * height / width
gmsh.initialize()
gmsh.option.setNumber("General.Terminal", 0)
gmsh.model.add("TEM-benchmark")
v = gmsh.model.occ.addBox(0, 0, 0, length, width, height)
gmsh.model.occ.synchronize()
gmsh.model.addPhysicalGroup(3, [v], 1, "dielectric")
for axis, coord, attr in [(0, 0, 2001), (0, length, 2002)]:
    tags = [
        t
        for _, t in gmsh.model.getEntities(2)
        if abs(gmsh.model.occ.getCenterOfMass(2, t)[axis] - coord) < 1e-8
    ]
    gmsh.model.addPhysicalGroup(2, tags, attr, "port-" + str(attr - 2000))
pec = [
    t
    for _, t in gmsh.model.getEntities(2)
    if min(
        abs(gmsh.model.occ.getCenterOfMass(2, t)[2]),
        abs(gmsh.model.occ.getCenterOfMass(2, t)[2] - height),
    )
    < 1e-8
]
gmsh.model.addPhysicalGroup(2, pec, 2100, "PEC")
gmsh.option.setNumber("Mesh.MeshSizeMin", a.size)
gmsh.option.setNumber("Mesh.MeshSizeMax", a.size)
gmsh.option.setNumber("Mesh.MshFileVersion", 2.2)
gmsh.model.mesh.generate(3)
gmsh.write(str(out / "palace.msh"))
config = {
    "Problem": {"Type": "Driven", "Verbose": 2, "Output": "postpro"},
    "Model": {
        "Mesh": "palace.msh",
        "L0": 0.001,
        "Lc": 1,
        "CrackInternalBoundaryElements": False,
    },
    "Domains": {
        "Materials": [{"Attributes": [1], "Permittivity": er, "Permeability": 1}]
    },
    "Boundaries": {
        "PEC": {"Attributes": [2100]},
        "LumpedPort": [
            {
                "Index": i + 1,
                "Attributes": [2001 + i],
                "Direction": "+Z",
                "R": impedance,
                **({"Excitation": True} if i == 0 else {}),
            }
            for i in range(2)
        ],
    },
    "Solver": {
        "Order": 1,
        "Device": "CPU",
        "Driven": {"Samples": [{"Type": "Point", "Freq": [0.1, 0.4, 1, 2, 5]}]},
        "Linear": {"Type": "SuperLU", "KSPType": "GMRES", "Tol": 1e-10, "MaxIts": 200},
    },
}
(out / "palace.json").write_text(json.dumps(config, indent=2))
(out / "analytical.json").write_text(
    json.dumps(
        {
            "lengthMm": length,
            "widthMm": width,
            "heightMm": height,
            "er": er,
            "impedanceOhms": impedance,
            "flightTimeSeconds": length * 0.001 * math.sqrt(er) / 299792458,
            "expectedS11": 0,
            "expectedS21": "exp(-j*2*pi*f*flightTimeSeconds)",
            "meshSizeMm": a.size,
            "tets": sum(
                len(t) for k, t, n in zip(*gmsh.model.mesh.getElements(3)) if k == 4
            ),
        },
        indent=2,
    )
)
gmsh.finalize()
