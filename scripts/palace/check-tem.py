"""Compare raw native Palace output to the matched parallel-plate TEM solution."""

import argparse
import hashlib
import json
import re
from pathlib import Path
import numpy as np


def check(directory):
    geometry = json.loads((directory / "analytical.json").read_text())
    log = (directory / "palace.log").read_text()
    if not re.search(r"^Total\s+[0-9.]+\s+[0-9.]+\s+[0-9.]+", log, re.MULTILINE):
        raise ValueError("Benchmark solver did not complete")
    csv = directory / "postpro/port-S.csv"
    data = np.loadtxt(csv, delimiter=",", skiprows=1, ndmin=2)
    if data.shape != (5, 5) or not np.isfinite(data).all():
        raise ValueError("Incomplete benchmark scattering samples")
    if not np.allclose(data[:, 0], [0.1, 0.4, 1, 2, 5]):
        raise ValueError("Unexpected benchmark frequencies")
    reflection = 10 ** (data[:, 1] / 20) * np.exp(1j * np.deg2rad(data[:, 2]))
    transmission = 10 ** (data[:, 3] / 20) * np.exp(1j * np.deg2rad(data[:, 4]))
    expected = np.exp(-2j * np.pi * data[:, 0] * 1e9 * geometry["flightTimeSeconds"])
    return {
        "name": directory.name,
        "meshSizeMm": geometry["meshSizeMm"],
        "tetrahedra": geometry["tets"],
        "maximumComplexTransmissionError": float(abs(transmission - expected).max()),
        "maximumReflection": float(abs(reflection).max()),
        "csvSha256": hashlib.sha256(csv.read_bytes()).hexdigest(),
    }


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("directories", nargs="+")
    p.add_argument("--output", required=True)
    a = p.parse_args()
    results = [check(Path(d)) for d in a.directories]
    Path(a.output).write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps(results, indent=2))
