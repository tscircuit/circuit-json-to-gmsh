"""Rebuild the isolated AM3352 source solids, before and after repair."""

import argparse
import json
import sys
from pathlib import Path
import gmsh
from shapely.geometry import shape

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "lib/python"))
from cad import prism
from topology import regularize
from export import preview_solids
from validate_brep import validate


def reproduce(options):
    source = root / "examples/am3352"
    provenance = json.loads((source / "provenance.json").read_text())
    case = next(c for c in provenance["cases"] if c["name"] == options.case)
    polygon = shape(json.loads((source / f"{options.case}.geojson").read_text()))
    destination = Path(options.output)
    destination.mkdir(parents=True, exist_ok=True)
    receipts = []
    for repaired in [False, True]:
        name = options.case + ("-fixed" if repaired else "-original")
        geometry, repairs = (
            regularize(polygon, {"radiusMm": 0.0001, "context": case})
            if repaired
            else (polygon, [])
        )
        gmsh.initialize()
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add(name)
        try:
            entities, volume = prism(
                {"shape": geometry, "zMin": case["zMinMm"], "zMax": case["zMaxMm"]}
            )
            gmsh.model.occ.synchronize()
            path = destination / f"{name}.brep"
            gmsh.write(str(path))
            if repaired:
                gmsh.model.mesh.generate(2)
                preview = preview_solids(
                    [
                        {
                            "id": name,
                            "material": "copper",
                            "layer": case.get(
                                "layer",
                                "top"
                                if options.case == "top-pinched-hole"
                                else "bottom",
                            ),
                            "entities": entities,
                        }
                    ]
                )
                (destination / f"{name}.preview.json").write_text(json.dumps(preview))
        finally:
            gmsh.finalize()
        receipts.append(
            {
                "case": name,
                "volumeMm3": volume,
                "repairs": repairs,
                **validate(str(path)),
            }
        )
    (destination / "validity.json").write_text(json.dumps(receipts, indent=2))
    print(json.dumps(receipts, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--case",
        choices=["top-pinched-hole", "bottom-touching-antipads", "ddr-vref-inner1"],
        required=True,
    )
    parser.add_argument("--output", default="work/reproductions")
    reproduce(parser.parse_args())
