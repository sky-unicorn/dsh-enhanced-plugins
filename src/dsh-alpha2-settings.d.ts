/**
 * Source-checkout declaration bridge for the DSH alpha.2 Settings API.
 *
 * The sibling checkout's generated `lib/types` may still describe alpha.1
 * while its source and published alpha.2 package expose literal namespace
 * inputs and `SettingsProvider.installSection()`. Keep local typechecks on the
 * verified source ABI without generating files inside the read-only sibling.
 */

import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import type {
  SettingsNamespace,
  SettingsPathOp,
  SettingsRegisterOptions,
  SettingsScope,
  SettingsSectionHooks,
} from '@deepseek-ai/dsh-settings'

type LowercaseLetter = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm'
  | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z'
type DecimalDigit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
type NamespaceCharacter = LowercaseLetter | DecimalDigit | '-'
type ValidNamespaceTail<Value extends string> = Value extends ''
  ? true
  : Value extends `${NamespaceCharacter}${infer Rest}`
    ? ValidNamespaceTail<Rest>
    : false
type SettingsNamespaceInput<Value extends string> = Value extends SettingsNamespace
  ? Value
  : string extends Value
    ? string
    : Value extends `${LowercaseLetter}${infer Rest}`
      ? ValidNamespaceTail<Rest> extends true ? Value : never
      : never

declare module '@deepseek-ai/dsh-settings' {
  interface SettingsProvider {
    register<const Namespace extends string, T>(
      ns: Namespace & SettingsNamespaceInput<Namespace>,
      schema: z<T>,
      options?: SettingsRegisterOptions<T>,
    ): SettingsScope<T>
    installSection<const Namespace extends string, T>(
      owner: Context,
      ns: Namespace & SettingsNamespaceInput<Namespace>,
      schema: z<T>,
      entry: T,
      hooks: SettingsSectionHooks<T>,
    ): void
    get<const Namespace extends string>(ns: Namespace & SettingsNamespaceInput<Namespace>): unknown
    update<const Namespace extends string>(
      ns: Namespace & SettingsNamespaceInput<Namespace>,
      patch: object,
      expectedRevision?: number,
    ): Promise<void>
    replace<const Namespace extends string>(
      ns: Namespace & SettingsNamespaceInput<Namespace>,
      section: object,
      expectedRevision?: number,
    ): Promise<void>
    mutate<const Namespace extends string>(
      ns: Namespace & SettingsNamespaceInput<Namespace>,
      ops: readonly SettingsPathOp[],
      expectedRevision?: number,
    ): Promise<void>
  }
}
