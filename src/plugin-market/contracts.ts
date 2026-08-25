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
  /** True only when the Host owns a marketplace install record and permits removal here. */
  readonly removable: boolean
  readonly installedSpec?: string
}

/** Host-verified way (or reason not) to install one catalog entry. */
export type MarketInstallPlan =
  | {
    readonly kind: 'npm'
    readonly packageName: string
    readonly version: string
    readonly integrity?: string
    readonly repository: string
  }
  | {
    readonly kind: 'github'
    readonly packageName: string
    readonly repository: string
    readonly commit: string
    readonly requiresConfirmation: true
  }
  | {
    readonly kind: 'manual'
    readonly packageName: string
    readonly repository: string
    readonly documentationUrl: string
    readonly reason: 'requires-build-approval' | 'missing-integrity' | 'no-automatic-source'
  }

interface MarketInstallPlanJobBase {
  readonly id: string
  readonly fullName: string
  readonly createdAt: string
}

/** Pollable live install preflight, so slow registries cannot hold one HTTP request open. */
export type MarketInstallPlanJob =
  | (MarketInstallPlanJobBase & { readonly state: 'running' })
  | (MarketInstallPlanJobBase & {
    readonly state: 'completed'
    readonly completedAt: string
    readonly plan: MarketInstallPlan
  })
  | (MarketInstallPlanJobBase & {
    readonly state: 'failed'
    readonly completedAt: string
    readonly message: string
  })

/** Catalog subset selected by the browser before Host-side pagination. */
export type MarketCatalogFilter = 'all' | 'installed'

/** Marketplace snapshot returned to the browser. */
export interface MarketCatalog {
  readonly plugins: readonly MarketPlugin[]
  /** Time at which the remote indexer generated the active snapshot. */
  readonly fetchedAt: string
  /** True when the indexer has not published a new validated snapshot for 24 hours; optional for older Hosts. */
  readonly indexStale?: boolean
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

/** Completed package-manager operation. */
export interface MarketMutationResult {
  readonly packageName: string
  readonly source?: 'npm' | 'github'
  readonly restartRequired: true
  readonly message: string
}

/** Progress phase for one background install or uninstall. */
export type MarketMutationPhase = 'queued' | 'preflight' | 'installing' | 'verifying' | 'rolling-back'

interface MarketMutationJobBase {
  readonly id: string
  readonly operation: 'install' | 'uninstall'
  readonly target: string
  readonly createdAt: string
}

/** Pollable background package-manager operation returned immediately with HTTP 202. */
export type MarketMutationJob =
  | (MarketMutationJobBase & {
    readonly state: 'running'
    readonly phase: MarketMutationPhase
    readonly cancellable: true
  })
  | (MarketMutationJobBase & {
    readonly state: 'completed'
    readonly completedAt: string
    readonly result: MarketMutationResult
  })
  | (MarketMutationJobBase & {
    readonly state: 'failed' | 'cancelled'
    readonly completedAt: string
    readonly message: string
  })

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
