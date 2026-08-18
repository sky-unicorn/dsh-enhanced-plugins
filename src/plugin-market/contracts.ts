/** One installable repository discovered from the configured GitHub topic. */
export interface MarketPlugin {
  readonly fullName: string
  readonly packageName: string
  readonly description: string
  readonly url: string
  readonly ownerAvatarUrl: string
  readonly stars: number
  readonly updatedAt: string
  readonly topics: readonly string[]
  readonly installed: boolean
  readonly installedSpec?: string
}

/** Catalog subset selected by the browser before Host-side pagination. */
export type MarketCatalogFilter = 'all' | 'installed'

/** Marketplace snapshot returned to the browser. */
export interface MarketCatalog {
  readonly plugins: readonly MarketPlugin[]
  readonly fetchedAt: string
  readonly rateLimitRemaining: number | null
  readonly profile: string
  readonly page: number
  readonly pageSize: number
  readonly total: number
  readonly totalPages: number
}

/** Result of replacing the local channel JSON from GitHub. */
export interface MarketSyncResult {
  readonly total: number
  readonly syncedAt: string
  readonly rateLimitRemaining: number | null
}

/** Observable state of the one background channel synchronization. */
export type MarketSyncStatus =
  | { readonly state: 'idle' }
  | {
    readonly state: 'running'
    readonly startedAt: string
    readonly requests: number
    readonly discovered: number
    readonly checked: number
    readonly verified: number
  }
  | { readonly state: 'completed'; readonly result: MarketSyncResult }
  | { readonly state: 'failed'; readonly message: string }

/** Completed package-manager operation. */
export interface MarketMutationResult {
  readonly packageName: string
  readonly source?: 'npm' | 'github'
  readonly restartRequired: true
  readonly message: string
}

export interface MarketErrorBody {
  readonly error: { readonly code: string; readonly message: string }
}

/** UI-safe GitHub credential state; the secret value is never returned. */
export interface MarketCredentialInfo {
  readonly ref: string
  readonly configured: boolean
  readonly source?: string
  readonly writable: boolean
}
