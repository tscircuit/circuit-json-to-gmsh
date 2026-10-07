import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type {
  GeometryModel,
  GeometryReport,
  GmshResult,
  PreviewSolid,
} from "./types"

/** Run native Gmsh. CAD assemblies are the default; conformal=true also fragments
 * material interfaces and generates a tetrahedral volume mesh. */
export async function exportGmsh(options: {
  model: GeometryModel
  outputDirectory: string
  python?: string
  meshSizeMm?: number
  conformal?: boolean
  /** Skip triangulation for large CAD-only assemblies. Incompatible with conformal. */
  cadOnly?: boolean
  /** Also write STEP. Large assemblies can require substantially more memory. */
  step?: boolean
  /** Half width of notches at pinched holes, in mm; default 0.0001 (0.1 µm).
   * Zero rejects these shapes and writes failure.json for reproduction. */
  repairRadiusMm?: number
  /** Remove x above this coordinate for a real CAD cutaway, in mm. */
  cutawayX?: number
}): Promise<GmshResult> {
  const output = resolve(options.outputDirectory)
  const meshSize = options.meshSizeMm ?? 0.5
  const repairRadius = options.repairRadiusMm ?? 0.0001
  if (!Number.isFinite(repairRadius) || repairRadius < 0 || repairRadius > 0.01)
    throw new Error("repairRadiusMm must be between 0 and 0.01 mm")
  if (!Number.isFinite(meshSize) || meshSize <= 0)
    throw new Error("meshSizeMm must be positive")
  if (options.cutawayX !== undefined && !Number.isFinite(options.cutawayX))
    throw new Error("cutawayX must be finite")
  if (options.cadOnly && options.conformal)
    throw new Error("cadOnly and conformal cannot both be set")
  await mkdir(output, { recursive: true })
  const modelPath = join(output, "model.json")
  await writeFile(modelPath, JSON.stringify(options.model))
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    "python",
    "export.py",
  )
  const command = [
    options.python ?? process.env.GMSH_PYTHON ?? "python3",
    script,
    "--model",
    modelPath,
    "--output",
    output,
    "--mesh-size",
    String(meshSize),
    "--repair-radius",
    String(repairRadius),
  ]
  if (options.conformal) command.push("--conformal")
  if (options.cadOnly) command.push("--cad-only")
  if (options.step) command.push("--step")
  if (options.cutawayX !== undefined)
    command.push("--cutaway-x", String(options.cutawayX))
  const subprocess = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ])
  await writeFile(join(output, "gmsh.log"), stdout + stderr)
  if (exitCode)
    throw new Error(
      `Gmsh failed (${exitCode}); see ${join(output, "gmsh.log")}\n${stderr.slice(-3000)}`,
    )
  const report: GeometryReport = JSON.parse(
    await readFile(join(output, "report.json"), "utf8"),
  )
  const preview: PreviewSolid[] = JSON.parse(
    await readFile(join(output, "preview.json"), "utf8"),
  )
  return {
    report,
    preview,
    brepPath: join(output, "board.brep"),
    meshPath: options.conformal ? join(output, "board.msh") : undefined,
  }
}
