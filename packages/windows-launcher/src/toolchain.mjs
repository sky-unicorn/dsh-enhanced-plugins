import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import semver from 'semver'

const exists = file => fs.existsSync(file)
const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
const optionalText = file => exists(file) ? fs.readFileSync(file, 'utf8').trim() : ''
const versionOf = file => exists(file) ? json(file).version : ''

/** Detect nvm-windows without invoking nvm use or modifying its shared symlink. */
export function discoverNvm(env = process.env) {
  const candidates = [env.NVM_HOME, env.NVM_DIR,
    ...[env.APPDATA, env.LOCALAPPDATA].filter(Boolean).map(dir => path.join(dir, 'nvm')),
    ...(env.PATH ?? env.Path ?? '').split(path.delimiter).map(dir => dir.replace(/^"|"$/g, '')),
  ].filter(Boolean)
  for (const candidate of [...new Set(candidates)]) {
    if (!exists(path.join(candidate, 'nvm.exe'))) continue
    const settings = optionalText(path.join(candidate, 'settings.txt'))
    const root = /^root:\s*(.+)$/im.exec(settings)?.[1]?.trim() || candidate
    const versions = exists(root) ? fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && semver.valid(entry.name) && exists(path.join(root, entry.name, 'node.exe')))
      .map(entry => ({ version: semver.clean(entry.name), node: path.resolve(root, entry.name, 'node.exe') }))
      .sort((a, b) => semver.rcompare(a.version, b.version)) : []
    return { root: path.resolve(root), versions }
  }
  return null
}

/** Resolve the existing DSH CLI and its own manifest, never the user's task workspace. */
export function resolveProject(request) {
  if (request.sourceDirectory) {
    const root = path.resolve(request.sourceDirectory)
    const manifest = json(path.join(root, 'package.json'))
    if (manifest.name !== '@deepseek-ai/dsh-root') throw new Error('记录的源码目录不是 DSH checkout。')
    if (request.mode === 'desktop') {
      if (!exists(path.join(root, 'node_modules/tsx/dist/esm/index.mjs'))
          || !exists(path.join(root, 'apps/desktop/scripts/dev.ts'))) {
        throw new Error('DSH 桌面源码或依赖不完整，请先安装源码依赖。')
      }
      return { root, manifest, args: [], env: { TSX_TSCONFIG_PATH: path.join(root, 'tsconfig.json') } }
    }
    const loader = path.join(root, 'node_modules/tsx/dist/esm/index.mjs')
    const entry = path.join(root, 'apps/cli/src/bin.ts')
    if (!exists(loader) || !exists(entry)) throw new Error('DSH 源码缺少 tsx 或 CLI 入口，请先安装依赖。')
    return { root, manifest, args: ['--import', pathToFileURL(loader).href, entry],
      env: { TSX_TSCONFIG_PATH: path.join(root, 'tsconfig.json') } }
  }
  const command = path.resolve(request.dshCommand)
  const base = path.dirname(command)
  // npm global and local shims point to the same public bin declared by DSH.
  const roots = [path.join(base, 'node_modules/@deepseek-ai/dsh'), path.join(base, 'node_modules/dsh'),
    path.join(base, '../@deepseek-ai/dsh'), path.join(base, '../dsh'), path.join(base, '..')]
  for (const candidate of roots) {
    const manifestFile = path.join(candidate, 'package.json')
    if (!exists(manifestFile)) continue
    const manifest = json(manifestFile)
    if (!['@deepseek-ai/dsh', 'dsh'].includes(manifest.name)) continue
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
    if (typeof bin !== 'string') continue
    const root = fs.realpathSync(candidate)
    const entry = path.resolve(root, bin)
    if (!entry.startsWith(root + path.sep) || !exists(entry)) throw new Error('DSH package 的 CLI 入口无效。')
    // Do not silently replace an arbitrary custom executable with a nearby package.
    if (!['.ps1', '.cmd'].includes(path.extname(command).toLowerCase())) continue
    const shim = fs.readFileSync(command, 'utf8').replaceAll('\\', '/')
    if (!shim.includes(bin.replaceAll('\\', '/')) || !shim.includes(manifest.name)) continue
    return { root, manifest, args: [entry], env: {} }
  }
  throw new Error('无法从 DSH 启动器定位 package.json；请重新安装 Launcher 以记录 DSH 源码路径。')
}

