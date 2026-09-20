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
  /** Repository source passed unchanged to DSH's current-profile installer. */
  readonly installSpec: string
}

/** Marketplace snapshot returned to the browser. */
export interface MarketCatalog {
  readonly plugins: readonly MarketPlugin[]
  /** Time at which the remote indexer generated the active snapshot. */
  readonly fetchedAt: string
  /** True when the indexer has not published a new validated snapshot for 24 hours; optional for older Hosts. */
  readonly indexStale?: boolean
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
  readonly unchanged?: boolean
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

export interface MarketErrorBody {
  readonly error: { readonly code: string; readonly message: string }
}
