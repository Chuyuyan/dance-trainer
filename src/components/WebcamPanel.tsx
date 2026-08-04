import { T } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import type { PoseLandmarker } from '@mediapipe/tasks-vision'
import { createPoseLandmarker } from '../pose/landmarker'
import { drawSkeleton, LEVEL_COLORS } from '../pose/skeleton'
import { computeAngles, compareToHistory, levelConnectionColors, HEAD, type LagState, type PoseFeature } from '../pose/angles'
import { LandmarkSmoother } from '../pose/filter'
import { framingProblems } from '../pose/checkup'
import Checkup from './Checkup'

/** Whether to mirror the comparison; 'auto' follows the reference's facing. */
type MirrorMode = 'auto' | 'mirror' | 'direct'
import type { TargetPose } from './VideoPanel'
import { recordSession } from '../playkitClient'

/** Practice accumulated against one phrase during a single session. */
export interface SectionPractice {
  seconds: number
  sumMatch: number
  samples: number
  bestMatch: number
}

interface Props {
  targetRef: React.MutableRefObject<TargetPose>
  /** Which dance is loaded, so practice is filed against it in the library. */
  videoId?: string
  videoName?: string
  /** Called when the camera stops, with what was practised per phrase. */
  onSectionPractice?: (deltas: Record<string, SectionPractice>) => void
}

