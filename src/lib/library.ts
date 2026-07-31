/**
 * The dance library: every video you open is remembered so you can pick it
 * back up in one click.
 *
 * The video files themselves never leave the machine — they go into IndexedDB,
 * not to any server. That is the same promise the rest of the app makes, and
 * it is why the library is device-local by default: an account can sync what
 * you practised and for how long, but not the footage.
 */

const DB_NAME = 'dance-trainer'
const DB_VERSION = 1
const META_STORE = 'library'
const BLOB_STORE = 'videos'

/** Above this a single file is indexed but not kept; re-pick it to reload. */
const MAX_STORED_BYTES = 300 * 1024 * 1024

/** Total footage to keep. Older entries lose their file, never their record. */
const STORAGE_BUDGET = 1_500 * 1024 * 1024

/** How many videos keep their file at once, regardless of size. */
const MAX_STORED_VIDEOS = 12

export interface LibraryEntry {
  id: string
  name: string
  size: number
  lastModified: number
  /** Seconds; 0 when the metadata could not be read. */
  duration: number
  addedAt: number
  lastOpenedAt: number
  openCount: number
  /** Small JPEG data URL. */
  thumb?: string
  /** Whether the file itself is still on this device. */
  hasVideo: boolean
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      // Metadata and footage are separate stores so listing the library never
      // has to pull hundreds of megabytes of video off disk.
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = run(t.objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

/**
 * Identifies a file without reading it. Hashing the contents would be more
 * precise but means streaming the whole video; name + size + mtime is enough
 * to recognise the same file being opened again.
 */
export async function fingerprint(file: File): Promise<string> {
  const key = `${file.name}:${file.size}:${file.lastModified}`
  if (!crypto?.subtle) return btoa(unescape(encodeURIComponent(key))).slice(0, 24)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  return Array.from(new Uint8Array(digest).slice(0, 10))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Duration plus a poster frame, read straight from the file. */
function probe(file: File): Promise<{ duration: number; thumb?: string }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const v = document.createElement('video')
    let settled = false
    const done = (out: { duration: number; thumb?: string }) => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      v.removeAttribute('src')
      resolve(out)
    }
    // Never hang the import on a file the browser cannot decode.
    const timer = setTimeout(() => done({ duration: 0 }), 5000)
    v.preload = 'metadata'
    v.muted = true
    v.playsInline = true
    v.onloadedmetadata = () => {
      const duration = Number.isFinite(v.duration) ? v.duration : 0
      // A frame slightly in, since the first frame is often black.
      v.currentTime = Math.min(duration > 0 ? duration * 0.15 : 0.5, 3)
    }
    v.onseeked = () => {
      clearTimeout(timer)
      const duration = Number.isFinite(v.duration) ? v.duration : 0
      try {
        const w = 240
        const h = Math.max(1, Math.round((v.videoHeight / v.videoWidth) * w)) || 135
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        c.getContext('2d')!.drawImage(v, 0, 0, w, h)
        done({ duration, thumb: c.toDataURL('image/jpeg', 0.7) })
      } catch {
        done({ duration })
      }
    }
    v.onerror = () => {
      clearTimeout(timer)
      done({ duration: 0 })
    }
    v.src = url
  })
}

export async function listLibrary(): Promise<LibraryEntry[]> {
  try {
    const all = await tx<LibraryEntry[]>(META_STORE, 'readonly', (s) => s.getAll())
    return all.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
  } catch {
    return []
  }
}

async function putMeta(entry: LibraryEntry): Promise<void> {
  await tx(META_STORE, 'readwrite', (s) => s.put(entry))
}

/**
 * Drops footage for the least recently opened entries until we are back inside
 * budget. Their records stay, so the library still shows what you have danced.
 */
