// Tiny i18n with graceful fallback, ported from Investment Time Machine.
// T(s) looks the English string up in the zh dictionary; anything missing
// stays English — a gap can never break the UI. The chosen language is
// remembered; first visit follows the browser language.
import { useSyncExternalStore } from 'react'
import { ZH } from './i18n-zh'

const KEY = 'dt_lang'

let lang: 'en' | 'zh' = (() => {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'zh' || saved === 'en') return saved
    return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'en'
  }
})()

const listeners = new Set<() => void>()

export function getLang() {
  return lang
}

export function setLang(next: 'en' | 'zh') {
  lang = next
  try {
    localStorage.setItem(KEY, next)
  } catch {
    // private mode — the toggle still works for this visit
  }
  for (const fn of listeners) fn()
}

export function toggleLang() {
  setLang(lang === 'zh' ? 'en' : 'zh')
}

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Re-render the calling component whenever the language changes. */
export function useLangTick() {
  return useSyncExternalStore(subscribe, getLang)
}

/** Translate a dictionary string (falls back to the English original). */
export function T(s: string): string {
  if (lang !== 'zh' || s == null) return s
  return ZH[s] ?? s
}

/** Pick between two hand-written variants (for interpolated strings). */
export function L(en: string, zh: string) {
  return lang === 'zh' ? zh : en
}

/** The globe button — fixed corner, above every dialog. */
export function LangGlobe() {
  useLangTick()
  const label = lang === 'zh' ? 'Switch to English' : '切换到中文'
  return (
    <button className="lang-globe" onClick={toggleLang} aria-label={label} title={label}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <ellipse cx="12" cy="12" rx="4" ry="9" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M3.6 9h16.8 M3.6 15h16.8" stroke="currentColor" strokeWidth="1.3" fill="none" />
      </svg>
      <span>{lang === 'zh' ? 'EN' : '中'}</span>
    </button>
  )
}
