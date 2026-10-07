# Native four-port Palace reader fixture

All four excitation columns come from `generate-palace-control.tsx --differential`, which generates circuit-json from TSX. Palace 0.14.0 ran first-order fields at 100 MHz, 400 MHz, 1 GHz, 2 GHz and 5 GHz on 32,287 full-material tetrahedra, with 50 ohms per leg. GND continuity and all saved-mesh PCB checks passed before extraction. The explicit pairing is `1,3;2,4`.

These are raw, complete solver results from a symmetric control board, not AM3352 data or established discretization convergence. Logs and CSV hashes are recorded by the reader.
