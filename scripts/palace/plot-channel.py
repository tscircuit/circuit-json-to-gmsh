"""Plot raw complex scattering samples; no interpolated eye or channel fit."""

import argparse
import importlib.util
import json
from pathlib import Path
import matplotlib
import numpy as np

matplotlib.use("Agg")
import matplotlib.pyplot as plt

p = argparse.ArgumentParser(description=__doc__)
p.add_argument("directory")
p.add_argument("--output", required=True)
p.add_argument("--title", default="Raw Palace channel samples")
a = p.parse_args()
directory = Path(a.directory)
report = json.loads((directory / "channel-report.json").read_text())
spec = importlib.util.spec_from_file_location(
    "channel_reader", Path(__file__).with_name("read-channel.py")
)
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
pairs = report.get("mixedMode", {}).get("pairIndicesOneBased")
report = reader.read_channel(
    directory, [tuple(i - 1 for i in pair) for pair in pairs] if pairs else None
)
mixed = (directory / "mixed-mode.npz").exists()
data = np.load(directory / ("mixed-mode.npz" if mixed else "channel.npz"))
s, frequencies = data["scattering"], data["frequenciesHz"] / 1e9
entries = [(1, 0, "Sdd21" if mixed else "S21"), (0, 0, "Sdd11" if mixed else "S11")]
if mixed:
    entries.append((3, 0, "Scd21 (differential → common)"))
single = len(frequencies) == 1
fig, axes = plt.subplots(
    2, 1, figsize=(9, 7), sharex=not single, constrained_layout=True
)
if single:
    labels = [label for _, _, label in entries]
    values = np.asarray([s[0, i, j] for i, j, _ in entries])
    for ax, samples, unit in [
        (axes[0], 20 * np.log10(np.maximum(abs(values), 1e-15)), "Magnitude (dB)"),
        (axes[1], np.rad2deg(np.angle(values)), "Phase (degrees)"),
    ]:
        ax.barh(labels, samples, color=["#2563eb", "#f97316", "#059669"][: len(labels)])
        ax.invert_yaxis()
        ax.set_xlabel(unit)
        ax.set_xlim(
            min(0, float(samples.min())) * 1.2, max(1, float(samples.max())) * 1.2
        )
        for row, value in enumerate(samples):
            span = ax.get_xlim()[1] - ax.get_xlim()[0]
            outside = abs(value) < 0.08 * span
            position = value - 0.03 * span if outside and value < 0 else value / 2
            ax.text(
                position,
                row,
                f"{value:.3f}",
                ha="right" if outside and value < 0 else "center",
                va="center",
                color="black" if outside else "white",
            )
    axes[0].set_title(f"Single native frequency: {frequencies[0] * 1000:g} MHz")
else:
    for i, j, label in entries:
        axes[0].plot(
            frequencies,
            20 * np.log10(np.maximum(abs(s[:, i, j]), 1e-15)),
            "o-",
            label=label,
        )
    axes[1].plot(frequencies, np.rad2deg(np.unwrap(np.angle(s[:, 1, 0]))), "o-")
    axes[0].set_ylabel("Magnitude (dB)")
    axes[0].legend()
    axes[1].set_ylabel("Transmission phase (degrees)")
    axes[1].set_xlabel("Frequency (GHz)")
for ax in axes:
    ax.grid(alpha=0.25)
fig.suptitle(a.title + "\n" + ", ".join(report["ports"]))
fig.text(
    0.5,
    -0.025,
    "PEC copper baseline · "
    + (
        "discretization comparison passed"
        if report["convergenceProven"]
        else "convergence not established"
    ),
    ha="center",
)
fig.savefig(a.output, dpi=150, bbox_inches="tight")
