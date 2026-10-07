import { expect } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { decode } from "fast-png"

export async function expectPngSnapshot(options: {
  png: Uint8Array
  path: string
}) {
  await mkdir(dirname(options.path), { recursive: true })
  const actual = decode(options.png)
  let visible = 0
  for (let i = 0; i < actual.data.length; i += 4)
    if (
      [0, 1, 2].some(
        (channel) =>
          Math.abs(
            Number(actual.data[i + channel]) - Number(actual.data[channel]),
          ) > 5,
      )
    )
      visible++
  expect(visible / (actual.width * actual.height)).toBeGreaterThan(0.01)
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    await writeFile(options.path, options.png)
    return
  }
  if (!existsSync(options.path))
    throw new Error(
      `Missing snapshot ${options.path}; run UPDATE_SNAPSHOTS=1 bun test`,
    )
  const expected = decode(await readFile(options.path))
  expect(actual.width).toBe(expected.width)
  expect(actual.height).toBe(expected.height)
  expect(actual.data.length).toBe(expected.data.length)
  let changed = 0
  for (let i = 0; i < actual.data.length; i += 4)
    if (
      [0, 1, 2].some(
        (channel) =>
          Math.abs(
            Number(actual.data[i + channel]) -
              Number(expected.data[i + channel]),
          ) > 3,
      )
    )
      changed++
  if (changed > actual.width * actual.height * 0.001)
    await writeFile(options.path.replace(/\.png$/, ".actual.png"), options.png)
  expect(changed / (actual.width * actual.height)).toBeLessThanOrEqual(0.001)
}
