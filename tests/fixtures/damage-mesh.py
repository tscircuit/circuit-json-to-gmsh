"""Deliberately corrupt saved MSH 2.2 files, independently of the exporter."""

import argparse
import json
from pathlib import Path


def damage(options):
    lines = Path(options.mesh).read_text().splitlines()
    ni, ei = lines.index("$Nodes"), lines.index("$Elements")
    nodes = [line.split() for line in lines[ni + 2 : ni + 2 + int(lines[ni + 1])]]
    elements = [
        list(map(int, line.split()))
        for line in lines[ei + 2 : ei + 2 + int(lines[ei + 1])]
    ]
    manifest = json.loads(Path(options.manifest).read_text())
    face = next(f for f in manifest["faces"] if len(f["volumes"]) == 2)
    if options.mode == "missing_interface":
        elements = [e for e in elements if not (e[1] == 2 and e[4] == face["tag"])]
    elif options.mode == "duplicate_interface_nodes":
        tags = sorted(
            {n for e in elements if e[1] == 2 and e[4] == face["tag"] for n in e[5:]}
        )
        by_tag = {int(n[0]): n for n in nodes}
        first_tag = max(by_tag) + 1
        mapping = {tag: first_tag + i for i, tag in enumerate(tags)}
        nodes.extend([[str(mapping[tag]), *by_tag[tag][1:]] for tag in tags])
        for element in elements:
            if element[1] == 4 and element[4] == face["volumes"][0]:
                element[5:] = [mapping.get(tag, tag) for tag in element[5:]]
    elif options.mode == "inverted_tetrahedron":
        element = next(e for e in elements if e[1] == 4)
        element[-1], element[-2] = element[-2], element[-1]
    elif options.mode == "nonmanifold_face":
        element = next(e for e in elements if e[1] == 4)
        elements.append([max(e[0] for e in elements) + 1, *element[1:]])
    elif options.mode == "unowned_material":
        for element in elements:
            if element[1] == 4:
                element[3] = 999
                break
    elif options.mode in ["filled_drill", "filled_cutout"]:
        first = max(int(n[0]) for n in nodes) + 1
        coordinates = [
            [-2.2, 1.3, 0.3],
            [-1.8, 1.3, 0.3],
            [-2, 1.8, 0.3],
            [-1.5, 2, 0.32],
        ]
        if options.mode == "filled_cutout":
            coordinates = [
                [-0.3, -1.8, 0.3],
                [0.3, -1.8, 0.3],
                [0, -1.2, 0.3],
                [0, -1.5, 0.32],
            ]
        nodes.extend(
            [[str(first + i), *map(str, p)] for i, p in enumerate(coordinates)]
        )
        volume = next(v for v in manifest["volumes"] if v["material"] == "dielectric")
        material = next(e[3] for e in elements if e[1] == 4 and e[4] == volume["tag"])
        elements.append(
            [
                max(e[0] for e in elements) + 1,
                4,
                2,
                material,
                volume["tag"],
                *range(first, first + 4),
            ]
        )
    elif options.mode in ["copper_short", "copper_short_duplicate_nodes"]:
        copper = [v for v in manifest["volumes"] if v["material"] == "copper"]
        a = copper[0]
        b = next(v for v in copper if v["name"] != a["name"])
        source = next(e for e in elements if e[1] == 4 and e[4] == a["tag"])
        target = next(e for e in elements if e[1] == 4 and e[4] == b["tag"])
        contact_nodes = source[5:]
        if options.mode == "copper_short_duplicate_nodes":
            by_tag = {int(n[0]): n for n in nodes}
            first_tag = max(by_tag) + 1
            nodes.extend(
                [
                    [str(first_tag + i), *by_tag[tag][1:]]
                    for i, tag in enumerate(contact_nodes)
                ]
            )
            contact_nodes = list(range(first_tag, first_tag + 4))
        # Add an overlapping tetrahedron owned by the other net. All node tags
        # are shared with the original, so even a vertex-level short is caught.
        elements.append(
            [max(e[0] for e in elements) + 1, 4, 2, target[3], b["tag"], *contact_nodes]
        )
    else:
        raise ValueError(options.mode)
    result = [
        *lines[:ni],
        "$Nodes",
        str(len(nodes)),
        *(" ".join(n) for n in nodes),
        "$EndNodes",
        "$Elements",
        str(len(elements)),
        *(" ".join(map(str, e)) for e in elements),
        "$EndElements",
    ]
    Path(options.output).write_text("\n".join(result) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mesh", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--mode", required=True)
    damage(parser.parse_args())
