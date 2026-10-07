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
