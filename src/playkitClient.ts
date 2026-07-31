import { createPlaykit, type PlaykitUser } from './lib/playkit'

/**
 * Optional accounts. With VITE_PLAYKIT_URL unset the trainer is entirely local:
 * no sign-in UI, no network calls, and — as before — no video or webcam frame
 * ever leaves the machine. That property is unchanged by this file; only
 * aggregate practice numbers are ever sent, and only for signed-in players.
 */
const baseUrl = import.meta.env.VITE_PLAYKIT_URL ?? ''

export const accountsEnabled = Boolean(baseUrl)

export const playkit = accountsEnabled
  ? createPlaykit({ baseUrl, gameId: 'dance-trainer' })
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
}

export interface PracticeSave {
  sessions: PracticeSession[]
}

/**
 * Appends a session to the player's cloud history.
 *
 * Deliberately no leaderboard: everyone practises a different video, so
 * comparing your match score against someone else's tells you nothing. The
 * value of an account here is your own history, across devices.
 */
export async function recordSession(session: PracticeSession): Promise<void> {
  if (!playkit || !playkit.isSignedIn) return
  try {
    const existing = await playkit.loadProgress<PracticeSave>()
    const sessions = existing?.data?.sessions ?? []
    await playkit.saveProgress(
      { sessions: [...sessions, session].slice(-100) },
      existing?.version,
    )
  } catch {
    // Practice data is a bonus; never let a failed sync surface mid-session.
  }
}

export async function loadSessions(): Promise<PracticeSession[]> {
  if (!playkit || !playkit.isSignedIn) return []
  try {
    const existing = await playkit.loadProgress<PracticeSave>()
    return existing?.data?.sessions ?? []
  } catch {
    return []
  }
}
