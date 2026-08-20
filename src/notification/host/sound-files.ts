/** Profile-local storage for browser-selected custom WAV notification sounds. */

import type { Context } from '@deepseek-ai/cordis'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'

export const MAX_CUSTOM_SOUND_BYTES = 2 * 1024 * 1024
const FILE_ID = /^(?:sound|completion|confirmation)-[0-9a-f-]{36}\.wav$/

export function profileSoundRoot(ctx: Context): string | undefined {
  const documentPath = ctx.get('settings')?.documentPath
  return documentPath === undefined
    ? undefined
    : resolve(dirname(documentPath), 'desktop-notifications', 'sounds')
}

export function isCustomSoundFileId(value: string): boolean {
  return FILE_ID.test(value)
}

/** Resolve one owner-generated id without allowing it to escape the profile sound directory. */
export function customSoundPath(ctx: Context, fileId: string): string | undefined {
  const root = profileSoundRoot(ctx)
  if (root === undefined || !FILE_ID.test(fileId)) return undefined
  const target = resolve(root, fileId)
  return target.startsWith(`${root}${sep}`) ? target : undefined
}

function decodeWav(dataBase64: string): Buffer {
  if (dataBase64.length === 0 || dataBase64.length > Math.ceil(MAX_CUSTOM_SOUND_BYTES / 3) * 4 + 16
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) {
    throw new TypeError('notificationConfig/upload: invalid or oversized base64 payload')
  }
  const data = Buffer.from(dataBase64, 'base64')
  if (data.byteLength < 12 || data.byteLength > MAX_CUSTOM_SOUND_BYTES
    || data.toString('ascii', 0, 4) !== 'RIFF'
    || data.toString('ascii', 8, 12) !== 'WAVE') {
    throw new TypeError('notificationConfig/upload: only RIFF/WAVE files up to 2 MiB are supported')
  }
  return data
}

export function soundDisplayName(fileName: string): string {
  const name = basename(fileName).replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (name.length === 0 || name.length > 120 || !name.toLowerCase().endsWith('.wav')) {
    throw new TypeError('notificationConfig/upload: fileName must be a WAV name of at most 120 characters')
  }
  return name
}

/** Validate and persist one WAV under an opaque owner-generated id. */
export async function saveCustomSound(
  ctx: Context,
  fileName: string,
  dataBase64: string,
): Promise<{ fileId: string; name: string }> {
  const root = profileSoundRoot(ctx)
  if (root === undefined) {
    throw new Error('notificationConfig/upload: the settings provider has no profile document path')
  }
  const data = decodeWav(dataBase64)
  const name = soundDisplayName(fileName)
  const fileId = `sound-${randomUUID()}.wav`
  const target = customSoundPath(ctx, fileId)
  if (target === undefined) throw new Error('notificationConfig/upload: failed to resolve the owner-generated file id')
  await mkdir(root, { recursive: true })
  await writeFile(target, data, { flag: 'wx', mode: 0o600 })
  return { fileId, name }
}

/** Best-effort cleanup limited to an owner-generated file id. */
export async function removeCustomSound(ctx: Context, fileId: string): Promise<void> {
  const target = customSoundPath(ctx, fileId)
  if (target === undefined) return
  await unlink(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
}
