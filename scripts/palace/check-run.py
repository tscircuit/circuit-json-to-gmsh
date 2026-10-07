"""Check a native Palace column before advancing to another excitation.

A zero process exit code is insufficient: Palace may emit unconverged values.
"""

import argparse
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "channel_reader", Path(__file__).with_name("read-channel.py")
)
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)

if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--log", type=Path, required=True)
    p.add_argument("--samples", type=int, required=True)
    a = p.parse_args()
    if a.samples < 1:
        p.error("require at least one frequency sample")
    print(json.dumps(reader.check_native_run(a.log, a.samples)))
