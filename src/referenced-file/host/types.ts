/** One safe, content-free file candidate returned to the browser. */
export interface ReferencedFileCandidate {
  /** Workspace-relative path with forward slashes. */
  path: string
  /** File size when the filesystem backend supplied it cheaply. */
  size?: number
}

/** Browser request for workspace file candidates. */
export interface ListReferencedFilesRequest {
  /** Live DSH session whose immutable cwd defines the workspace root. */
  sessionId: string
  /** Text after the active # marker. */
  query: string
}

/** Browser response containing no file bytes. */
export interface ListReferencedFilesResponse {
  candidates: ReferencedFileCandidate[]
  /** True when the configured scan budget stopped traversal. */
  truncated: boolean
}

/** A # marker parsed from direct user text. */
export interface ParsedFileReference {
  path: string
  /** Explicit `#<...>` markers fail loudly; bare hashtags only bind existing files. */
  explicit: boolean
}

/** One validated text file ready for model-context rendering. */
export interface LoadedReferencedFile {
  path: string
  bytes: number
  text: string
}
