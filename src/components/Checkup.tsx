import { useEffect, useRef, useState } from 'react'
import { T } from '../i18n'
import { compareAngles, BONES, HEAD, HEAD_LABEL, type PoseFeature } from '../pose/angles'
import { CHECK_STEPS } from '../pose/checkup'

const HOLD_MS = 3200
const SETTLE_MS = 1200

interface StepResult {
  id: string
  tests: string
  score: number
  focusErrors: { label: string; err: number }[]
  framing: string[]
  samples: number
}

interface Props {
  /** Reads the dancer's current pose, or null when nothing is detected. */
  read: () => { feature: PoseFeature; framing: string[] } | null
  onClose: () => void
}

const labelFor = (key: string) =>
  key === HEAD ? HEAD_LABEL : (BONES.find((b) => b.name === key)?.label ?? key)

/** Angle between two unit directions, in degrees. */
function errorFor(user: PoseFeature, target: PoseFeature, key: string): number | null {
  const a = user[key]
  const b = target[key]
  if (!a || !b) return null
  const d = a.x * b.x + a.y * b.y + a.z * b.z
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI
}

export default function Checkup({ read, onClose }: Props) {
  const [index, setIndex] = useState(0)
  const [phase, setPhase] = useState<'settle' | 'hold' | 'done'>('settle')
  const [results, setResults] = useState<StepResult[]>([])
  const [copied, setCopied] = useState(false)
  const bucket = useRef<{ scores: number[]; errs: Record<string, number[]>; framing: Set<string> }>({
    scores: [],
    errs: {},
    framing: new Set(),
  })

  const step = CHECK_STEPS[index]

  useEffect(() => {
    if (phase !== 'settle') return
    bucket.current = { scores: [], errs: {}, framing: new Set() }
    // A moment to get into position before anything is recorded.
    const settle = setTimeout(() => setPhase('hold'), SETTLE_MS)
    return () => clearTimeout(settle)
  }, [index, phase])

  useEffect(() => {
    if (phase !== 'hold') return
    const tick = setInterval(() => {
      const now = read()
      if (!now) return
      const cmp = compareAngles(now.feature, step.target, false)
      if (cmp.score != null) bucket.current.scores.push(cmp.score)
      for (const key of step.focus) {
        const e = errorFor(now.feature, step.target, key)
        if (e != null) (bucket.current.errs[key] ??= []).push(e)
      }
      for (const f of now.framing) bucket.current.framing.add(f)
    }, 60)

    const finish = setTimeout(() => {
      clearInterval(tick)
      const b = bucket.current
      const median = (xs: number[]) =>
        xs.length ? [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)] : NaN
      setResults((r) => [
        ...r,
        {
          id: step.id,
          tests: step.tests,
          score: Math.round(median(b.scores)),
          focusErrors: step.focus
            .map((k) => ({ label: labelFor(k), err: Math.round(median(b.errs[k] ?? [])) }))
            .filter((e) => Number.isFinite(e.err)),
          framing: [...b.framing],
          samples: b.scores.length,
        },
      ])
      if (index + 1 < CHECK_STEPS.length) {
        setIndex(index + 1)
        setPhase('settle')
      } else {
        setPhase('done')
      }
    }, HOLD_MS)

    return () => {
      clearInterval(tick)
      clearTimeout(finish)
    }
  }, [phase, index, read, step])

  const report = [
    'Dance Trainer accuracy check',
    ...results.map((r) => {
      const errs = r.focusErrors.map((e) => `${e.label} off by ${e.err}deg`).join(', ')
      const warn = r.framing.length ? ` | framing: ${r.framing.join('; ')}` : ''
      const thin = r.samples < 10 ? ` | only ${r.samples} samples` : ''
      return `${r.id}: score ${r.score} (${r.tests}) — ${errs || 'nothing measured'}${warn}${thin}`
    }),
  ].join('\n')

  if (phase === 'done') {
    return (
      <div className="checkup">
        <h3>{T('Accuracy check finished')}</h3>
        <ul className="checkup-results">
          {results.map((r) => (
            <li key={r.id}>
              <span className={`checkup-score ${r.score >= 80 ? 'good' : r.score >= 55 ? 'mid' : 'poor'}`}>
                {r.score}
              </span>
              <span className="checkup-detail">
                <b>{r.id}</b> — {r.tests}
                <br />
                {r.focusErrors.map((e) => `${e.label} ${e.err}°`).join(' · ') || '—'}
                {r.framing.length > 0 && <em> · {r.framing.join('; ')}</em>}
              </span>
            </li>
          ))}
        </ul>
        <p className="hint">{T('Copy this and send it over — it says which part is wrong, not just that something is.')}</p>
        <div className="checkup-actions">
          <button
            className="btn primary"
            onClick={() => {
              void navigator.clipboard?.writeText(report).then(() => setCopied(true))
            }}
          >
            {copied ? T('Copied') : T('Copy report')}
          </button>
          <button className="btn" onClick={onClose}>
            {T('Close')}
          </button>
        </div>
        <pre className="checkup-raw">{report}</pre>
      </div>
    )
  }

  return (
    <div className="checkup">
      <div className="checkup-step">
        {T('Step')} {index + 1} / {CHECK_STEPS.length}
      </div>
      <h3>{T(step.instruction)}</h3>
      <p className="hint">{phase === 'settle' ? T('Get into position…') : T('Hold it')}</p>
      <div className={`checkup-bar ${phase === 'hold' ? 'running' : ''}`} />
      <button className="btn subtle" onClick={onClose}>
        {T('Stop check')}
      </button>
    </div>
  )
}