async function evict(keepId: string): Promise<void> {
  const all = await listLibrary()
  const stored = all.filter((e) => e.hasVideo)
  let bytes = stored.reduce((a, e) => a + e.size, 0)
  let count = stored.length
  // Oldest first, and never the video that was just opened.
  for (const entry of [...stored].reverse()) {
    if (bytes <= STORAGE_BUDGET && count <= MAX_STORED_VIDEOS) break
    if (entry.id === keepId) continue
    try {
      await tx(BLOB_STORE, 'readwrite', (s) => s.delete(entry.id))
      await putMeta({ ...entry, hasVideo: false })
      bytes -= entry.size
      count--
    } catch {
      break
    }
  }
}

/**
 * Records a video in the library, keeping the file itself when it is small
 * enough to be worth the disk. Returns the entry, or null if IndexedDB is
 * unavailable — the app still works, it just will not remember.
 */
export async function remember(file: File): Promise<LibraryEntry | null> {
  try {
    const id = await fingerprint(file)
    const existing = await tx<LibraryEntry | undefined>(META_STORE, 'readonly', (s) => s.get(id))
    const now = Date.now()

    if (existing) {
      const entry: LibraryEntry = {
        ...existing,
        lastOpenedAt: now,
        openCount: existing.openCount + 1,
      }
      // Re-picking a file we had dropped restores it.
      if (!entry.hasVideo && file.size <= MAX_STORED_BYTES) {
        try {
          await tx(BLOB_STORE, 'readwrite', (s) => s.put(file, id))
          entry.hasVideo = true
        } catch {
          /* still fine without the file */
        }
      }
      await putMeta(entry)
      await evict(id)
      return entry
    }

    const { duration, thumb } = await probe(file)
    const entry: LibraryEntry = {
      id,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      duration,
      addedAt: now,
      lastOpenedAt: now,
      openCount: 1,
      thumb,
      hasVideo: false,
    }
    if (file.size <= MAX_STORED_BYTES) {
      try {
        await tx(BLOB_STORE, 'readwrite', (s) => s.put(file, id))
        entry.hasVideo = true
      } catch {
        // Out of quota, or the browser refused. Keep the record anyway.
      }
    }
    await putMeta(entry)
    await evict(id)
    return entry
  } catch {
    return null
  }
}

/** Bumps an entry's recency without needing the file in hand. */
export async function touch(id: string): Promise<void> {
  try {
    const existing = await tx<LibraryEntry | undefined>(META_STORE, 'readonly', (s) => s.get(id))
    if (!existing) return
    await putMeta({ ...existing, lastOpenedAt: Date.now(), openCount: existing.openCount + 1 })
  } catch {
    /* recency is cosmetic */
  }
}

/** The stored file for an entry, or null if it is no longer on this device. */
export async function getVideo(id: string): Promise<File | Blob | null> {
  try {
    return (await tx<File | Blob | undefined>(BLOB_STORE, 'readonly', (s) => s.get(id))) ?? null
  } catch {
    return null
  }
}

export async function forget(id: string): Promise<void> {
  try {
    await tx(BLOB_STORE, 'readwrite', (s) => s.delete(id))
    await tx(META_STORE, 'readwrite', (s) => s.delete(id))
  } catch {
    /* nothing to do */
  }
}

/** Merges cloud-known dances in as records without footage. */
export async function mergeRemote(
  remote: { id: string; name: string; duration?: number; lastOpenedAt?: number }[],
): Promise<void> {
  if (!remote.length) return
  try {
    const local = new Map((await listLibrary()).map((e) => [e.id, e]))
    for (const r of remote) {
      const existing = local.get(r.id)
      if (existing) {
        // Another device may have practised this more recently.
        if ((r.lastOpenedAt ?? 0) > existing.lastOpenedAt) {
          await putMeta({ ...existing, lastOpenedAt: r.lastOpenedAt! })
        }
        continue
      }
      await putMeta({
        id: r.id,
        name: r.name,
        size: 0,
        lastModified: 0,
        duration: r.duration ?? 0,
        addedAt: r.lastOpenedAt ?? Date.now(),
        lastOpenedAt: r.lastOpenedAt ?? Date.now(),
        openCount: 0,
        hasVideo: false,
      })
    }
  } catch {
    /* the local library is still fine */
  }
}

export function formatDuration(seconds: number): string {
  if (!seconds || !Number.isFinite(seconds)) return ''
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
