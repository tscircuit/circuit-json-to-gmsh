"""Keep complete BREP solids in a z interval; requires requirements-test.txt."""

import argparse
import hashlib
import json
from pathlib import Path
import vtk  # Preload the VTK libraries used by OCP.
from OCP.BRep import BRep_Builder
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepGProp import BRepGProp
from OCP.BRepTools import BRepTools
from OCP.Bnd import Bnd_Box
from OCP.GProp import GProp_GProps
from OCP.TopAbs import TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS_Shape, TopoDS_Compound


def isolate(options):
    builder = BRep_Builder()
    source = TopoDS_Shape()
    if not BRepTools.Read_s(source, options.brep, builder):
        raise ValueError("Cannot read BREP")
    selected = TopoDS_Compound()
    builder.MakeCompound(selected)
    count, volume = 0, 0.0
    explorer = TopExp_Explorer(source, TopAbs_SOLID)
    while explorer.More():
        solid = explorer.Current()
        bounds = Bnd_Box()
        BRepBndLib.Add_s(solid, bounds)
        coordinates = bounds.Get()
        if (
            coordinates[2] >= options.lower - 2e-6
            and coordinates[5] <= options.upper + 2e-6
        ):
            builder.Add(selected, solid)
            properties = GProp_GProps()
            BRepGProp.VolumeProperties_s(solid, properties)
            volume += properties.Mass()
            count += 1
        explorer.Next()
    if not count:
        raise ValueError("No complete solids in the selected z interval")
    if not BRepTools.Write_s(selected, options.output):
        raise ValueError("Cannot write selected solids")
    return {
        "inputSha256": hashlib.sha256(Path(options.brep).read_bytes()).hexdigest(),
        "outputSha256": hashlib.sha256(Path(options.output).read_bytes()).hexdigest(),
        "zIntervalMm": [options.lower, options.upper],
        "solids": count,
        "volumeMm3": volume,
        "ocpVersion": __import__("OCP").__version__,
        "vtkVersion": vtk.vtkVersion.GetVTKVersion(),
        "note": "Complete input solids only; no new cut surfaces or mesh generated.",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--brep", required=True)
    parser.add_argument("--lower", type=float, required=True)
    parser.add_argument("--upper", type=float, required=True)
    parser.add_argument("--output", required=True)
    options = parser.parse_args()
    if options.lower >= options.upper:
        parser.error("lower must be below upper")
    print(json.dumps(isolate(options), indent=2))
