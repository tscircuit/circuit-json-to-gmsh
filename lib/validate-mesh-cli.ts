import { parseArgs } from "node:util"
import { validateMesh } from "./validate-mesh"
import type { GeometryModel, MeshValidationRequirements } from "./types"

export async function validateMeshCli(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      manifest: { type: "string" },
      model: { type: "string" },
      "requirements-file": { type: "string" },
      output: { type: "string" },
      "minimum-tet-quality": { type: "string", default: "0" },
      help: { type: "boolean" },
    },
  })
  if (values.help || !positionals[0]) {
    console.log(
      "Usage: circuit-json-to-gmsh validate board.msh --manifest mesh-manifest.json --model model.json [--requirements-file requirements.json] [--output validation-output] [--minimum-tet-quality 0]",
    )
    return values.help ? 0 : 1
  }
  const model: GeometryModel | undefined = values.model
    ? await Bun.file(values.model).json()
    : undefined
  const requirements: MeshValidationRequirements | undefined = values[
    "requirements-file"
  ]
    ? await Bun.file(values["requirements-file"]).json()
    : undefined
  const report = await validateMesh({
    meshPath: positionals[0],
    manifestPath: values.manifest,
    model,
    requirements,
    outputDirectory: values.output,
    minimumTetQuality: Number(values["minimum-tet-quality"]),
  })
  console.log(JSON.stringify(report, null, 2))
  return report.passed ? 0 : 1
}
