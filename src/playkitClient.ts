import { createPlaykit, type PlaykitUser } from './lib/playkit'

/**
 * Optional accounts. With VITE_PLAYKIT_URL unset the trainer is entirely local:
 * no sign-in UI, no network calls, and — as before — no video or webcam frame
 * ever leaves the machine. That property is unchanged by this file; only
 * aggregate practice numbers are ever sent, and only for signed-in players.
 */
const baseUrl = import.meta.env.VITE_PLAYKIT_URL ?? ''

export const accountsEnabled = Boolean(baseUrl)

type AuthListener = (user: PlaykitUser | null) => void
const authListeners = new Set<AuthListener>()

/** Lets the library refresh itself when someone signs in or out. */
export function onAuthChange(fn: AuthListener): () => void {
  authListeners.add(fn)
  return () => authListeners.delete(fn)
}

export const playkit = accountsEnabled
  ? createPlaykit({
      baseUrl,
      gameId: 'dance-trainer',
      onAuthChange: (user) => authListeners.forEach((fn) => fn(user)),
    })
  : null

/** Google OAuth client ID. Public by design — it ships inside the bundle. */
export const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ''

export type { PlaykitUser }

/** One finished practice session. */
export interface PracticeSession {
  at: string
  /** Seconds of camera-on practice. */
  seconds: number
  /** Mean match score across the session, 0–100. */
  averageMatch: number
  /** Best smoothed match reached, 0–100. */
  bestMatch: number
  /** Which dance this was, so the library can show per-video progress. */
  videoId?: string
  videoName?: string
}

/**
 * What the cloud knows about a dance: enough to list it and show progress on
 * another device, and deliberately nothing more. The file stays on the machine
 * that opened it.
 */
export interface LibraryMeta {
  id: string
  name: string
  duration?: number
  lastOpenedAt?: number
}

export interface PracticeSave {
  sessions: PracticeSession[]
  library?: LibraryMeta[]
}

/**
 * Read-modify-write against the single save blob. Everything that syncs goes
 * through here so two features can never race each other's version.
 */
async function updateSave(mutate: (save: PracticeSave) => PracticeSave): Promise<void> {
  if (!playkit || !playkit.isSignedIn) return
  try {
    const existing = await playkit.loadProgress<PracticeSave>()
    const current: PracticeSave = existing?.data ?? { sessions: [] }
    await playkit.saveProgress(mutate({ sessions: current.sessions ?? [], library: current.library }), existing?.version)
  } catch {
    // Practice data is a bonus; never let a failed sync surface mid-session.
  }
}

async function readSave(): Promise<PracticeSave | null> {
  if (!playkit || !playkit.isSignedIn) return null
  try {
    return (await playkit.loadProgress<PracticeSave>())?.data ?? null
  } catch {
    return null
  }
}

/**
 * Appends a session to the player's cloud history.
 *
 * Deliberately no leaderboard: everyone practises a different video, so
 * comparing your match score against someone else's tells you nothing. The
 * value of an account here is your own history, across devices.
 */
export async function recordSession(session: PracticeSession): Promise<void> {
  await updateSave((save) => ({
    ...save,
    sessions: [...save.sessions, session].slice(-200),
  }))
}

export async function loadSessions(): Promise<PracticeSession[]> {
  return (await readSave())?.sessions ?? []
}

/** Publishes the local library's index — names and timings, never footage. */
export async function syncLibrary(entries: LibraryMeta[]): Promise<void> {
  if (!entries.length) return
  await updateSave((save) => {
    const merged = new Map((save.library ?? []).map((e) => [e.id, e]))
    for (const entry of entries) {
      const prev = merged.get(entry.id)
      merged.set(entry.id, {
        ...entry,
        lastOpenedAt: Math.max(entry.lastOpenedAt ?? 0, prev?.lastOpenedAt ?? 0),
      })
    }
    return {
      ...save,
      library: [...merged.values()]
        .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
        .slice(0, 100),
    }
  })
}

export async function loadLibraryIndex(): Promise<LibraryMeta[]> {
  return (await readSave())?.library ?? []
}

export interface VideoStats {
  seconds: number
  bestMatch: number
  sessions: number
}

/** Practice totals per dance, for the library list. */
export function statsByVideo(sessions: PracticeSession[]): Map<string, VideoStats> {
  const out = new Map<string, VideoStats>()
  for (const s of sessions) {
    if (!s.videoId) continue
    const cur = out.get(s.videoId) ?? { seconds: 0, bestMatch: 0, sessions: 0 }
    out.set(s.videoId, {
      seconds: cur.seconds + s.seconds,
      bestMatch: Math.max(cur.bestMatch, s.bestMatch),
      sessions: cur.sessions + 1,
    })
  }
  return out
}
