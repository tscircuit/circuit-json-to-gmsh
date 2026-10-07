import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type {
  GeometryModel,
  GeometryReport,
  GmshResult,
  PreviewSolid,
  MeshValidationRequirements,
} from "./types"
import { validateMesh } from "./validate-mesh"

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
  /** Check physical endpoint contacts and copper paths in the saved mesh. */
  validationRequirements?: MeshValidationRequirements
  /** Fail when minSICN is at or below this threshold; default 0. */
  minimumTetQuality?: number
  /** Crop all material slabs to [minX, minY, maxX, maxY], in mm.
   * This truncates reference planes and routes; it is not an EM boundary condition. */
  boundsMm?: [number, number, number, number]
  /** Native CAD/mesh threads; default 1 keeps regression meshes deterministic. */
  threads?: number
  /** Apply native Netgen tetrahedron optimization before saving. */
  optimizeNetgen?: boolean
  /** Partition adjacent z slabs in smaller OCC batches. Saved-mesh validation
   * still rejects any lost/shared interface, regardless of strategy. */
  fragmentStrategy?: "global" | "slab"
  /** Optional contour approximation in mm; 0 preserves contours. Physical
   * drills/cutouts, polygon topology and net separation remain checked.
   * Displacement and added/removed copper are recorded in the report. */
  simplifyToleranceMm?: number
  /** Crop around selected routed nets, with all neighbouring copper retained
   * inside the domain. This is an analysis boundary, not the physical PCB edge. */
  routeCorridor?: { netIds: string[]; marginMm: number }
}): Promise<GmshResult> {
  const output = resolve(options.outputDirectory)
  const meshSize = options.meshSizeMm ?? 0.5
  const repairRadius = options.repairRadiusMm ?? 0.0001
  if (
    options.minimumTetQuality !== undefined &&
    (!Number.isFinite(options.minimumTetQuality) ||
      options.minimumTetQuality < 0 ||
      options.minimumTetQuality >= 1)
  )
    throw new Error(
      "minimumTetQuality must be between 0 (inclusive) and 1 (exclusive)",
    )
  if (!Number.isFinite(repairRadius) || repairRadius < 0 || repairRadius > 0.01)
    throw new Error("repairRadiusMm must be between 0 and 0.01 mm")
  if (!Number.isFinite(meshSize) || meshSize <= 0)
    throw new Error("meshSizeMm must be positive")
  if (options.cutawayX !== undefined && !Number.isFinite(options.cutawayX))
    throw new Error("cutawayX must be finite")
  if (options.cadOnly && options.conformal)
    throw new Error("cadOnly and conformal cannot both be set")
  if (
    options.routeCorridor &&
    (!options.routeCorridor.netIds.length ||
      !options.routeCorridor.netIds.every(
        (n) => typeof n === "string" && n.length && !n.includes(","),
      ) ||
      !Number.isFinite(options.routeCorridor.marginMm) ||
      options.routeCorridor.marginMm <= 0)
  )
    throw new Error(
      "routeCorridor requires netIds and a positive finite marginMm",
    )
  if (
    options.simplifyToleranceMm !== undefined &&
    (!Number.isFinite(options.simplifyToleranceMm) ||
      options.simplifyToleranceMm < 0 ||
      options.simplifyToleranceMm > 0.005)
  )
    throw new Error("simplifyToleranceMm must be between 0 and 0.005 mm")
  if (
    options.threads !== undefined &&
    (!Number.isInteger(options.threads) ||
      options.threads < 1 ||
      options.threads > 64)
  )
    throw new Error("threads must be an integer between 1 and 64")
  if (
    options.boundsMm &&
    (!options.boundsMm.every(Number.isFinite) ||
      options.boundsMm[0] >= options.boundsMm[2] ||
      options.boundsMm[1] >= options.boundsMm[3])
  )
    throw new Error(
      "boundsMm must contain finite minX, minY, maxX, maxY with positive area",
    )
  await mkdir(output, { recursive: true })
  const failurePath = join(output, "failure.json")
  await rm(failurePath, { force: true })
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
  if (options.optimizeNetgen) command.push("--optimize-netgen")
  if (options.routeCorridor)
    command.push(
      "--corridor-nets",
      options.routeCorridor.netIds.join(","),
      "--corridor-margin",
      String(options.routeCorridor.marginMm),
    )
  if (options.fragmentStrategy)
    command.push("--fragment-strategy", options.fragmentStrategy)
  if (options.simplifyToleranceMm !== undefined)
    command.push("--simplify-tolerance", String(options.simplifyToleranceMm))
  if (options.threads !== undefined)
    command.push("--threads", String(options.threads))
  if (options.boundsMm)
    command.push("--bounds", ...options.boundsMm.map(String))
  if (options.cutawayX !== undefined)
    command.push("--cutaway-x", String(options.cutawayX))
  const subprocess = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ])
  await writeFile(join(output, "gmsh.log"), stdout + stderr)
  if (exitCode) {
    const reproduction = await readFile(failurePath, "utf8").catch(
      () => undefined,
    )
    if (!reproduction) {
      const progress = await readFile(join(output, "progress.json"), "utf8")
        .then((s) => JSON.parse(s))
        .catch(() => undefined)
      await writeFile(
        failurePath,
        JSON.stringify(
          {
            schemaVersion: 1,
            kind: "native_export",
            exitCode,
            progress,
            logPath: join(output, "gmsh.log"),
          },
          null,
          2,
        ),
      )
    }
    throw new Error(
      `Gmsh failed (${exitCode}); see ${join(output, "gmsh.log")}\n${stderr.slice(-3000)}`,
    )
  }
  const report: GeometryReport = JSON.parse(
    await readFile(join(output, "report.json"), "utf8"),
  )
  const preview: PreviewSolid[] = JSON.parse(
    await readFile(join(output, "preview.json"), "utf8"),
  )
  const meshPath = options.conformal ? join(output, "board.msh") : undefined
  const manifestPath = options.conformal
    ? join(output, "mesh-manifest.json")
    : undefined
  const validation = meshPath
    ? await validateMesh({
        meshPath,
        manifestPath,
        model: options.model,
        requirements: options.validationRequirements,
        minimumTetQuality: options.minimumTetQuality,
        outputDirectory: output,
        python: options.python,
      })
    : undefined
  if (validation && !validation.passed) {
    await writeFile(
      failurePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          kind: "mesh_validation",
          checks: validation.checks.filter((c) => c.passed === false),
          reportPath: join(output, "validation.json"),
        },
        null,
        2,
      ),
    )
    throw new Error(
      `Mesh validation failed: ${validation.checks
        .filter((c) => c.passed === false)
        .map((c) => c.name)
        .join(", ")}; see ${join(output, "validation.json")}`,
    )
  }
  return {
    report,
    preview,
    brepPath: join(output, "board.brep"),
    meshPath,
    manifestPath,
    validation,
  }
}
