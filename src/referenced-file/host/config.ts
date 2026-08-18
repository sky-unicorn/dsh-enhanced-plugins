import z from '@deepseek-ai/schemastery'

/** Host-owned limits for listing and injecting referenced workspace files. */
export interface Config {
  /** Maximum candidates returned to one browser query. */
  maxCandidates: number
  /** Maximum directory entries inspected by one browser query. */
  maxScannedEntries: number
  /** Maximum traversal depth below the workspace root. */
  maxDepth: number
  /** Maximum explicit references accepted in one prompt batch. */
  maxReferences: number
  /** Maximum UTF-8 bytes read from one referenced file. */
  maxFileBytes: number
  /** Maximum combined bytes read from one prompt batch. */
  maxTotalBytes: number
  /** Directory basenames omitted from candidate traversal. */
  excludeDirectories: string[]
  /** Milliseconds before a workspace candidate index refreshes in the background. */
  indexTtlMs: number
  /** Maximum workspace indexes retained by the Host. */
  maxCachedWorkspaces: number
}

/** Default directories whose generated/vendor contents should not flood the menu. */
export const DEFAULT_EXCLUDED_DIRECTORIES = [
  '.git', '.cache', '.next', '.turbo', 'build', 'coverage', 'dist', 'node_modules',
]

/** Cordis configuration schema; defaults are the sole deployment defaults. */
export const Config = z.object({
  maxCandidates: z.number().min(1).max(20).default(20),
  maxScannedEntries: z.number().min(1).max(100_000).default(5_000),
  maxDepth: z.number().min(0).max(64).default(12),
  maxReferences: z.number().min(1).max(32).default(8),
  maxFileBytes: z.number().min(1).max(10 * 1024 * 1024).default(128 * 1024),
  maxTotalBytes: z.number().min(1).max(20 * 1024 * 1024).default(512 * 1024),
  excludeDirectories: z.array(String).default(DEFAULT_EXCLUDED_DIRECTORIES),
  indexTtlMs: z.number().min(1_000).max(60 * 60 * 1_000).default(30_000),
  maxCachedWorkspaces: z.number().min(1).max(64).default(8),
}) as unknown as z<Config>
