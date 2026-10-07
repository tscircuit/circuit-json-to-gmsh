import { expect, test } from "bun:test"
import { cp, mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "palace-reader-"))
  await cp(join(import.meta.dir, "fixtures/palace-channel"), directory, {
    recursive: true,
  })
  return directory
}
async function read(directory: string, args: string[] = []) {
  const process = Bun.spawn(
    [
      globalThis.process.env.GMSH_PYTHON ?? "python3",
      join(import.meta.dir, "../scripts/palace/read-channel.py"),
      directory,
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [code, error] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ])
  return { code, error }
}

test("actual Palace columns from the TSX control preserve a reciprocal passive network", async () => {
  const directory = await fixture()
  const result = await read(directory)
  if (result.code) throw new Error(result.error)
  const report = await Bun.file(join(directory, "channel-report.json")).json()
  expect(report.ports).toEqual(["U1.OUT", "U2.IN"])
  expect(report.maximumReciprocityError).toBeLessThan(2e-7)
  expect(report.maximumScatteringSingularValue).toBeLessThan(1)
  expect(report.numericalConsistencyPassed).toBe(true)
  expect(report.convergenceProven).toBe(false)
})

test("four-port conversion keeps polarity, mode conversion and Touchstone matrix order", async () => {
  const directory = await fixture()
  const input = await Bun.file(join(directory, "solver-input.json")).json()
  // Constructed parser regression, not a claimed native four-port extraction.
  input.ports = ["P.source", "P.load", "N.source", "N.load"].map((name) => ({
    name,
  }))
  input.frequenciesHz = [400_000_000]
  await Bun.write(join(directory, "solver-input.json"), JSON.stringify(input))
  const matrix = [
    [0.01, 0.81, 0, 0],
    [0.8, 0.02, 0, 0],
    [0, 0, 0.03, 0.7],
    [0, 0, 0.7, 0.04],
  ]
  const log =
    (await Bun.file(join(directory, "palace-1.log")).text()).replace(
      /GMRES solver converged in \d+ iterations[^\n]*\n/g,
      "",
    ) + "\nGMRES solver converged in 1 iterations\n"
  for (let excited = 0; excited < 4; excited++) {
    await Bun.write(join(directory, `palace-${excited + 1}.log`), log)
    const subdir = join(directory, `postpro/port-${excited + 1}`)
    await mkdir(subdir, { recursive: true })
    const header = ["f (GHz)"]
    const row = ["0.4"]
    for (let observed = 0; observed < 4; observed++) {
      header.push(
        `|S[${observed + 1}][${excited + 1}]| (dB)`,
        `arg(S[${observed + 1}][${excited + 1}]) (deg.)`,
      )
      row.push(String(20 * Math.log10(matrix[observed][excited] || 1e-20)), "0")
    }
    await Bun.write(
      join(subdir, "port-S.csv"),
      `${header.join(",")}\n${row.join(",")}\n`,
    )
  }
  const result = await read(directory, ["--pairs", "1,3;2,4"])
  if (result.code) throw new Error(result.error)
  const report = await Bun.file(join(directory, "channel-report.json")).json()
  expect(report.mixedMode.differentialReferenceOhms).toBe(100)
  expect(report.mixedMode.commonReferenceOhms).toBe(25)
  const mixed = (await Bun.file(join(directory, "mixed-mode.csv")).text())
    .trim()
    .split("\n")[1]
    .split(",")
    .map(Number)
  expect(mixed[3]).toBeCloseTo(0.75, 10)
  expect(mixed[5]).toBeCloseTo(0.05, 10)
  const touchstoneLines = (
    await Bun.file(join(directory, "channel.s4p")).text()
  )
    .trim()
    .split("\n")
  const touchstone = touchstoneLines[2].split(/\s+/).map(Number)
  expect(touchstone[3]).toBeCloseTo(0.81, 10) // S12, not S21
  expect(Number(touchstoneLines[3].split(/\s+/)[0])).toBeCloseTo(0.8, 10) // S21 starts the next row
  expect((await read(directory)).code).toBe(0)
  expect(await Bun.file(join(directory, "mixed-mode.npz")).exists()).toBe(false)
  expect(await Bun.file(join(directory, "mixed-mode.csv")).exists()).toBe(false)
})

