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
  /** Native Gmsh tetrahedralizer; default Delaunay. CAD is unchanged. */
  tetrahedralAlgorithm?: "delaunay" | "hxt"
  /** Partition adjacent z slabs in smaller OCC batches. Saved-mesh validation
   * still rejects any lost/shared interface, regardless of strategy. */
  fragmentStrategy?: "global" | "slab" | "tiled"
  /** XY CAD batch width for tiled partition; default 2 mm. Not a mesh size. */
  tileSizeMm?: number
  /** Isolated native CAD processes, default 1. */
  tileWorkers?: number
  /** Reuse hash-verified CAD batches across mesh refinements. */
  tileCacheDirectory?: string
  /** Remesh a complete conformal CAD checkpoint with matching geometry and ports.
   * Checks content/geometry hashes; saved-mesh validation is always rerun. */
  cadCheckpointDirectory?: string
  /** Enclose the cropped PCB in air, including physical drill/cutout voids. */
  airPaddingMm?: number
  /** Explicit coplanar outer-pad ports; requires an air enclosure. Frequency belongs to the EM solver. */
  lumpedPorts?: {
    terminal: MeshValidationRequirements["terminals"][number]
    referenceNetId: string
    widthMm?: number
  }[]
  /** Optional contour approximation in mm; 0 preserves contours. Physical
   * drills/cutouts, polygon topology and net separation remain checked.
   * Displacement and added/removed copper are recorded in the report. */
  simplifyToleranceMm?: number
  /** Crop around selected routed nets, with all neighbouring copper retained
   * inside the domain. This is an analysis boundary, not the physical PCB edge. */
  routeCorridor?: { netIds: string[]; marginMm: number }
}): Promise<GmshResult> {
  const output = resolve(options.outputDirectory)
  if (
    options.cadCheckpointDirectory &&
    (!options.conformal || resolve(options.cadCheckpointDirectory) === output)
  )
    throw new Error(
      "CAD checkpoint requires conformal export to a different output directory",
    )
  const meshSize = options.meshSizeMm ?? 0.5
  const repairRadius = options.repairRadiusMm ?? 0.0001
  if (
    options.tetrahedralAlgorithm !== undefined &&
    options.tetrahedralAlgorithm !== "delaunay" &&
    options.tetrahedralAlgorithm !== "hxt"
  )
    throw new Error("tetrahedralAlgorithm must be delaunay or hxt")
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
  if (
    options.tileSizeMm !== undefined &&
    (!Number.isFinite(options.tileSizeMm) || options.tileSizeMm <= 0)
  )
    throw new Error("tileSizeMm must be positive")
  if (
    options.airPaddingMm !== undefined &&
    (!Number.isFinite(options.airPaddingMm) || options.airPaddingMm <= 0)
  )
    throw new Error("airPaddingMm must be positive")
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
  if (options.lumpedPorts?.length) {
    if (!options.airPaddingMm || !options.conformal)
      throw new Error("Lumped ports require conformal mesh and airPaddingMm")
    for (const port of options.lumpedPorts) {
      if (
        !port.referenceNetId ||
        (port.widthMm !== undefined &&
          (!Number.isFinite(port.widthMm) || port.widthMm <= 0))
      )
        throw new Error(
          "Lumped ports require referenceNetId and positive widthMm",
        )
    }
    await writeFile(
      join(output, "port-requirements.json"),
      JSON.stringify(options.lumpedPorts),
    )
  }
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
  if (options.tileWorkers !== undefined)
    command.push("--tile-workers", String(options.tileWorkers))
  if (options.tileCacheDirectory)
    command.push("--tile-cache", resolve(options.tileCacheDirectory))
  if (options.cadCheckpointDirectory)
    command.push("--cad-checkpoint", resolve(options.cadCheckpointDirectory))
  if (options.conformal) command.push("--conformal")
  if (options.lumpedPorts?.length)
    command.push("--port-requirements", join(output, "port-requirements.json"))
  if (options.cadOnly) command.push("--cad-only")
  if (options.step) command.push("--step")
  if (options.optimizeNetgen) command.push("--optimize-netgen")
  if (options.tetrahedralAlgorithm)
    command.push("--tetrahedral-algorithm", options.tetrahedralAlgorithm)
  if (options.routeCorridor)
    command.push(
      "--corridor-nets",
      options.routeCorridor.netIds.join(","),
      "--corridor-margin",
      String(options.routeCorridor.marginMm),
    )
  if (options.fragmentStrategy)
    command.push("--fragment-strategy", options.fragmentStrategy)
  if (options.tileSizeMm !== undefined)
    command.push("--tile-size", String(options.tileSizeMm))
  if (options.simplifyToleranceMm !== undefined)
    command.push("--simplify-tolerance", String(options.simplifyToleranceMm))
  if (
    options.tileWorkers !== undefined &&
    (!Number.isInteger(options.tileWorkers) ||
      options.tileWorkers < 1 ||
      options.tileWorkers > 8)
  )
    throw new Error("tileWorkers must be an integer from 1 to 8")
  if (options.airPaddingMm !== undefined)
    command.push("--air-padding", String(options.airPaddingMm))
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
  let requirements = options.validationRequirements
  if (options.lumpedPorts?.length) {
    const ports: {
      name: string
      signalNetId: string
      positionMm: [number, number, number]
      referenceNetId: string
      referencePositionMm: [number, number, number]
    }[] = JSON.parse(await readFile(join(output, "ports.json"), "utf8"))
    requirements = {
      terminals: [...(requirements?.terminals ?? [])],
      connections: [...(requirements?.connections ?? [])],
    }
    const byNet = new Map<string, string[]>()
    for (const port of ports) {
      for (const terminal of [
        {
          name: port.name,
          netId: port.signalNetId,
          positionMm: port.positionMm,
        },
        {
          name: `${port.name}.reference`,
          netId: port.referenceNetId,
          positionMm: port.referencePositionMm,
        },
      ]) {
        const existing = requirements.terminals.find(
          (t) => t.name === terminal.name,
        )
        if (!existing) requirements.terminals.push(terminal)
        else if (
          existing.netId !== terminal.netId ||
          existing.positionMm.some(
            (v, i) => Math.abs(v - terminal.positionMm[i]) > 1e-8,
          )
        )
          throw new Error(
            "Port terminal conflicts with validation requirements",
          )
        const names = byNet.get(terminal.netId) ?? []
        names.push(terminal.name)
        byNet.set(terminal.netId, names)
      }
    }
    for (const names of byNet.values())
      for (const name of names.slice(1))
        requirements.connections.push({ from: names[0], to: name })
  }
  const validation = meshPath
    ? await validateMesh({
        meshPath,
        manifestPath,
        model: options.model,
        requirements,
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
