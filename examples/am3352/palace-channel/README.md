# Palace channel validation

This work separates three questions: whether the saved PCB mesh is consistent, whether the field extraction is numerically accurate, and whether the physical channel assumptions represent the board. An eye diagram should follow those checks, using the extracted broadband channel plus driver/receiver and timing models.

## Completed analytical benchmark

The parallel-plate control has a known TEM solution: length 10 mm, width 5 mm, separation 0.2 mm, relative permittivity 4, PEC plates and natural PMC side boundaries. The matched port impedance is 7.534606 Ω, propagation delay is 66.713 ps, `S11 = 0`, and `S21 = exp(-j 2π f delay)`. This checks field solution, units and port normalization independently of a PCB return-current approximation.

Palace 0.14.0 was run at 100 MHz, 400 MHz, 1 GHz, 2 GHz and 5 GHz, with first-order fields:

| Target size (mm) | Tetrahedra | Maximum complex S21 error | Maximum \|S11\| |
| --- | ---: | ---: | ---: |
| 1 | 383 | 4.47e-4 | 1.25e-3 |
| 0.5 | 1,455 | 1.25e-3 | 1.52e-3 |
| 0.25 | 6,055 | 6.25e-5 | 1.29e-4 |
| 0.125 | 22,959 | 8.62e-5 | 6.64e-5 |

Errors are not monotonic on these unstructured meshes. Both finer cases approach the exact solution to approximately `1e-4`; this is a benchmark agreement measurement, not an AM3352 convergence result. [Results](tem/results.json) and each directory's raw native log, config and S-parameter CSV are retained.

Reproduce a mesh and solve:

```sh
"$GMSH_PYTHON" scripts/palace/benchmark-tem.py --out work/tem --size 0.125
cd work/tem
palace -np 2 palace.json > palace.log 2>&1
cd ../..
"$GMSH_PYTHON" scripts/palace/check-tem.py work/tem --output work/tem-results.json
```

The analytical fixture is explicitly a mathematical boundary-value benchmark. PCB regressions and the channel control below generate circuit-json from TSX.

## Completed TSX PCB control

[`MultilayerBoard`](../../../tests/fixtures/multilayer-board.tsx) generates a four-layer board with two signal terminals, routed layer transitions, hollow plated vias and ground copper. The [control generator](../../../scripts/generate-palace-control.tsx) places native coplanar `U1.OUT` and `U2.IN` ports against their explicit GND net. It requires signal and reference continuity, and all saved-mesh checks pass.

The first-order extraction used 29,521 full-material tetrahedra, 50 Ω per port and the same five frequencies. Both excitation directions completed. The largest reciprocity error is `1.12e-7`; the largest S-matrix singular value is `0.999983`. These are numerical consistency checks, not established discretization convergence.

![Raw Palace samples from the TSX control; not the AM3352 board](tsx-control/channel.png)

[Raw Touchstone](tsx-control/channel.s2p), [report](tsx-control/channel-report.json), [solver receipt](tsx-control/solver-input.json) and configs are retained. The corresponding native logs and raw CSV columns are in [the reader test fixture](../../../tests/fixtures/palace-channel). Tests reject incomplete sweeps and report deliberately nonpassive data without correcting it. A constructed four-port parser test checks differential/common-mode polarity and Touchstone ordering; it is not a native four-port simulation.

Both second-order excitation directions also completed. The [second-order report and raw results](tsx-control/p2/channel-report.json) have a maximum reciprocity error of `4.60e-7`, but the maximum change from first order is **0.199** in a complex S entry. The first-order PCB result is therefore **not converged** under the 0.01 criterion. This is precisely why consistency checks alone are insufficient for judging routing. One second-order direction used the default polynomial multigrid preconditioner (378 s); the other used a full-order complex SuperLU preconditioner (131 s). Their preserved configs show those linear-solver settings; both used residual tolerance `1e-8`.

Reproduction commands are in the [root README](../../../README.md#palace-channel-extraction).

## Actual AM3352 DQS0 case

**Status: the complete-route assembly/mesh run is still in progress. No actual-board Palace S-matrix or eye is claimed by the current evidence.** The completed source-via crop remains a separate geometry-validation case.

The input is the [pinned circuit-json](../mesh-validation/am3352.circuit.json.gz) with [its stackup](../mesh-validation/stackup.json). The expanded JSON SHA-256 is `c9d7059fe536865784f175855e0dcc76510972319eec848c18b0ef6dcd2adb40`.

The requested port order is:

1. `U1.P1` — DQS0 source positive
2. `U3.F3` — DQS0 load positive
3. `U1.P2` — DQSn0 source negative
4. `U3.G3` — DQSn0 load negative

Each aperture references nearby **top DDR_1V5 copper (`source_net_93`)**, not an inferred ideal ground. Reference copper continuity is required. Discrete bypass capacitors and PDN impedance are omitted from this baseline and must be addressed before judging the actual board. The mixed-mode mapping is `--pairs '1,3;2,4'`.

Generate the complete routes, including all neighbouring copper in the selected corridor:

```sh
bun scripts/validate-am3352-dqs.tsx \
  --board examples/am3352/mesh-validation/am3352.circuit.json.gz \
  --stackup examples/am3352/mesh-validation/stackup.json \
  --output work/am3352-dqs --mesh-size 0.4 --threads 1 \
  --fragment-strategy tiled --tile-size 2.5 --tile-workers 4 \
  --tile-cache work/cad-cache --air-padding 1 --palace-ports \
  --corridor-margin 0.75 --simplify-tolerance 0.001 --optimize-netgen
```

The 0.75 mm corridor, 1 mm air enclosure, 1 µm contour approximation, assumed dielectric loss tangent 0.02 and PEC copper are **sensitivity-study inputs**, not validated board physics. An operating DDR clock near 400 MHz does not define the required bandwidth: edge transitions excite higher harmonics. The five-frequency sweep above is a diagnostic and cannot support a reliable transient eye on its own.

Once the complete route mesh passes, prepare all four excitation configs and run every column:

```sh
"$GMSH_PYTHON" scripts/palace/prepare-channel.py \
  --mesh-directory work/am3352-dqs --output work/am3352-channel \
  --frequency-hz 100000000 400000000 1000000000 2000000000 5000000000
# Run palace-1.json through palace-4.json, retaining palace-N.log.
"$GMSH_PYTHON" scripts/palace/read-channel.py work/am3352-channel --pairs '1,3;2,4'
```

## Solver environment

Recorded runs use the pinned Docker image:

```text
benvial/palace@sha256:f0f3a3cbbdf1ee2d8f856ddbe1f5bf4628a92ee8ab87d1e27dc33402ad9c8dda
```

For a generated solver directory, the equivalent isolated command is:

```sh
cd work/control
docker run --rm --network none --user "$(id -u):$(id -g)" \
  --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=$PWD,dst=/case" --workdir /case \
  benvial/palace@sha256:f0f3a3cbbdf1ee2d8f856ddbe1f5bf4628a92ee8ab87d1e27dc33402ad9c8dda \
  palace -np 2 palace-1.json > palace-1.log 2>&1
```

Repeat for every generated port config. `Model.L0 = 0.001` converts mesh millimetres to SI; Palace configuration frequencies are GHz, while the preparation CLI accepts Hz. Optional plots use `scripts/palace/requirements-plots.txt` and `plot-channel.py`; they display raw samples without interpolation or channel fitting.
