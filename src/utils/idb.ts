import type { ParsedManifest } from '@/types'
import { openDB } from 'idb'

const DB_NAME = 'hoyo-files-cache'
const DB_VERSION = 1
const STORE_NAME = 'manifests'
const MAX_SIZE = 500 * 1024 * 1024 // 500MB

interface ManifestRecord {
  key: string
  data: ParsedManifest
  size: number
  timestamp: number
}

let dbPromise: ReturnType<typeof openDB<{ manifests: { key: string, value: ManifestRecord } }>> | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<{ manifests: { key: string, value: ManifestRecord } }>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' })
        }
      },
    })
  }
  return dbPromise
}

export async function getManifest(key: string): Promise<ParsedManifest | null> {
  try {
    const db = await getDB()
    const record = await db.get(STORE_NAME, key)
    return record?.data ?? null
  }
  catch {
    return null
  }
}

export async function setManifest(key: string, data: ParsedManifest, size: number): Promise<void> {
  try {
    const db = await getDB()
    await evictIfNeeded(db, size)
    const record: ManifestRecord = { key, data, size, timestamp: Date.now() }
    await db.put(STORE_NAME, record)
  }
  catch { }
}

async function evictIfNeeded(db: Awaited<ReturnType<typeof getDB>>, incoming: number) {
  const all = await db.getAll(STORE_NAME)
  let total = all.reduce((s, r) => s + r.size, 0)
  if (total + incoming <= MAX_SIZE)
    return

  all.sort((a, b) => a.timestamp - b.timestamp)
  for (const record of all) {
    if (total + incoming <= MAX_SIZE)
      break
    await db.delete(STORE_NAME, record.key)
    total -= record.size
  }
}

export interface CacheStats {
  available: true
  totalSize: number
  count: number
}

export interface CacheUnavailable {
  available: false
}

export async function getCacheStats(): Promise<CacheStats | CacheUnavailable> {
  try {
    const db = await getDB()
    const all = await db.getAll(STORE_NAME)
    return {
      available: true,
      totalSize: all.reduce((s, r) => s + r.size, 0),
      count: all.length,
    }
  }
  catch {
    return { available: false }
  }
}

export async function clearCache(): Promise<void> {
  const db = await getDB()
  await db.clear(STORE_NAME)
}
