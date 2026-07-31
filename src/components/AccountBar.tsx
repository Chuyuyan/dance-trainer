import { useEffect, useRef, useState } from 'react'
import { mountGoogleButton } from '../lib/playkit'
import {
  playkit,
  accountsEnabled,
  googleClientId,
  loadSessions,
  type PlaykitUser,
  type PracticeSession,
} from '../playkitClient'

/**
 * Sign-in plus a short practice history. Renders nothing at all when accounts
 * are not configured, so the default build is unchanged.
 */
export default function AccountBar() {
  const [user, setUser] = useState<PlaykitUser | null>(null)
  const [sessions, setSessions] = useState<PracticeSession[]>([])
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!accountsEnabled) return
    playkit!
      .restore()
      .then(async (u) => {
        setUser(u)
        if (u) setSessions(await loadSessions())
      })
      .catch(() => {})
  }, [])

  // Google draws its own button into a real node, so it mounts once the form
  // opens. If Google can't be reached the slot stays empty and email still works.
  const googleSlot = useRef<HTMLDivElement>(null)
  const [googleReady, setGoogleReady] = useState(false)

  useEffect(() => {
    if (!open || !googleClientId || !googleSlot.current || googleReady) return
    let cancelled = false
    mountGoogleButton(playkit!, {
      clientId: googleClientId,
      container: googleSlot.current,
      onSignedIn: async (u) => {
        setUser(u)
        setSessions(await loadSessions())
        setOpen(false)
      },
      onError: () => setError('Google sign-in failed. Try email instead.'),
      width: 218,
    }).then((ok) => { if (!cancelled) setGoogleReady(ok) })
    return () => { cancelled = true }
  }, [open, googleReady])

  if (!accountsEnabled) return null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const u =
        mode === 'register'
          ? await playkit!.register(email, password)
          : await playkit!.login(email, password)
      setUser(u)
      setSessions(await loadSessions())
      setOpen(false)
      setPassword('')
    } catch (err) {
      setError((err as Error)?.message || 'Sign-in failed.')
    } finally {
      setBusy(false)
    }
  }

  const signOut = async () => {
    await playkit!.logout()
    setUser(null)
    setSessions([])
  }

  const best = sessions.length ? Math.max(...sessions.map((s) => s.bestMatch)) : null
  const totalMinutes = Math.round(sessions.reduce((a, s) => a + s.seconds, 0) / 60)

  if (user) {
    return (
      <div className="account-bar">
        <span className="account-stats">
          {sessions.length > 0
            ? `${sessions.length} session${sessions.length > 1 ? 's' : ''} · ${totalMinutes} min · best ${best}`
            : 'No practice recorded yet'}
        </span>
        <span className="account-who">{user.displayName}</span>
        <button className="account-link" onClick={signOut}>
          Sign out
        </button>
      </div>
    )
  }

  return (
    <div className="account-bar">
      {!open ? (
        <button className="account-link" onClick={() => setOpen(true)}>
          Sign in to keep your practice history
        </button>
      ) : (
        <form className="account-form" onSubmit={submit}>
          <div className="account-tabs">
            <button
              type="button"
              className={mode === 'login' ? 'account-tab is-on' : 'account-tab'}
              onClick={() => setMode('login')}
            >
              Sign in
            </button>
            <button
              type="button"
              className={mode === 'register' ? 'account-tab is-on' : 'account-tab'}
              onClick={() => setMode('register')}
            >
              Create
            </button>
          </div>

          <div ref={googleSlot} className="account-google" />
          {googleReady && <div className="account-or"><span>or</span></div>}
          <input
            className="account-input"
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
          <input
            className="account-input"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            required
          />
          {error && <p className="account-error">{error}</p>}
          {notice && <p className="account-notice">{notice}</p>}
          <div className="account-actions">
            <button className="account-submit" type="submit" disabled={busy}>
              {busy ? '…' : mode === 'register' ? 'Create account' : 'Sign in'}
            </button>
            <button type="button" className="account-link" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
          <button
            type="button"
            className="account-link"
            onClick={async () => {
              setError('')
              setNotice('')
              if (!email) { setError('Enter your email first.'); return }
              try {
                await playkit!.requestPasswordReset(email)
                // Worded the same either way: the server does not reveal
                // whether the address has an account, and nor should this.
                setNotice('If that address has an account, a reset link is on its way.')
              } catch (err) {
                setError((err as Error)?.message || 'Could not send a reset link.')
              }
            }}
          >
            Forgot your password?
          </button>
          <p className="account-note">Optional. Only practice numbers are stored — never video.</p>
        </form>
      )}
    </div>
  )
}
