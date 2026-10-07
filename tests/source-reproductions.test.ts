import { expect, test } from "bun:test"
import { join } from "node:path"

for (const name of [
  "top-pinched-hole",
  "bottom-touching-antipads",
  "ddr-vref-inner1",
])
  test(`original AM3352 ${name} is invalid in OCC; repaired solid is valid`, async () => {
    for (const repaired of [false, true]) {
      const path = join(
        import.meta.dir,
        `../examples/am3352/${name}-${repaired ? "fixed" : "original"}.brep`,
      )
      const process = Bun.spawn(
        [
          globalThis.process.env.GMSH_PYTHON ?? "python3",
          join(import.meta.dir, "../lib/python/validate_brep.py"),
          "--brep",
          path,
        ],
        { stdout: "pipe", stderr: "pipe" },
      )
      const [code, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ])
      if (code) throw new Error(stderr)
      const report = JSON.parse(stdout)
      expect(report.solids).toBe(1)
      expect(report.valid).toBe(repaired)
    }
  }, 30_000)
