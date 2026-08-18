/**
 * Minimal stub of the typert-protocol imports the tested host modules
 * evaluate: the `Remote` method decorator (a no-op here) and the
 * `TypertRemoteService` base class (just stores the name).
 */

export function Remote(_exportName?: string): MethodDecorator {
  return () => {}
}

/** Service base class; the Remote decorator application needs a real class. */
export class TypertRemoteService {
  static inject: string[] = []
  constructor(
    readonly ctx: { settings: unknown },
    readonly remoteName: string,
  ) {}
}
