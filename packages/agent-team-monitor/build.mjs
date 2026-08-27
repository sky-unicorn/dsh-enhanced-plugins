import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const root = fileURLToPath(new URL('.', import.meta.url))
const externals = ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-runtime/client', '@deepseek-ai/dsh-client-ui-primitives']

/** Self-contained prepare: source checkouts use the shared source; tarballs include a buildable snapshot of it. */
export async function build() {
  const shared = resolve(root, '../../src/agent-team-monitor')
  let inRepository = false
  try { inRepository = JSON.parse(await readFile(resolve(root, '../../package.json'), 'utf8')).name === 'dsh-enhanced-plugins' } catch {}
  const source = inRepository && existsSync(shared) ? shared : resolve(root, 'src')
  if (source === shared) {
    // This is the package's generated source snapshot, not the canonical source.
    await rm(resolve(root, 'src'), { recursive: true, force: true })
    await cp(source, resolve(root, 'src'), { recursive: true })
  }
  const lib = resolve(root, 'lib')
  // Exact package-owned build directory, never a workspace or source directory.
  await rm(lib, { recursive: true, force: true })
  await mkdir(lib, { recursive: true })
  await esbuild.build({ entryPoints: [resolve(source, 'host/index.ts')], outfile: resolve(lib, 'agent-team-monitor/host/index.js'),
    bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', logLevel: 'warning' })
  const result = await esbuild.build({ entryPoints: [resolve(source, 'client/index.ts')], outfile: resolve(lib, 'client.js'),
    bundle: true, platform: 'browser', format: 'cjs', target: 'es2022', external: externals,
    loader: { '.module.css': 'local-css' }, tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
    define: { 'process.env.NODE_ENV': '"production"' }, write: false, logLevel: 'warning' })
  const js = result.outputFiles.find(file => file.path.endsWith('.js'))?.text
  const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? ''
  if (js === undefined) throw new Error('Team monitor client bundle missing')
  const { name } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  await writeFile(resolve(lib, 'client.js'), `window.__ModuleLoader__.load({id:${JSON.stringify(name)},factory:(require)=>{
var module={exports:{}};var exports=module.exports;
var styleId=${JSON.stringify(`${name}/bundle.css`)};
if(!document.querySelector('style[data-plugin-css="'+styleId+'"]')){var tag=document.createElement('style');tag.dataset.pluginCss=styleId;tag.textContent=${JSON.stringify(css)};document.head.appendChild(tag);}
${js}
return module.exports;}});`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await build()
