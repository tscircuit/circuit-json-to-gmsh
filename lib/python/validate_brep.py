"""Optional OpenCASCADE validity check; pip install requirements-test.txt."""

import argparse
import json
import vtk  # Preload the VTK shared libraries used by the OCP wheel.
from OCP.BRep import BRep_Builder
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepTools import BRepTools
from OCP.TopAbs import TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS_Shape


def validate(path):
    shape = TopoDS_Shape()
    if not BRepTools.Read_s(shape, path, BRep_Builder()):
        raise ValueError("Cannot read BREP")
    explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    solids = []
    while explorer.More():
        solids.append(BRepCheck_Analyzer(explorer.Current()).IsValid())
        explorer.Next()
    if not solids:
        raise ValueError("BREP contains no solids")
    return {
        "valid": all(solids),
        "solids": len(solids),
        "invalidSolidIndices": [i for i, v in enumerate(solids) if not v],
        "ocpVersion": __import__("OCP").__version__,
        "vtkVersion": vtk.vtkVersion.GetVTKVersion(),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--brep", required=True)
    print(json.dumps(validate(parser.parse_args().brep)))
