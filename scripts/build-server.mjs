import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

export const outputDirectory = resolve(process.env.ONEIMAGE_SERVER_BUILD_DIR ?? join(tmpdir(), 'oneimage-server-build'))
await mkdir(outputDirectory, { recursive: true })
await build({
  bundle: true,
  entryPoints: ['server/index.ts'],
  // onnxruntime-node must stay external: its glue resolves the platform
  // .node binding relative to node_modules, and inlining it would break that
  // path in the single-file bundle.
  external: ['node:*', 'onnxruntime-node'],
  format: 'cjs',
  outfile: join(outputDirectory, 'index.cjs'),
  platform: 'node',
  sourcemap: true,
})