test("partial sweeps and incomplete native logs cannot produce channel results", async () => {
  for (const mode of ["frequencies", "completion", "convergence"]) {
    const directory = await fixture()
    if (mode === "frequencies") {
      const path = join(directory, "postpro/port-2/port-S.csv")
      const lines = (await Bun.file(path).text()).trimEnd().split("\n")
      await Bun.write(path, lines.slice(0, -1).join("\n") + "\n")
    } else if (mode === "completion") {
      const path = join(directory, "palace-2.log")
      await Bun.write(
        path,
        (await Bun.file(path).text()).replace(
          /^Total\s+.*$/m,
          "Stopped before completion",
        ),
      )
    } else {
      const path = join(directory, "palace-2.log")
      await Bun.write(
        path,
        (await Bun.file(path).text()).replace(
          /GMRES solver converged in \d+ iterations/,
          "No converged solve record",
        ),
      )
    }
    expect((await read(directory)).code).not.toBe(0)
    expect(
      await Bun.file(join(directory, "channel-report.json")).exists(),
    ).toBe(false)
  }
})

test("nonpassive solver data is reported without silently repairing the network", async () => {
  const directory = await fixture()
  const path = join(directory, "postpro/port-1/port-S.csv")
  const lines = (await Bun.file(path).text()).trimEnd().split("\n")
  const row = lines[1].split(",")
  row[3] = String(Number(row[3]) + 6)
  lines[1] = row.join(",")
  await Bun.write(path, lines.join("\n") + "\n")
  const result = await read(directory)
  if (result.code) throw new Error(result.error)
  const report = await Bun.file(join(directory, "channel-report.json")).json()
  expect(report.numericalConsistencyPassed).toBe(false)
  expect(report.maximumScatteringSingularValue).toBeGreaterThan(1)
})

test("native four-port TSX results retain every column and the explicit mixed-mode pairing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "palace-fourport-reader-"))
  await cp(
    join(import.meta.dir, "fixtures/palace-differential-channel"),
    directory,
    { recursive: true },
  )
  const result = await read(directory, ["--pairs", "1,3;2,4"])
  if (result.code) throw new Error(result.error)
  const report = await Bun.file(join(directory, "channel-report.json")).json()
  expect(report.ports).toEqual(["U1.OUT", "U2.IN", "U3.OUT", "U4.IN"])
  expect(report.nativeRuns).toHaveLength(4)
  expect(
    report.nativeRuns.every(
      (run: { gmresIterations: number[] }) => run.gmresIterations.length === 5,
    ),
  ).toBe(true)
  expect(report.maximumReciprocityError).toBeLessThan(1e-8)
  expect(report.maximumScatteringSingularValue).toBeLessThan(1)
  expect(report.mixedMode.pairIndicesOneBased).toEqual([
    [1, 3],
    [2, 4],
  ])
  expect(report.mixedMode.differentialReferenceOhms).toBe(100)
  expect(report.mixedMode.commonReferenceOhms).toBe(25)
  expect(report.convergenceProven).toBe(false)
})