export default function WebcamPanel({
  targetRef,
  videoId,
  videoName,
  onSectionPractice,
}: Props) {
  // Per-phrase totals for this session, plus the clock used to charge time to
  // whichever phrase was on screen.
  const sectionAccumRef = useRef<Record<string, SectionPractice>>({})
  const sectionClockRef = useRef(0)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const landmarkerRef = useRef<PoseLandmarker | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const emaRef = useRef<number | null>(null)
  const lagRef = useRef<number | null>(null)
  // The lag estimate persists between frames so it can settle.
  const lagStateRef = useRef<LagState>({ lag: 0 })
  const smootherRef = useRef(new LandmarkSmoother())
  // Latest reading, so the guided check can sample without its own detector.
  const latestRef = useRef<{ feature: PoseFeature; framing: string[] } | null>(null)
  const lastUiRef = useRef(0)
  const mirrorModeRef = useRef<MirrorMode>('auto')

  // Aggregates for the practice session, so a signed-in dancer keeps a history
  // instead of a number that vanishes when the camera stops.
  const sessionRef = useRef({ startedAt: 0, sum: 0, count: 0, best: 0 })

  const [running, setRunning] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mirrorMode, setMirrorMode] = useState<MirrorMode>('auto')
  const [mirroredNow, setMirroredNow] = useState(true)
  const [score, setScore] = useState<number | null>(null)
  const [lag, setLag] = useState<number | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [framing, setFraming] = useState<string[]>([])
  const [checking, setChecking] = useState(false)

  mirrorModeRef.current = mirrorMode

  // Asking every session is friction for something already agreed to, so if
  // the permission is on record the camera comes up by itself. Browsers that
  // do not answer the query simply keep the button.
  useEffect(() => {
    let cancelled = false
    navigator.permissions
      ?.query({ name: 'camera' as PermissionName })
      .then((status) => {
        if (!cancelled && status.state === 'granted') void start()
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return () => {
      landmarkerRef.current?.close()
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  const start = async () => {
    setStarting(true)
    setError(null)
    try {
      landmarkerRef.current ??= await createPoseLandmarker(1)
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 960 }, height: { ideal: 540 }, facingMode: 'user' },
        audio: false,
      })
      streamRef.current = stream
      const v = videoRef.current!
      v.srcObject = stream
      await v.play()
      sessionRef.current = { startedAt: performance.now(), sum: 0, count: 0, best: 0 }
      setRunning(true)
    } catch (e) {
      console.error('webcam start failed', e)
      setError(
        e instanceof DOMException && e.name === 'NotAllowedError'
          ? T('Camera permission denied — allow it in your browser settings')
          : T('Could not start the camera'),
      )
    } finally {
      setStarting(false)
    }
  }

  const stop = () => {
    // Save before tearing down, while the aggregates are still intact.
    const s = sessionRef.current
    const seconds = s.startedAt ? Math.round((performance.now() - s.startedAt) / 1000) : 0
    // Ignore accidental blips — a two-second session is not practice.
    if (s.count > 0 && seconds >= 10) {
      void recordSession({
        at: new Date().toISOString(),
        seconds,
        averageMatch: Math.round(s.sum / s.count),
        bestMatch: Math.round(s.best),
        videoId,
        videoName,
      })
    }
    sessionRef.current = { startedAt: 0, sum: 0, count: 0, best: 0 }

    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    const perSection = sectionAccumRef.current
    if (Object.keys(perSection).length) onSectionPractice?.(perSection)
    sectionAccumRef.current = {}
    sectionClockRef.current = 0

    emaRef.current = null
    lagRef.current = null
    lagStateRef.current = { lag: 0 }
    smootherRef.current.reset()
    setRunning(false)
    setScore(null)
    setLag(null)
    setProblems([])
    const cv = canvasRef.current
    cv?.getContext('2d')?.clearRect(0, 0, cv.width, cv.height)
  }

  useEffect(() => {
    if (!running) return
    let raf = 0
    const loop = () => {
      raf = requestAnimationFrame(loop)
      const v = videoRef.current
      const cv = canvasRef.current
      const lmk = landmarkerRef.current
      if (!v || !cv || !lmk || v.readyState < 2 || v.videoWidth === 0) return

      const res = lmk.detectForVideo(v, performance.now())
      if (cv.width !== v.videoWidth || cv.height !== v.videoHeight) {
        cv.width = v.videoWidth
        cv.height = v.videoHeight
      }
      const ctx = cv.getContext('2d')!
      ctx.clearRect(0, 0, cv.width, cv.height)

      const raw = res.landmarks[0]
      const world = res.worldLandmarks[0]
      // Steady the landmarks before anything reads them, so a body holding
      // still produces a still skeleton and a steady score.
      const pose = raw ? smootherRef.current.filter(raw, performance.now() / 1000) : undefined
      const target = targetRef.current
      let frameScore: number | null = null
      let frameProblems: string[] = []
      let frameLag: number | null = null
      if (pose && world) {
        const user = computeAngles(world)
        const framingNow = framingProblems(pose)
        latestRef.current = { feature: user, framing: framingNow }
        // You always face your own camera, so mirroring is only right when the
        // reference dancer faces theirs.
        const mirrored =
          mirrorModeRef.current === 'auto'
            ? target.facing !== 'back'
            : mirrorModeRef.current === 'mirror'
        const cmp = compareToHistory(user, target.history, target.time, mirrored, lagStateRef.current)
        drawSkeleton(ctx, pose, cv.width, cv.height, {
          color: LEVEL_COLORS.na,
          lineWidth: 7,
          connectionColors: target.feature ? levelConnectionColors(cmp.levels, LEVEL_COLORS) : undefined,
          headColor: target.feature ? LEVEL_COLORS[cmp.levels[HEAD] ?? 'na'] : undefined,
        })
        frameScore = cmp.score
        frameProblems = cmp.problems
        frameLag = cmp.lag
      }

      // Charge elapsed time to the phrase that was playing, but only while a
      // score exists — standing off-camera between takes is not practice.
      const clockNow = performance.now()
      const elapsed = sectionClockRef.current ? (clockNow - sectionClockRef.current) / 1000 : 0
      sectionClockRef.current = clockNow
      const sid = target.sectionId
      if (sid && frameScore !== null && elapsed > 0 && elapsed < 1) {
        const acc = (sectionAccumRef.current[sid] ??= {
          seconds: 0,
          sumMatch: 0,
          samples: 0,
          bestMatch: 0,
        })
        acc.seconds += elapsed
        acc.sumMatch += frameScore
        acc.samples++
        if (frameScore > acc.bestMatch) acc.bestMatch = frameScore
      }

      if (frameScore !== null) {
        emaRef.current = emaRef.current === null ? frameScore : emaRef.current * 0.85 + frameScore * 0.15
        // Accumulate on the smoothed value: a single noisy frame shouldn't
        // become someone's "best match".
        const s = sessionRef.current
        s.sum += emaRef.current
        s.count++
        if (emaRef.current > s.best) s.best = emaRef.current
      } else {
        emaRef.current = null
      }
      // Lag is smoothed hard: it is a tendency worth naming, not a per-frame
      // number, and a twitchy readout would be unusable mid-dance.
      if (frameLag !== null) {
        lagRef.current = lagRef.current === null ? frameLag : lagRef.current * 0.9 + frameLag * 0.1
      }

      const now = performance.now()
      if (now - lastUiRef.current > 200) {
        lastUiRef.current = now
        setScore(emaRef.current === null ? null : Math.round(emaRef.current))
        setProblems(frameProblems)
        setLag(lagRef.current)
        setFraming(latestRef.current?.framing ?? [])
        setMirroredNow(
          mirrorModeRef.current === 'auto'
            ? targetRef.current.facing !== 'back'
            : mirrorModeRef.current === 'mirror',
        )
      }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [running, targetRef])

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{T('You')}</h2>
        <span className="hint">{T(running ? 'Comparing live' : 'Turn on your camera to follow along')}</span>
      </div>

      <div className="stage mirrored webcam-stage">
        <video ref={videoRef} playsInline muted />
        <canvas ref={canvasRef} />
        {!running && (
          <div className="stage-overlay">
            <button className="btn primary" onClick={start} disabled={starting}>
              {T(starting ? 'Starting…' : 'Turn on camera')}
            </button>
            {error && <p className="error">{error}</p>}
          </div>
        )}
        {running && framing.length > 0 && !checking && (
          <div className="framing-warning">
            {framing.map((f) => (
              <p key={f}>{T(f)}</p>
            ))}
          </div>
        )}
        {import.meta.env.DEV && running && checking && (
          <div className="stage-overlay checkup-overlay">
            <Checkup read={() => latestRef.current} onClose={() => setChecking(false)} />
          </div>
        )}
        {running && !checking && (
          <div className="score-badge">
            <span className="score-num">{score ?? '—'}</span>
            <span className="score-label">match</span>
            {lag !== null && (
              <span className="score-lag">
                {lag < 0.15 ? 'in time' : `${lag.toFixed(1)}s behind`}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="controls">
        <div className="ctrl-group">
          {running && (
            <button className="btn" onClick={stop}>
              {T('Stop camera')}
            </button>
          )}
          {import.meta.env.DEV && running && !checking && (
            <button className="btn subtle" onClick={() => setChecking(true)} title={T('Follow a few poses so the scoring can be checked against known answers')}>
              {T('Check accuracy')}
            </button>
          )}
          {/* Auto is right almost always, so this is one button that reports
              what it decided rather than three that ask you to decide. */}
          <button
            className={`btn subtle ${mirrorMode === 'auto' ? '' : 'active'}`}
            onClick={() =>
              setMirrorMode(
                mirrorMode === 'auto' ? 'mirror' : mirrorMode === 'mirror' ? 'direct' : 'auto',
              )
            }
            title={T('Whether your left should mirror the dancer, or match their side. Auto reads which way they are facing.')}
          >
            {mirrorMode === 'auto'
              ? `${T('Sides: auto')} · ${mirroredNow ? T('mirrored') : T('same side')}`
              : mirrorMode === 'mirror'
                ? T('Sides: mirrored')
                : T('Sides: same side')}
          </button>
        </div>
        <div className="ctrl-group problems">
          {running && problems.length > 0 && (
            <span className="hint">
              {T('Watch')}: <b>{problems.join('、')}</b>
            </span>
          )}
        </div>
      </div>
    </section>
  )
}
