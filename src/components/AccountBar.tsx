import { useEffect, useState } from 'react'
import { playkit, accountsEnabled, loadSessions, type PlaykitUser, type PracticeSession } from '../playkitClient'

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
          <div className="account-actions">
            <button className="account-submit" type="submit" disabled={busy}>
              {busy ? '…' : mode === 'register' ? 'Create account' : 'Sign in'}
            </button>
            <button type="button" className="account-link" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
          <p className="account-note">Optional. Only practice numbers are stored — never video.</p>
        </form>
      )}
    </div>
  )
}