test("convergence comparisons reject changed port geometry even when scattering columns are unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "palace-port-provenance-"))
  const directories = [join(root, "p1"), join(root, "p2"), join(root, "p3")]
  await cp(join(import.meta.dir, "fixtures/palace-channel"), directories[0], {
    recursive: true,
  })
  for (const order of [2, 3]) {
    await cp(
      join(
        import.meta.dir,
        `../examples/am3352/palace-channel/tsx-control/p${order}`,
      ),
      directories[order - 1],
      { recursive: true },
    )
  }
  for (const directory of directories) {
    const result = await read(directory)
    if (result.code) throw new Error(result.error)
  }
  const p2 = await Bun.file(join(directories[1], "channel-report.json")).json()
  expect(p2.nativeRuns[1].gmresIterations).toEqual([2, 1, 1, 1, 1])
  const args = [
    "--compare",
    ...directories,
    "--output",
    join(root, "comparison.json"),
  ]
  expect((await read(root, args)).code).toBe(0)
  const report = await Bun.file(join(root, "comparison.json")).json()
  expect(report.convergenceProven).toBe(false)
  expect(report.maximumComplexDifferences[1]).toBeCloseTo(0.0362367, 6)
  const staleLogPath = join(directories[1], "palace-2.log")
  const completedLog = await Bun.file(staleLogPath).text()
  await Bun.write(
    staleLogPath,
    completedLog.replace(/^Total\s+.*$/m, "Incomplete"),
  )
  const stale = await read(root, args)
  expect(stale.code).not.toBe(0)
  expect(stale.error).toContain("no completion record")
  expect(await Bun.file(join(root, "comparison.json")).exists()).toBe(false)
  await Bun.write(staleLogPath, completedLog)
  const inputPath = join(directories[2], "solver-input.json")
  const input = await Bun.file(inputPath).json()
  input.ports[0].widthMm = 0.1
  await Bun.write(inputPath, JSON.stringify(input))
  expect((await read(directories[2])).code).toBe(0)
  const invalid = await read(root, args)
  expect(invalid.code).not.toBe(0)
  expect(invalid.error).toContain("changed portGeometrySha256")
})

test("mixed-mode refinement can fail while every single-ended change passes", async () => {
  // Constructed comparison regression using a TSX control receipt, not an EM study.
  const root = await mkdtemp(join(tmpdir(), "palace-mixed-refinement-"))
  const directories = []
  for (let level = 0; level < 3; level++) {
    const directory = await fixture()
    directories.push(directory)
    const input = await Bun.file(join(directory, "solver-input.json")).json()
    input.ports = ["P.source", "P.load", "N.source", "N.load"].map((name) => ({
      name,
    }))
    input.frequenciesHz = [400_000_000]
    input.order = level + 1
    await Bun.write(join(directory, "solver-input.json"), JSON.stringify(input))
    const log =
      (await Bun.file(join(directory, "palace-1.log")).text()).replace(
        /GMRES solver converged in \d+ iterations[^\n]*\n/g,
        "",
      ) + "\nGMRES solver converged in 1 iterations\n"
    for (let excited = 1; excited <= 4; excited++) {
      await Bun.write(join(directory, `palace-${excited}.log`), log)
      const subdir = join(directory, `postpro/port-${excited}`)
      await mkdir(subdir, { recursive: true })
      const header = ["f (GHz)"]
      const row = ["0.4"]
      for (let observed = 1; observed <= 4; observed++) {
        header.push(
          `|S[${observed}][${excited}]| (dB)`,
          `arg(S[${observed}][${excited}]) (deg.)`,
        )
        row.push(String(20 * Math.log10(0.2 + 0.006 * level)), "0")
      }
      await Bun.write(
        join(subdir, "port-S.csv"),
        `${header.join(",")}\n${row.join(",")}\n`,
      )
    }
    const result = await read(directory, ["--pairs", "1,3;2,4"])
    if (result.code) throw new Error(result.error)
  }
  const output = join(root, "comparison.json")
  const result = await read(root, [
    "--compare",
    ...directories,
    "--output",
    output,
  ])
  if (result.code) throw new Error(result.error)
  const comparison = await Bun.file(output).json()
  expect(
    comparison.runs.every(
      (run: { numericalConsistencyPassed: boolean }) =>
        run.numericalConsistencyPassed,
    ),
  ).toBe(true)
  expect(comparison.maximumComplexDifferences[1]).toBeCloseTo(0.006, 10)
  expect(comparison.maximumMixedModeDifferences[1]).toBeCloseTo(0.012, 10)
  expect(comparison.convergenceProven).toBe(false)
  expect(
    (await Bun.file(join(directories[2], "channel-report.json")).json())
      .mixedMode.pairIndicesOneBased,
  ).toEqual([
    [1, 3],
    [2, 4],
  ])
})
