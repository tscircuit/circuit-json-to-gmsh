"""Plot raw single-ended S21 and changes across validated native Palace runs."""

import argparse
import csv
import importlib.util
from pathlib import Path

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt


def main(a):
    a.output.mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location(
        "channel_reader", Path(__file__).with_name("read-channel.py")
    )
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    # Re-read the native configs/logs/CSV and apply the same provenance and
    # numerical checks as the comparison CLI before plotting derived samples.
    report = reader.compare(a.runs, a.output / "refinement.json", a.tolerance)
    data = [np.load(p / "channel.npz") for p in a.runs]
    frequency = data[0]["frequenciesHz"]
    networks = [d["scattering"] for d in data]
    if len(networks[0][0]) < 2:
        raise ValueError("S21 requires at least two ports")
    labels = a.labels or [p.name for p in a.runs]
    if len(labels) != len(a.runs):
        raise ValueError("Provide one label per run")
    changes = [
        np.max(abs(left - right), axis=(1, 2))
        for left, right in zip(networks, networks[1:])
    ]
    with (a.output / "refinement-samples.csv").open("w") as file:
        writer = csv.writer(file)
        writer.writerow(
            [
                "frequency_Hz",
                *[
                    f"maximum_complex_change_{i}_to_{i + 1}"
                    for i in range(1, len(a.runs))
                ],
            ]
        )
        writer.writerows(zip(frequency, *changes))
    fig, axes = plt.subplots(2, 1, figsize=(8, 7), sharex=True, constrained_layout=True)
    for label, scattering in zip(labels, networks):
        axes[0].plot(
            frequency / 1e9,
            20 * np.log10(np.maximum(abs(scattering[:, 1, 0]), 1e-300)),
            "o-",
            label=label,
        )
    for i, delta in enumerate(changes):
        axes[1].semilogy(
            frequency / 1e9,
            np.maximum(delta, 1e-300),
            "o-",
            label=f"{labels[i]} → {labels[i + 1]}",
        )
    axes[1].axhline(
        a.tolerance,
        color="#bb3333",
        linestyle="--",
        label=f"{a.tolerance:g} comparison criterion",
    )
    axes[0].set_ylabel("Raw single-ended S21 magnitude (dB)")
    axes[1].set_ylabel("Maximum complex S change")
    axes[1].set_xlabel("Frequency (GHz)")
    for ax in axes:
        ax.legend()
        ax.grid(alpha=0.25)
    state = "criterion met" if report["convergenceProven"] else "criterion not met"
    fig.suptitle(f"{a.title}\n{state}; raw native samples, no channel fit")
    fig.savefig(a.output / "refinement.png", dpi=150, bbox_inches="tight")
    plt.close(fig)
    for d in data:
        d.close()


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--runs", type=Path, nargs="+", required=True)
    p.add_argument("--labels", nargs="+")
    p.add_argument("--output-directory", dest="output", type=Path, required=True)
    p.add_argument("--title", default="Native Palace discretization comparison")
    p.add_argument("--tolerance", type=float, default=0.01)
    main(p.parse_args())
