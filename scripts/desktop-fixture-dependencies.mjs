/** Create an isolated dependency view for the official Desktop development project builder. */
import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

function linkPackages(source, destination) {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === '.pnpm' || (!entry.isDirectory() && !entry.isSymbolicLink())) continue
    const from = join(source, entry.name), to = join(destination, entry.name)
    if (entry.name.startsWith('@')) linkPackages(from, to)
    else if (!existsSync(to)) symlinkSync(realpathSync(from), to, process.platform === 'win32' ? 'junction' : 'dir')
  }
}

/**
 * Mirror packages without changing the source installation. A clean pnpm install
 * keeps root-direct packages out of the virtual hoist directory; Desktop's
 * disposable profile still needs those packages from the same built workspace.
 * @param dsh - the verified source checkout.
 * @param destination - a new fixture-owned node_modules directory.
 * @returns the complete dependency directory accepted by prepareDevelopmentProject.
 */
export function prepareDesktopDependencyView(dsh, destination) {
  const modules = join(dsh, 'node_modules')
  linkPackages(modules, destination)
  const hoisted = join(destination, '.pnpm/node_modules')
  linkPackages(join(modules, '.pnpm/node_modules'), hoisted)
  linkPackages(modules, hoisted)
  return hoisted
}
