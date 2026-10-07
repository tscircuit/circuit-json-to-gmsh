"""Plot recorded native port fixtures at physical scale; this is not an EM field."""

import argparse
import hashlib
import json
import math
from pathlib import Path
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon


def plot(source, output):
    receipt = json.loads((source / "port-fixtures.json").read_text())
    raw = (source / "ports.json").read_bytes()
    if hashlib.sha256(raw).hexdigest() != receipt["portsSha256"]:
        raise ValueError("Native fixture port receipt changed")
    ports = json.loads(raw)
    rows = math.ceil(len(ports) / 2)
    fig, axes = plt.subplots(rows, 2, figsize=(10, 4 * rows), squeeze=False)
    for ax, port in zip(axes.flat, ports):
        old = port["originalApertureOutlineMm"]
        ax.add_patch(
            Polygon(
                old,
                fill=False,
                edgecolor="#777777",
                linestyle="--",
                label="Original gap",
            )
        )
        for index, contact in enumerate(port["fixtureContacts"]):
            ax.add_patch(
                Polygon(
                    contact["outlineMm"],
                    facecolor="#efab45",
                    edgecolor="#8b5914",
                    label="Ideal PEC contact" if index == 0 else None,
                )
            )
        ax.add_patch(
            Polygon(
                port["outlineMm"],
                facecolor="#1c9ec6",
                edgecolor="#126782",
                label="Uniform port",
            )
        )
        x0, x1 = min(p[0] for p in old), max(p[0] for p in old)
        y0, y1 = min(p[1] for p in old), max(p[1] for p in old)
        pad = max(x1 - x0, y1 - y0) * 0.15
        ax.set_xlim(x0 - pad, x1 + pad)
        ax.set_ylim(y0 - pad, y1 + pad)
        ax.set_aspect("equal")
        ax.set_title(
            f"{port['name']}: {port['fixtureLengthMm']:.3f} × {port['widthMm']:.3f} mm"
        )
        ax.set_xlabel("x (mm)")
        ax.set_ylabel("y (mm)")
        ax.grid(alpha=0.2)
    for ax in list(axes.flat)[len(ports) :]:
        ax.set_visible(False)
    axes.flat[0].legend(fontsize=8, loc="best")
    fig.suptitle("Explicit Palace port fixtures — geometry, not current density")
    fig.tight_layout()
    output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output, dpi=180)
    plt.close(fig)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--mesh-directory", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    a = p.parse_args()
    plot(a.mesh_directory, a.output)
