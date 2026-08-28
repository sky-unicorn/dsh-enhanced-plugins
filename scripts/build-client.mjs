import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import * as esbuild from 'esbuild'

export const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

export async function buildClient({ root, packageName, clientEntry, lib }) {
  const result = await esbuild.build({
    entryPoints: [resolve(root, clientEntry)],
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
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
