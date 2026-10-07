"""Read complete Palace scattering columns; preserve raw solver results.

No reciprocity/passivity enforcement or fitted values are applied. Missing or
unconverged runs fail. Four equal-impedance ports support an explicit mixed-mode
mapping, so differential and common-mode behavior are kept separate.
"""

import argparse
import csv
import hashlib
import json
import math
import re
from pathlib import Path
import numpy as np


def check_native_run(log_path, expected_samples):
    """Palace can exit zero after a failed linear solve; require native evidence."""
    log = Path(log_path).read_text()
    total = re.search(r"^Total\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)", log, re.MULTILINE)
    if not total:
        raise ValueError("Palace run has no completion record")
    if re.search(r"(?:solver|KSP).*(?:did not|failed to).*converge", log, re.I):
        raise ValueError("Palace linear solver did not converge")
    iterations = list(
        map(int, re.findall(r"GMRES solver converged in (\d+) iterations?", log))
    )
    if len(iterations) != expected_samples:
        raise ValueError("Palace run lacks a converged solve for every sample")
    return {
        "wallSecondsMeanRank": float(total[3]),
        "gmresIterations": iterations,
        "logSha256": hashlib.sha256(Path(log_path).read_bytes()).hexdigest(),
    }


def read_channel(directory, pairs=None):
    receipt = json.loads((directory / "solver-input.json").read_text())
    n = len(receipt["ports"])
    expected = np.asarray(receipt["frequenciesHz"])
    network = np.empty((len(expected), n, n), dtype=complex)
    native_runs = []
    for excited in range(1, n + 1):
        log_path = directory / f"palace-{excited}.log"
        native = check_native_run(log_path, len(expected))
        path = directory / f"postpro/port-{excited}/port-S.csv"
        with path.open() as f:
            header = next(csv.reader(f))
        if len(header) != 1 + 2 * n:
            raise ValueError("Scattering CSV does not contain every port")
        data = np.loadtxt(path, delimiter=",", skiprows=1, ndmin=2)
        if data.shape != (len(expected), 1 + 2 * n) or not np.isfinite(data).all():
            raise ValueError("Missing or nonfinite scattering samples")
        if not np.allclose(data[:, 0] * 1e9, expected, rtol=1e-9, atol=1e-3):
            raise ValueError("Palace frequencies differ from the requested sweep")
        native_runs.append(
            {
                "excitedPort": excited,
                **native,
                "csvSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
        )
        for observed in range(1, n + 1):
            mag, phase = header[1 + 2 * (observed - 1) : 3 + 2 * (observed - 1)]
            if (
                f"S[{observed}][{excited}]" not in mag
                or f"S[{observed}][{excited}]" not in phase
            ):
                raise ValueError("Unexpected scattering column order")
            network[:, observed - 1, excited - 1] = 10 ** (
                data[:, 1 + 2 * (observed - 1)] / 20
            ) * np.exp(1j * np.deg2rad(data[:, 2 + 2 * (observed - 1)]))
    reciprocal = np.max(abs(network - np.swapaxes(network, 1, 2)), axis=(1, 2))
    singular = np.linalg.svd(network, compute_uv=False)[:, 0]
    report = {
        "ports": [p["name"] for p in receipt["ports"]],
        "referenceImpedanceOhms": receipt["referenceImpedanceOhms"],
        "portGeometrySha256": hashlib.sha256(
            json.dumps(
                [
                    {k: v for k, v in p.items() if k != "referencePositionMm"}
                    for p in receipt["ports"]
                ],
                sort_keys=True,
            ).encode()
        ).hexdigest(),
        "frequenciesHz": expected.tolist(),
        "order": receipt["order"],
        "sourceMeshSha256": receipt["sourceMeshSha256"],
        "modelSha256": receipt["modelSha256"],
        "sourceManifestSha256": receipt["sourceManifestSha256"],
        "tetrahedra": receipt["tetrahedra"],
        "palaceMeshSha256": receipt["palaceMeshSha256"],
        "copperModel": receipt["copperModel"],
        "nativeRuns": native_runs,
        "maximumReciprocityError": float(reciprocal.max()),
        "maximumScatteringSingularValue": float(singular.max()),
        "reciprocityErrors": reciprocal.tolist(),
        "scatteringSingularValues": singular.tolist(),
        "numericalConsistencyPassed": bool(
            reciprocal.max() <= 0.01 and singular.max() <= 1.005
        ),
        "convergenceProven": False,
        "limitations": receipt["limitations"],
    }
    touchstone = directory / f"channel.s{n}p"
    with touchstone.open("w") as f:
        f.write(
            f"! Raw Palace field extraction; port order: {', '.join(report['ports'])}\n# Hz S RI R {receipt['referenceImpedanceOhms']}\n"
        )
        for freq, s in zip(expected, network):
            values = [f"{freq:.12g}"]
            # Touchstone 1.x uses column order only for two-port networks;
            # three or more ports use row order (S11,S12,...,S21,...).
            if n == 2:
                for z in s.T.flatten():
                    values.extend([f"{z.real:.14e}", f"{z.imag:.14e}"])
                f.write(" ".join(values) + "\n")
            else:
                for row in s:
                    for z in row:
                        values.extend([f"{z.real:.14e}", f"{z.imag:.14e}"])
                    f.write(" ".join(values) + "\n")
                    values = []
    np.savez(directory / "channel.npz", frequenciesHz=expected, scattering=network)
    if not pairs:
        for filename in ["mixed-mode.npz", "mixed-mode.csv"]:
            (directory / filename).unlink(missing_ok=True)
    if pairs:
        if n != 4 or sorted([i for pair in pairs for i in pair]) != list(range(4)):
            raise ValueError(
                "Mixed-mode mapping must cover each of four ports exactly once"
            )
        transform = np.zeros((4, 4))
        for i, (positive, negative) in enumerate(pairs):
            transform[i, positive] = transform[i + 2, positive] = 1 / np.sqrt(2)
            transform[i, negative] = -1 / np.sqrt(2)
            transform[i + 2, negative] = 1 / np.sqrt(2)
        mixed = np.einsum("ij,fjk,kl->fil", transform, network, transform.T)
        np.savez(directory / "mixed-mode.npz", frequenciesHz=expected, scattering=mixed)
        report["mixedMode"] = {
            "pairIndicesOneBased": [[i + 1 for i in pair] for pair in pairs],
            "modeOrder": [
                "source differential",
                "load differential",
                "source common",
                "load common",
            ],
            "differentialReferenceOhms": 2 * receipt["referenceImpedanceOhms"],
            "commonReferenceOhms": receipt["referenceImpedanceOhms"] / 2,
        }
        with (directory / "mixed-mode.csv").open("w") as f:
            f.write(
                "frequency_Hz,Sdd11_real,Sdd11_imag,Sdd21_real,Sdd21_imag,Scd21_real,Scd21_imag\n"
            )
            for freq, s in zip(expected, mixed):
                values = [
                    freq,
                    *[v for z in [s[0, 0], s[1, 0], s[3, 0]] for v in [z.real, z.imag]],
                ]
                f.write(",".join(f"{v:.14e}" for v in values) + "\n")
    report["touchstoneSha256"] = hashlib.sha256(touchstone.read_bytes()).hexdigest()
    (directory / "channel-report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def compare(runs, output, tolerance, pairs=None):
    if not math.isfinite(tolerance) or tolerance <= 0:
        raise ValueError("Convergence tolerance must be finite and positive")
    if len(runs) < 3:
        raise ValueError("Require at least three progressively refined runs")
    output.unlink(missing_ok=True)
    if pairs is None:
        previous = [
            json.loads((p / "channel-report.json").read_text())
            if (p / "channel-report.json").exists()
            else {}
            for p in runs
        ]
        mappings = [r.get("mixedMode", {}).get("pairIndicesOneBased") for r in previous]
        if any(mappings):
            if any(mapping != mappings[0] for mapping in mappings):
                raise ValueError("Convergence comparison changed mixed-mode mapping")
            pairs = [tuple(i - 1 for i in pair) for pair in mappings[0]]
    # A saved report is not proof that the native logs/CSV remain complete.
    reports = [read_channel(p, pairs) for p in runs]
    for report in reports[1:]:
        for key in [
            "ports",
            "frequenciesHz",
            "referenceImpedanceOhms",
            "portGeometrySha256",
            "modelSha256",
            "sourceManifestSha256",
            "copperModel",
        ]:
            if report[key] != reports[0][key]:
                raise ValueError(f"Convergence comparison changed {key}")
    for a, b in zip(reports, reports[1:]):
        if (
            b["tetrahedra"] < a["tetrahedra"]
            or b["order"] < a["order"]
            or (b["tetrahedra"] == a["tetrahedra"] and b["order"] == a["order"])
        ):
            raise ValueError(
                "Require progressively refined meshes or polynomial orders"
            )
    networks = [np.load(p / "channel.npz")["scattering"] for p in runs]
    differences = [float(abs(a - b).max()) for a, b in zip(networks, networks[1:])]
    mixed_differences = None
    if pairs is not None:
        mixed = [np.load(p / "mixed-mode.npz")["scattering"] for p in runs]
        mixed_differences = [float(abs(a - b).max()) for a, b in zip(mixed, mixed[1:])]
    result = {
        "runDirectories": [str(p) for p in runs],
        "runs": [
            {
                k: r[k]
                for k in [
                    "sourceMeshSha256",
                    "palaceMeshSha256",
                    "portGeometrySha256",
                    "tetrahedra",
                    "order",
                    "nativeRuns",
                    "numericalConsistencyPassed",
                ]
            }
            for r in reports
        ],
        "maximumComplexDifferences": differences,
        "maximumMixedModeDifferences": mixed_differences,
        "absolutePowerWaveTolerance": tolerance,
        "convergenceProven": bool(
            all(r["numericalConsistencyPassed"] for r in reports)
            and all(d <= tolerance for d in differences[-2:])
            and (
                mixed_differences is None
                or all(d <= tolerance for d in mixed_differences[-2:])
            )
        ),
        "limitations": [
            "This compares supplied discretizations; it does not establish material, port or enclosure accuracy.",
            "Run directories must be ordered coarse to fine and their refinement settings reviewed.",
        ],
    }
    output.write_text(json.dumps(result, indent=2) + "\n")
    return result


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("directory", nargs="?")
    p.add_argument("--pairs", help="One-based positive,negative pairs, e.g. 1,3;2,4")
    p.add_argument("--compare", nargs="+")
    p.add_argument("--output")
    p.add_argument("--tolerance", type=float, default=0.01)
    a = p.parse_args()
    pairs = (
        [tuple(int(i) - 1 for i in pair.split(",")) for pair in a.pairs.split(";")]
        if a.pairs
        else None
    )
    if a.compare:
        if not a.output:
            raise ValueError("Supply --output for convergence report")
        result = compare(
            [Path(p) for p in a.compare], Path(a.output), a.tolerance, pairs
        )
    else:
        if not a.directory:
            raise ValueError("Supply a solver directory")
        result = read_channel(Path(a.directory), pairs)
    print(json.dumps(result, indent=2))
