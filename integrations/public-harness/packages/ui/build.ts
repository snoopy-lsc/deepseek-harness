/** Bundle the browser entry into the documented client module loader format. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('.', import.meta.url))
const output = await build({ entryPoints: [join(root, 'src/client/index.tsx')],
  bundle: true, write: false, platform: 'browser', format: 'cjs', target: 'es2022',
  jsx: 'automatic', external: ['react', 'react/jsx-runtime', '@deepseek-ai/*'],
})
const client = output.outputFiles?.[0]
if (client === undefined) throw new Error('client bundle was not emitted')
await mkdir(join(root, 'lib'), { recursive: true })
await build({ entryPoints: [join(root, 'src/index.ts')], bundle: true, platform: 'node',
  format: 'esm', target: 'node22', outfile: join(root, 'lib/index.js') })
await writeFile(join(root, 'lib/client.js'), `window.__ModuleLoader__.load({\n  id: '@public-harness/ui',\n  factory: (require) => {\n    const module = { exports: {} };\n    const exports = module.exports;\n${client.text}\n    return module.exports;\n  },\n});\n`)
