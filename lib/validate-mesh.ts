import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type {
  GeometryModel,
  MeshValidationReport,
  MeshValidationRequirements,
} from "./types"

/** Independently reload the saved mesh. Failed checks are returned for inspection. */
export async function validateMesh(options: {
  meshPath: string
  manifestPath?: string
  model?: GeometryModel
  requirements?: MeshValidationRequirements
  outputDirectory?: string
  minimumTetQuality?: number
  python?: string
}): Promise<MeshValidationReport> {
  const output = resolve(options.outputDirectory ?? dirname(options.meshPath))
  const minimumTetQuality = options.minimumTetQuality ?? 0
  if (
    !Number.isFinite(minimumTetQuality) ||
    minimumTetQuality < 0 ||
    minimumTetQuality >= 1
  )
    throw new Error(
      "minimumTetQuality must be between 0 (inclusive) and 1 (exclusive)",
    )
  await mkdir(output, { recursive: true })
  const reportPath = join(output, "validation.json")
  const command = [
    options.python ?? process.env.GMSH_PYTHON ?? "python3",
    join(dirname(fileURLToPath(import.meta.url)), "python", "validate_mesh.py"),
    "--mesh",
    resolve(options.meshPath),
    "--output",
    reportPath,
    "--minimum-quality",
    String(minimumTetQuality),
  ]
  if (options.manifestPath)
    command.push("--manifest", resolve(options.manifestPath))
  if (options.model) {
    const modelPath = join(output, "validation-model.json")
    await writeFile(modelPath, JSON.stringify(options.model))
    command.push("--model", modelPath)
  }
  if (options.requirements) {
    const requirementsPath = join(output, "validation-requirements.json")
    await writeFile(requirementsPath, JSON.stringify(options.requirements))
    command.push("--requirements", requirementsPath)
  }
  const subprocess = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ])
  await writeFile(join(output, "validation.log"), stdout + stderr)
  if (exitCode)
    throw new Error(
      `Mesh validator failed (${exitCode}); see ${join(output, "validation.log")}\n${stderr.slice(-3000)}`,
    )
  return JSON.parse(await readFile(reportPath, "utf8"))
}
