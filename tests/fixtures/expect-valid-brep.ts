import { expect } from "bun:test"
import { join } from "node:path"

export async function expectValidBrep(path: string) {
  const subprocess = Bun.spawn(
    [
      process.env.GMSH_PYTHON ?? "python3",
      join(import.meta.dir, "../../lib/python/validate_brep.py"),
      "--brep",
      path,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [code, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ])
  if (code) throw new Error(`BREP validator failed: ${stderr}`)
  const report = JSON.parse(stdout)
  expect(report.valid).toBe(true)
  expect(report.invalidSolidIndices).toEqual([])
}
