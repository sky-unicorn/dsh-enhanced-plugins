export function isReplacementSurfaceEvent(event: { surfaceOp?: unknown }): boolean {
  return event.surfaceOp !== undefined && event.surfaceOp !== 'append'
}
