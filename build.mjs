import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
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

const AGGREGATE_HOST_ENTRIES = [
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
  'src/notification/shared.ts',
  'src/notification/host/config.ts',
  'src/notification/host/desktop.ts',
  'src/notification/host/index.ts',
  'src/notification/host/position-store.ts',
  'src/notification/host/remote.ts',
  'src/notification/host/sound-files.ts',
  'src/notification/host/sound-library.ts',
  'src/notification/host/state.ts',
  'src/plugin-market/contracts.ts',
  'src/plugin-market/index.ts',
  'src/plugin-market/market-utils.ts',
  'src/sub-agent/host.ts',
  'src/sub-agent/preset.ts',
  'src/sub-agent/settings.ts',
  'src/sub-agent/shared.ts',
]

const FEATURE_TARGETS = [
  {
    id: 'edit-last-message',
    directory: 'packages/edit-last-message',
    hostEntries: [
      'src/edit-last-message/shared.ts',
      'src/edit-last-message/host/index.ts',
      'src/edit-last-message/host/remote.ts',
      'src/edit-last-message/host/rewind.ts',
    ],
    clientEntry: 'src/edit-last-message/client/index.ts',
  },
  {
    id: 'mcp-server-manager',
    directory: 'packages/mcp-server-manager',
    hostEntries: [
      'src/mcp-server-manager/host/importers.ts',
      'src/mcp-server-manager/host/index.ts',
      'src/mcp-server-manager/host/manager.ts',
      'src/mcp-server-manager/host/remote.ts',
      'src/mcp-server-manager/host/schema.ts',
      'src/mcp-server-manager/host/types.ts',
      'src/mcp-server-manager/host/validation.ts',
    ],
    clientEntry: 'src/mcp-server-manager/client/index.ts',
  },
  {
    id: 'model-input-types',
    directory: 'packages/model-input-types',
    hostEntries: ['src/model-input-types/host/index.ts'],
    clientEntry: 'src/model-input-types/client/index.ts',
  },
  {
    id: 'notification',
    directory: 'packages/notification',
    hostEntries: [
      'src/notification/shared.ts',
      'src/notification/host/config.ts',
      'src/notification/host/desktop.ts',
      'src/notification/host/index.ts',
      'src/notification/host/position-store.ts',
      'src/notification/host/remote.ts',
      'src/notification/host/sound-files.ts',
      'src/notification/host/sound-library.ts',
      'src/notification/host/state.ts',
    ],
    clientEntry: 'src/notification/client/index.ts',
    assets: [{ source: 'assets/notification', destination: 'assets/notification' }],
  },
  {
    id: 'plugin-market',
    directory: 'packages/plugin-market',
    hostEntries: [
      'src/plugin-market/contracts.ts',
      'src/plugin-market/index.ts',
      'src/plugin-market/market-utils.ts',
    ],
    clientEntry: 'src/plugin-market/client/index.ts',
    assets: [{ source: 'assets/plugins-cache.json', destination: 'assets/plugins-cache.json' }],
  },
  {
    id: 'sub-agent',
    directory: 'packages/sub-agent',
    hostEntries: [
      'src/sub-agent/host.ts',
      'src/sub-agent/preset.ts',
      'src/sub-agent/settings.ts',
      'src/sub-agent/shared.ts',
    ],
    clientEntry: 'src/sub-agent/client/index.ts',
  },
]

async function packageNameAt(directory) {
  const manifest = JSON.parse(await readFile(resolve(ROOT, directory, 'package.json'), 'utf8'))
  if (typeof manifest.name !== 'string' || manifest.name === '') {
    throw new Error(`${directory}/package.json must declare a non-empty package name`)
  }
  return manifest.name
}

async function buildClient({ packageName, clientEntry, lib }) {
  const result = await esbuild.build({
    entryPoints: [resolve(ROOT, clientEntry)],
    tsconfig: resolve(ROOT, 'tsconfig.client.json'),
    outfile: resolve(lib, 'client.js'),
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
  if (javascript === undefined) throw new Error(`${packageName}: client build produced no JavaScript output`)

  const styleInjection = stylesheet === undefined ? '' : [
    `var __dshCss = ${JSON.stringify(stylesheet.text)};`,
    `var __dshTagId = ${JSON.stringify(`${packageName}/bundle.css`)};`,
    `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + __dshTagId + '"]') === null) {`,
    '  var __dshTag = document.createElement(\'style\');',
    `  __dshTag.dataset.plugin = ${JSON.stringify(packageName)};`,
    '  __dshTag.dataset.pluginCss = __dshTagId;',
    '  __dshTag.textContent = __dshCss;',
    '  document.head.appendChild(__dshTag);',
    '}',
  ].join('\n')

  const wrapped = [
    'window.__ModuleLoader__.load({',
    `  id: ${JSON.stringify(packageName)},`,
    '  factory: (require) => {',
    '    var module = { exports: {} };',
    '    var exports = module.exports;',
    styleInjection,
    javascript.text,
    '    return module.exports;',
    '  }',
    '});',
  ].filter(Boolean).join('\n')

  await writeFile(resolve(lib, 'client.js'), wrapped)
}

async function buildTarget(target) {
  const outputRoot = resolve(ROOT, target.directory)
  const lib = resolve(outputRoot, 'lib')
  const packageName = await packageNameAt(target.directory)
  await rm(lib, { recursive: true, force: true })
  await mkdir(lib, { recursive: true })

  await esbuild.build({
    entryPoints: target.hostEntries.map(entry => resolve(ROOT, entry)),
    outbase: resolve(ROOT, 'src'),
    outdir: lib,
    bundle: false,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    logLevel: 'warning',
  })

  await buildClient({ packageName, clientEntry: target.clientEntry, lib })

  if (target.directory !== '.') {
    const assetsRoot = resolve(outputRoot, 'assets')
    await rm(assetsRoot, { recursive: true, force: true })
    for (const asset of target.assets ?? []) {
      const destination = resolve(outputRoot, asset.destination)
      await mkdir(dirname(destination), { recursive: true })
      await cp(resolve(ROOT, asset.source), destination, { recursive: true })
    }
  }
}

async function main() {
  const aggregate = {
    id: 'all',
    directory: '.',
    hostEntries: AGGREGATE_HOST_ENTRIES,
    clientEntry: 'src/client/index.ts',
  }
  const featureFlag = process.argv.indexOf('--feature')
  if (featureFlag !== -1) {
    const id = process.argv[featureFlag + 1]
    const target = id === 'all' ? aggregate : FEATURE_TARGETS.find(feature => feature.id === id)
    if (target === undefined) throw new Error(`unknown feature ${JSON.stringify(id)}`)
    await buildTarget(target)
    return
  }
  await buildTarget(aggregate)
  for (const target of FEATURE_TARGETS) await buildTarget(target)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