/** A lock format identifies a manager, but cannot tell us an exact tool version. */
export function requirements(project) {
  const { root, manifest } = project
  const engines = manifest.engines || {}
  const nvmrc = optionalText(path.join(root, '.nvmrc')).replace(/#.*$/gm, '').trim()
  const nodeFile = optionalText(path.join(root, '.node-version'))
  const node = nvmrc || nodeFile || manifest.volta?.node || engines.node || '*'
  const nodeSource = nvmrc ? '.nvmrc' : nodeFile ? '.node-version' : manifest.volta?.node ? 'volta.node' : engines.node ? 'engines.node' : 'NVM 已安装版本'
  const declaration = manifest.packageManager || (manifest.devEngines?.packageManager?.name
    ? `${manifest.devEngines.packageManager.name}@${manifest.devEngines.packageManager.version || '*'}` : '')
  let manager, managerRange, managerSource
  if (declaration) {
    const match = /^(npm|pnpm|yarn)@([^+\s]+)(?:\+sha(?:224|256|384|512)\.[a-fA-F0-9]+)?$/.exec(declaration)
    if (!match) throw new Error('packageManager 声明无效或不受支持。')
    ;[, manager, managerRange] = match
    managerSource = manifest.packageManager ? 'packageManager' : 'devEngines.packageManager'
  } else {
    const locks = [['pnpm', 'pnpm-lock.yaml'], ['yarn', 'yarn.lock'], ['npm', 'npm-shrinkwrap.json'], ['npm', 'package-lock.json']]
      .filter(([, file]) => exists(path.join(root, file)))
    const declared = ['pnpm', 'yarn', 'npm'].filter(name => manifest.volta?.[name] || engines[name])
    if (declared.length > 1 || (!declared.length && new Set(locks.map(([name]) => name)).size > 1)) {
      throw new Error('发现多个包管理器，请在 DSH package.json 中明确 packageManager。')
    }
    manager = declared[0] || locks[0]?.[0] || 'npm'
    managerRange = manifest.volta?.[manager] || engines[manager] || '*'
    managerSource = manifest.volta?.[manager] ? `volta.${manager}` : engines[manager] ? `engines.${manager}` : locks[0]?.[1] || 'Node 内置 npm'
    if (manager === 'yarn' && managerRange === '*') {
      const lock = optionalText(path.join(root, 'yarn.lock'))
      // Yarn Classic and Berry use different distributions; the lock header can identify the family.
      if (/^# yarn lockfile v1\s*$/m.test(lock)) managerRange = '1.x'
      else if (/^__metadata:/m.test(lock)) managerRange = '>=2'
      else throw new Error('无法判定 Yarn Classic 或 Berry，请明确 packageManager 版本。')
    }
  }
  if (!semver.validRange(managerRange)) throw new Error('包管理器版本必须是有效的 SemVer 版本或范围。')
  return { node, nodeSource, nodeEngine: engines.node || '*', manager, managerRange, managerSource }
}

function matchesNode(version, range) {
  if (['node', 'stable', 'latest'].includes(range)) return semver.prerelease(version) === null
  if (/^lts\//i.test(range)) {
    const majors = { iron: 20, jod: 22, krypton: 24 }
    const alias = range.slice(4).toLowerCase()
    if (alias !== '*' && !majors[alias]) throw new Error(`不支持的 NVM 别名 ${range}；请使用版本号。`)
    // Only known LTS lines; never assume a future even release is already LTS.
    return Object.values(majors).includes(semver.major(version)) && (alias === '*' || semver.major(version) === majors[alias])
  }
  if (!semver.validRange(range)) throw new Error(`不支持的 Node 版本要求：${range}`)
  return semver.satisfies(version, range)
}

function run(node, args, options = {}) {
  const result = spawnSync(node, args, { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024, ...options })
  if (result.error || result.status !== 0) throw new Error('工具链命令失败，请检查网络、版本声明和本地安装。')
  return result.stdout.trim()
}

function managerPackage(name, version) {
  return name === 'yarn' && semver.major(version) >= 2 ? '@yarnpkg/cli-dist' : name
}
function cliPath(root, name) {
  const manifest = json(path.join(root, 'package.json'))
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[name]
  if (typeof bin !== 'string') throw new Error(`缺少 ${name} CLI 入口。`)
  const cli = path.resolve(root, bin)
  if (!cli.startsWith(path.resolve(root) + path.sep) || !exists(cli)) throw new Error(`${name} CLI 入口无效。`)
  return cli
}

/** Inspection is read-only. Preparation installs only the manager into Launcher-owned storage. */
export function inspectToolchain(request, env = process.env) {
  const nvm = discoverNvm(env)
  const summary = { requestId: request.requestId, mode: nvm ? 'sandbox' : 'system', phase: 'detected',
    nodeVersion: '', nodeRequirement: '', nodeSource: '', manager: '', managerVersion: '', managerRequirement: '',
    managerSource: '', projectPath: '', nodePath: '', message: '', nvmRoot: nvm?.root || '' }
  if (!nvm) {
    if (request.mode === 'desktop') {
      try {
        const project = resolveProject(request)
        const required = requirements(project)
        if (!matchesNode(process.versions.node, required.node) || !semver.satisfies(process.versions.node, required.nodeEngine)) {
          throw new Error(`当前 Node ${process.versions.node} 不满足 DSH ${required.node} / ${required.nodeEngine}。`)
        }
        Object.assign(summary, { projectPath: project.root, nodeVersion: process.versions.node,
          nodePath: process.execPath, nodeRequirement: required.node, nodeSource: '系统 Node',
          manager: required.manager, managerRequirement: required.managerRange, managerSource: required.managerSource,
          message: '使用系统 Node；启动前验证 DSH 声明的 pnpm 版本。' })
        return { summary, args: [], environment: { ...project.env,
          PATH: [path.dirname(process.execPath), env.PATH ?? env.Path ?? ''].join(path.delimiter) } }
      } catch (error) {
        summary.phase = 'error'; summary.message = error.message
        return { summary, environment: {}, args: [] }
      }
    }
    summary.message = '未检测到 NVM，继续使用原有启动方式。'
    try {
      const project = resolveProject(request)
      const required = requirements(project)
      Object.assign(summary, { projectPath: project.root, nodeRequirement: required.node,
        manager: required.manager, managerRequirement: required.managerRange, managerSource: required.managerSource })
    } catch {
      // A custom legacy launcher remains usable even when its project metadata cannot be inspected.
      summary.message += '无法读取此启动器的版本声明。'
    }
    // A custom launcher may pin its own Node; PATH is not proof of its runtime.
    summary.nodeSource = '由原启动器决定'
    return { summary, environment: {}, args: [] }
  }
  try {
    const project = resolveProject(request)
    const required = requirements(project)
    Object.assign(summary, { projectPath: project.root, nodeRequirement: required.node,
      nodeSource: required.nodeSource, manager: required.manager, managerRequirement: required.managerRange,
      managerSource: required.managerSource })
    if (!semver.validRange(required.nodeEngine)) throw new Error('engines.node 声明无效。')
    const selected = nvm.versions.find(item => matchesNode(item.version, required.node) && semver.satisfies(item.version, required.nodeEngine))
    if (!selected) throw new Error(`NVM 未安装匹配 Node ${required.node}（engines: ${required.nodeEngine}）的版本；请先通过 nvm install 安装。`)
    const actualNode = run(selected.node, ['--version']).replace(/^v/, '')
    if (actualNode !== selected.version) throw new Error('NVM 目录与 Node 实际版本不一致。')
    Object.assign(summary, { nodePath: selected.node, nodeVersion: actualNode })
    const bundledNpm = path.join(path.dirname(selected.node), 'node_modules/npm')
    if (!exists(path.join(bundledNpm, 'bin/npm-cli.js'))) throw new Error('所选 Node 缺少内置 npm，无法准备工具链。')
    const key = crypto.createHash('sha256').update(project.root.toLowerCase()).digest('hex').slice(0, 16)
    const home = path.join(request.sandboxHome, key, `node-${actualNode}`)
    const cleanPath = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean).filter(dir => {
      const normalized = path.resolve(dir.replace(/^"|"$/g, '')).toLowerCase()
      return normalized !== path.resolve(env.NVM_SYMLINK || nvm.root).toLowerCase()
        && !nvm.versions.some(item => normalized === path.dirname(item.node).toLowerCase())
    })
    const environment = { ...project.env, NVM_SANDBOX: '1', NVM_SANDBOX_NODE: actualNode,
      NPM_CONFIG_PREFIX: path.join(home, 'global'), NPM_CONFIG_CACHE: path.join(home, 'cache/npm'),
      NPM_CONFIG_STORE_DIR: path.join(home, 'cache/pnpm'),
      COREPACK_HOME: path.join(home, 'corepack'), COREPACK_ENABLE_PROJECT_SPEC: '0',
      PNPM_HOME: path.join(home, 'global'), YARN_CACHE_FOLDER: path.join(home, 'cache/yarn'),
      YARN_GLOBAL_FOLDER: path.join(home, 'yarn'),
      PATH: [path.join(home, 'bin'), path.dirname(selected.node), path.join(home, 'global'), ...cleanPath].join(path.delimiter) }
    let managerRoot = '', version = ''
    const candidates = [path.join(path.dirname(selected.node), 'node_modules', required.manager)]
    const cache = path.join(home, 'managers')
    if (exists(cache)) for (const entry of fs.readdirSync(cache).sort(semverSort)) {
      if (semver.valid(entry) && semver.satisfies(entry, required.managerRange)) {
        candidates.unshift(path.join(cache, entry, 'node_modules', managerPackage(required.manager, entry)))
      }
    }
    for (const candidate of candidates) {
      const found = versionOf(path.join(candidate, 'package.json'))
      if (!semver.valid(found) || !semver.satisfies(found, required.managerRange)) continue
      const cli = cliPath(candidate, required.manager)
      const candidateEngine = json(path.join(candidate, 'package.json')).engines?.node
      if (candidateEngine && !semver.satisfies(actualNode, candidateEngine)) continue
      if (run(selected.node, [cli, '--version'], { env: { ...env, ...environment }, cwd: path.dirname(request.sandboxHome) }) !== found) continue
      managerRoot = candidate; version = found; break
    }
    summary.managerVersion = version
    summary.phase = version ? 'ready' : 'needs-manager'
    summary.message = version ? '工具链已就绪；仅作用于 DSH 子进程。' : '启动时将在 Launcher 独立缓存中准备所需包管理器。'
    return { summary, environment, args: project.args, required, home, bundledNpm, managerRoot }
  } catch (error) {
    summary.phase = 'error'; summary.message = error.message
    return { summary, environment: {}, args: [] }
  }
}
function semverSort(a, b) { return semver.valid(a) && semver.valid(b) ? semver.compare(a, b) : a.localeCompare(b) }

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value), 'utf8')
  fs.renameSync(temporary, file)
}

