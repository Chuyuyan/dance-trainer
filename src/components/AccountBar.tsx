import { T, L } from '../i18n'
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

const DISMISS_KEY = 'dance_account_prompt_dismissed'

const wasDismissed = () => {
  try { return localStorage.getItem(DISMISS_KEY) === '1' } catch { return true }
}
const rememberDismissed = () => {
  try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* private mode */ }
}

/**
 * Accounts UI: a one-time dialog offering sign-in, and a summary chip after.
 *
 * The dialog is an offer, never a gate — it always includes "keep practising
 * without an account" and does not return once dismissed. A link tucked in the
 * header went unnoticed; a dialog that nags would be worse.
 */
export default function AccountBar() {
  const [user, setUser] = useState<PlaykitUser | null>(null)
  const [sessions, setSessions] = useState<PracticeSession[]>([])
  const [open, setOpen] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!accountsEnabled) return
    playkit!
      .restore()
      .then(async (u) => {
        setUser(u)
        setReady(true)
        if (u) setSessions(await loadSessions())
        else if (!wasDismissed()) setOpen(true)
      })
      .catch(() => setReady(true))
  }, [])

  if (!accountsEnabled) return null

  const signOut = async () => {
    await playkit!.logout()
    setUser(null)
    setSessions([])
  }

  const onSignedIn = async (u: PlaykitUser) => {
    setUser(u)
    setSessions(await loadSessions())
    rememberDismissed()
    setOpen(false)
  }

  const best = sessions.length ? Math.max(...sessions.map((s) => s.bestMatch)) : null
  const totalMinutes = Math.round(sessions.reduce((a, s) => a + s.seconds, 0) / 60)

  return (
    <>
      <div className="account-bar">
        {user ? (
          <>
            <span className="account-stats">
              {sessions.length > 0
                ? L(`${sessions.length} session${sessions.length > 1 ? 's' : ''} · ${totalMinutes} min · best ${best}`, `${sessions.length} 次练习 · ${totalMinutes} 分钟 · 最佳 ${best}`)
                : T('No practice recorded yet')}
            </span>
            <span className="account-who">{user.displayName}</span>
            <button className="account-link" onClick={signOut}>{T('Sign out')}</button>
          </>
        ) : (
          ready && (
            <button className="account-link" onClick={() => setOpen(true)}>{T('Sign in')}</button>
          )
        )}
      </div>

      {open && !user && (
        <AccountDialog
          onSignedIn={onSignedIn}
          onClose={() => { rememberDismissed(); setOpen(false) }}
        />
      )}
    </>
  )
}

function AccountDialog({
  onSignedIn,
  onClose,
}: {
  onSignedIn: (u: PlaykitUser) => void
  onClose: () => void
}) {
  const [mode, setMode] = useState<'register' | 'login' | 'forgot'>('register')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [googleReady, setGoogleReady] = useState(false)
  const googleSlot = useRef<HTMLDivElement>(null)
  const firstField = useRef<HTMLInputElement>(null)

  useEffect(() => { firstField.current?.focus() }, [mode])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (mode === 'forgot' || !googleClientId || !googleSlot.current || googleReady) return
    let cancelled = false
    mountGoogleButton(playkit!, {
      clientId: googleClientId,
      container: googleSlot.current,
      onSignedIn: (u) => void onSignedIn(u),
      onError: () => setError(T('Google sign-in failed. Try email instead.')),
      width: 260,
    }).then((ok) => { if (!cancelled) setGoogleReady(ok) })
    return () => { cancelled = true }
  }, [googleReady, mode, onSignedIn])

  const switchMode = (next: typeof mode) => {
    setMode(next)
    setError('')
    setNotice('')
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (mode === 'forgot') {
        await playkit!.requestPasswordReset(email)
        // Worded the same either way — the server does not reveal whether the
        // address has an account, and nor should this.
        setNotice(T('If that address has an account, a reset link is on its way.'))
        return
      }
      const u =
        mode === 'register'
          ? await playkit!.register(email, password)
          : await playkit!.login(email, password)
      onSignedIn(u)
    } catch (err) {
      setError((err as Error)?.message || T('Something went wrong. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="acct-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="acct-dialog" role="dialog" aria-modal="true" aria-label="Keep your practice history">
        <h2 className="acct-title">
          {T(mode === 'forgot' ? 'Reset your password' : 'Keep your practice history')}
        </h2>
        <p className="acct-sub">
          {mode === 'forgot'
            ? "Enter the email you signed up with and we'll send a link to set a new password."
            : 'An account remembers your dances and how you are improving, on any device. Your video never leaves this machine.'}
        </p>

        {mode !== 'forgot' && (
          <>
            <div ref={googleSlot} className="acct-google" />
            {googleReady && <div className="acct-or"><span>or</span></div>}
          </>
        )}

        <form className="acct-form" onSubmit={submit}>
          <input
            ref={firstField}
            className="acct-input"
            type="email"
            placeholder={T('Email')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
          {mode !== 'forgot' && (
            <input
              className="acct-input"
              type="password"
              placeholder={T('Password')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              required
            />
          )}

          {error && <p className="acct-error">{error}</p>}
          {notice && <p className="acct-notice">{notice}</p>}

          <button className="acct-primary" type="submit" disabled={busy || Boolean(notice)}>
            {busy
              ? '…'
              : mode === 'register'
                ? T('Create account')
                : mode === 'forgot'
                  ? T('Send reset link')
                  : T('Sign in')}
          </button>
        </form>

        {mode === 'login' && (
          <p className="acct-switch">
            <button type="button" className="acct-link" onClick={() => switchMode('forgot')}>
              Forgot your password?
            </button>
          </p>
        )}

        <p className="acct-switch">
          {mode === 'register' && T('Already have an account? ')}
          {mode === 'login' && T('New here? ')}
          <button
            type="button"
            className="acct-link"
            onClick={() => switchMode(mode === 'register' ? 'login' : mode === 'forgot' ? 'login' : 'register')}
          >
            {T(mode === 'register' ? 'Sign in' : mode === 'forgot' ? 'Back to sign in' : 'Create one')}
          </button>
        </p>

        <button type="button" className="acct-skip" onClick={onClose}>
          Keep practising without an account
        </button>
      </div>
    </div>
  )
}
