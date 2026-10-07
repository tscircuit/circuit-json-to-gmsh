"""Bound Boolean workloads using nonoverlapping XY cells and native processes.

Four-cell joins include corner contacts, not only the paired side faces. These
are CAD subdivisions, not EM boundaries. BRep caches are keyed by geometry,
exporter implementation and native version; material identities are checked
when each BRep is reloaded. Final saved-mesh gates remain mandatory.
"""

from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path
import gmsh
import numpy as np
from shapely.geometry import box, Polygon
from planar import clean, points
from partition import fragment
from tile_worker import fingerprint


def build_tiled_cad(options):
    board, copper = options["board"], options["copper"]
    bounds = options.get("airBoundsMm") or board.bounds
    size = options["tileSizeMm"]
    axes = []
    for low, high in [(bounds[0], bounds[2]), (bounds[1], bounds[3])]:
        values = [low]
        while values[-1] + size < high - 1e-8:
            values.append(values[-1] + size)
        values.append(high)
        axes.append(values)
    root = Path(
        options.get("tileCacheDirectory")
        or Path(options["progressPath"]).parent / "tile-cache"
    )
    root.mkdir(parents=True, exist_ok=True)
    native = Path(__file__).parent
    implementation = hashlib.sha256(
        b"".join(
            (native / name).read_bytes()
            for name in [
                "tile_worker.py",
                "cad.py",
                "partition.py",
                "topology.py",
                "planar.py",
            ]
        )
    ).hexdigest()
    started = time.monotonic()
    jobs = []
    layered = options["model"]["multilayer"]
    barrels = [
        (
            b,
            Polygon(points(b["hole"])).buffer(
                b["platingThickness"], join_style="mitre"
            ),
        )
        for b in layered["barrels"]
    ]
    drills = [(d, Polygon(points(d["hole"]))) for d in layered["drills"]]

    def progress(stage, **extra):
        Path(options["progressPath"]).write_text(
            json.dumps({"stage": stage, "seconds": time.monotonic() - started, **extra})
        )

    for i, (xmin, xmax) in enumerate(zip(axes[0], axes[0][1:])):
        for j, (ymin, ymax) in enumerate(zip(axes[1], axes[1][1:])):
            cell_bounds = [xmin, ymin, xmax, ymax]
            cell = box(*cell_bounds)
            region = clean(board.intersection(cell))
            if region.is_empty and not options.get("airBoundsMm"):
                continue
            selected = {
                layer: {
                    n: clean(s.intersection(region)).__geo_interface__
                    for n, s in nets.items()
                    if not s.is_empty and s.intersects(region)
                }
                for layer, nets in copper.items()
            }
            model = {
                "multilayer": {
                    "stackup": layered["stackup"],
                    "barrels": [b for b, s in barrels if s.intersects(region)],
                    "drills": [d for d, s in drills if s.intersects(region)],
                }
            }
            job = {
                "options": {
                    "model": model,
                    "boundsMm": cell_bounds,
                    "clipBoard": True,
                    "cutawayX": options.get("cutawayX"),
                    "repairRadiusMm": options.get("repairRadiusMm", 0.0001),
                    "airBoundsMm": cell_bounds if options.get("airBoundsMm") else None,
                    "airPaddingMm": options.get("airPaddingMm"),
                },
                "board": region.__geo_interface__,
                "copper": selected,
                "implementationSha256": implementation,
                "gmshVersion": gmsh.__version__,
            }
            digest = hashlib.sha256(
                json.dumps(job, sort_keys=True).encode()
            ).hexdigest()
            job["jobSha256"] = digest
            directory = root / digest
            directory.mkdir(exist_ok=True)
            job_path = directory / "job.json"
            job_path.write_text(json.dumps(job))
            jobs.append(((i, j), directory, job_path, digest))

    def compute(job):
        tile, directory, job_path, digest = job
        complete = directory / "complete.json"
        if complete.exists():
            cached = json.loads(complete.read_text())
            if cached.get("jobSha256") == digest and all(
                (directory / name).exists()
                and hashlib.sha256((directory / name).read_bytes()).hexdigest()
                == cached.get(field)
                for name, field in [
                    ("tile.brep", "brepSha256"),
                    ("solids.json", "solidsSha256"),
                ]
            ):
                return job
        with (directory / "native.log").open("w") as log:
            result = subprocess.run(
                [
                    sys.executable,
                    str(native / "tile_worker.py"),
                    "--job",
                    str(job_path),
                    "--output",
                    str(directory),
                ],
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        if result.returncode:
            raise ValueError(
                f"Native tile {tile} failed; see {directory / 'native.log'}"
            )
        return job

    progress("compute_tiles", tiles=len(jobs), workers=options.get("tileWorkers", 1))
    with ThreadPoolExecutor(max_workers=options.get("tileWorkers", 1)) as executor:
        futures = [executor.submit(compute, job) for job in jobs]
        for completed, future in enumerate(as_completed(futures), 1):
            job = future.result()
            progress(
                "compute_tiles", completed=completed, tiles=len(jobs), lastTile=job[0]
            )
    tiles = {}
    for tile, directory, _, _ in jobs:
        entities = gmsh.model.occ.importShapes(
            str(directory / "tile.brep"), highestDimOnly=True
        )
        tags = [t for d, t in entities if d == 3]
        actual = np.array([fingerprint(t) for t in tags])
        solids = json.loads((directory / "solids.json").read_text())
        used = set()
        for solid in solids:
            entities = []
            for expected in solid.pop("fingerprints"):
                expected = np.array(expected)
                matches = np.flatnonzero(
                    np.all(np.isclose(actual, expected, rtol=1e-7, atol=2e-6), axis=1)
                )
                matches = [int(k) for k in matches if int(k) not in used]
                if len(matches) != 1:
                    raise ValueError(
                        "Ambiguous/lost BRep material ownership on tile reload"
                    )
                used.add(matches[0])
                entities.append((3, tags[matches[0]]))
            solid["entities"] = entities
            solid["id"] = f"tile/{tile[0]}/{tile[1]}/" + solid["id"]
        if len(used) != len(tags):
            raise ValueError("Unowned BRep volume on tile reload")
        tiles[tile] = solids
    for i, j in tiles:
        block = [(i, j), (i + 1, j), (i, j + 1), (i + 1, j + 1)]
        selected = [s for tile in block if tile in tiles for s in tiles[tile]]
        if sum(tile in tiles for tile in block) < 2:
            continue
        progress("join_tile_block", tile=[i, j], solids=len(selected), tiles=len(tiles))
        fragment(selected)
    gmsh.model.occ.synchronize()
    progress("tiles_complete", nativeVolumes=len(gmsh.model.getEntities(3)))
    return [solid for solids in tiles.values() for solid in solids]