/** Prepare pinned manager shims without shell interpolation or writes to the DSH checkout. */
export function prepareToolchain(request) {
  const plan = inspectToolchain(request)
  const { summary } = plan
  const publish = () => writeJson(request.runtimePath, summary)
  publish()
  try {
    if (summary.phase === 'error') throw new Error(summary.message)
    if (summary.mode === 'system') return plan
    const { environment, required, home, bundledNpm } = plan
    const env = { ...process.env, ...environment }
    for (const directory of [home, environment.NPM_CONFIG_PREFIX, environment.NPM_CONFIG_CACHE, environment.COREPACK_HOME, path.join(home, 'bin')]) {
      fs.mkdirSync(directory, { recursive: true })
    }
    if (!plan.managerRoot) {
      summary.phase = 'preparing'; summary.message = '正在准备包管理器，首次下载可能需要一些时间。'; publish()
      let version = semver.valid(required.managerRange)
      const npmCli = path.join(bundledNpm, 'bin/npm-cli.js')
      if (!version) {
        const packageName = required.manager === 'yarn' && !semver.intersects(required.managerRange, '<2.0.0')
          ? '@yarnpkg/cli-dist' : required.manager
        const versions = JSON.parse(run(summary.nodePath, [npmCli, 'view', `${packageName}@${required.managerRange}`, 'version', '--json'], { env, cwd: home, timeout: 60000 }))
        version = semver.maxSatisfying(Array.isArray(versions) ? versions : [versions], required.managerRange)
      }
      if (!version) throw new Error('没有找到满足要求的包管理器版本。')
      const target = path.join(home, 'managers', version)
      const packageName = managerPackage(required.manager, version)
      run(summary.nodePath, [npmCli, 'install', '--prefix', target, '--no-save', '--no-package-lock', '--ignore-scripts',
        '--no-audit', '--no-fund', `${packageName}@${version}`], { env, cwd: home, timeout: 180000 })
      plan.managerRoot = path.join(target, 'node_modules', packageName)
      const manifest = json(path.join(plan.managerRoot, 'package.json'))
      if (manifest.version !== version || (manifest.engines?.node && !semver.satisfies(summary.nodeVersion, manifest.engines.node))) {
        throw new Error('下载的包管理器版本不符或不支持所选 Node。')
      }
      summary.managerVersion = run(summary.nodePath, [cliPath(plan.managerRoot, required.manager), '--version'], { env, cwd: home })
      if (summary.managerVersion !== version) throw new Error('包管理器实际版本与需求不符。')
    }
    const npmRoot = required.manager === 'npm' ? plan.managerRoot : bundledNpm
    const shims = { npm: path.join(npmRoot, 'bin/npm-cli.js'), npx: path.join(npmRoot, 'bin/npx-cli.js') }
    shims[required.manager] = cliPath(plan.managerRoot, required.manager)
    if (required.manager === 'pnpm') shims.pnpx = path.join(plan.managerRoot, 'bin/pnpx.cjs')
    if (required.manager === 'yarn') shims.yarnpkg = shims.yarn
    for (const [name, cli] of Object.entries(shims)) {
      if (!exists(cli)) continue
      // Paths are data in environment variables; cmd never sees an interpolated filesystem path.
      const variable = `NVM_SANDBOX_${name.toUpperCase()}_CLI`
      environment[variable] = cli
      fs.writeFileSync(path.join(home, 'bin', `${name}.cmd`), `@echo off\r\n"%NVM_SANDBOX_NODE_EXE%" "%${variable}%" %*\r\n`)
      fs.writeFileSync(path.join(home, 'bin', `${name}.ps1`), `& $env:NVM_SANDBOX_NODE_EXE $env:${variable} @args\r\nexit $LASTEXITCODE\r\n`)
    }
    environment.NVM_SANDBOX_NODE_EXE = summary.nodePath
    summary.phase = 'ready'; summary.message = '工具链已就绪；仅作用于 DSH 子进程。'; publish()
    return plan
  } catch (error) {
    summary.phase = 'error'; summary.message = error.message; publish()
    throw error
  }
}
