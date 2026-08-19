import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const LIB = resolve(ROOT, 'lib')
const PACKAGE_ID = 'dsh-enhanced-plugins'
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

const HOST_ENTRIES = [
  'src/index.ts',
  'src/edit-last-message/shared.ts',
  'src/edit-last-message/host/index.ts',
  'src/edit-last-message/host/remote.ts',
  'src/edit-last-message/host/rewind.ts',
  'src/mcp-server-manager/host/importers.ts',
  'src/mcp-server-manager/host/index.ts',
  'src/mcp-server-manager/host/manager.ts',
  'src/mcp-server-manager/host/remote.ts',
  'src/mcp-server-manager/host/schema.ts',
  'src/mcp-server-manager/host/types.ts',
  'src/mcp-server-manager/host/validation.ts',
  'src/plugin-market/contracts.ts',
  'src/plugin-market/index.ts',
  'src/plugin-market/market-utils.ts',
  'src/referenced-file/host/config.ts',
  'src/referenced-file/host/index-cache.ts',
  'src/referenced-file/host/index.ts',
  'src/referenced-file/host/listing.ts',
  'src/referenced-file/host/references.ts',
  'src/referenced-file/host/remote.ts',
  'src/referenced-file/host/types.ts',
  'src/sub-agent/host.ts',
  'src/sub-agent/preset.ts',
  'src/sub-agent/settings.ts',
  'src/sub-agent/shared.ts',
].map(entry => resolve(ROOT, entry))

async function main() {
  await rm(LIB, { recursive: true, force: true })
  await mkdir(LIB, { recursive: true })

  await esbuild.build({
    entryPoints: HOST_ENTRIES,
    outbase: resolve(ROOT, 'src'),
    outdir: LIB,
    bundle: false,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    logLevel: 'warning',
  })

  const result = await esbuild.build({
    entryPoints: [resolve(ROOT, 'src/client/index.ts')],
    tsconfig: resolve(ROOT, 'tsconfig.client.json'),
    outfile: resolve(LIB, 'client.js'),
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    target: 'es2022',
    external: CLIENT_EXTERNALS,
    loader: { '.module.css': 'local-css' },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    write: false,
    logLevel: 'warning',
  })

  const javascript = result.outputFiles.find(file => file.path.endsWith('.js'))
  const stylesheet = result.outputFiles.find(file => file.path.endsWith('.css'))
  if (javascript === undefined) throw new Error('client build produced no JavaScript output')

  const styleInjection = stylesheet === undefined ? '' : [
    `var __dshCss = ${JSON.stringify(stylesheet.text)};`,
    `var __dshTagId = ${JSON.stringify(`${PACKAGE_ID}/bundle.css`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css="\' + __dshTagId + \'"]\') === null) {',
    '  var __dshTag = document.createElement(\'style\');',
    `  __dshTag.dataset.plugin = ${JSON.stringify(PACKAGE_ID)};`,
    '  __dshTag.dataset.pluginCss = __dshTagId;',
    '  __dshTag.textContent = __dshCss;',
    '  document.head.appendChild(__dshTag);',
    '}',
  ].join('\n')

  const wrapped = [
    'window.__ModuleLoader__.load({',
    `  id: ${JSON.stringify(PACKAGE_ID)},`,
    '  factory: (require) => {',
    '    var module = { exports: {} };',
    '    var exports = module.exports;',
    styleInjection,
    javascript.text,
    '    return module.exports;',
    '  }',
    '});',
  ].filter(Boolean).join('\n')

  await writeFile(resolve(LIB, 'client.js'), wrapped)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
