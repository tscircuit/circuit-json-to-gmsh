"""Plot raw complex scattering samples; no interpolated eye or channel fit."""

import argparse
import json
from pathlib import Path
import matplotlib
import numpy as np

matplotlib.use("Agg")
import matplotlib.pyplot as plt

p = argparse.ArgumentParser(description=__doc__)
p.add_argument("directory")
p.add_argument("--output", required=True)
a = p.parse_args()
directory = Path(a.directory)
report = json.loads((directory / "channel-report.json").read_text())
mixed = (directory / "mixed-mode.npz").exists()
data = np.load(directory / ("mixed-mode.npz" if mixed else "channel.npz"))
s, frequencies = data["scattering"], data["frequenciesHz"] / 1e9
fig, axes = plt.subplots(2, 1, figsize=(9, 7), sharex=True, constrained_layout=True)
entries = [(1, 0, "Sdd21" if mixed else "S21"), (0, 0, "Sdd11" if mixed else "S11")]
if mixed:
    entries.append((3, 0, "Scd21 (differential → common)"))
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
fig.suptitle("Raw Palace channel samples\n" + ", ".join(report["ports"]))
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
