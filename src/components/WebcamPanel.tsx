import { useEffect, useRef, useState } from 'react'
import type { PoseLandmarker } from '@mediapipe/tasks-vision'
import { createPoseLandmarker } from '../pose/landmarker'
import { drawSkeleton, LEVEL_COLORS } from '../pose/skeleton'
import { computeAngles, compareAngles, levelConnectionColors } from '../pose/angles'
import type { TargetPose } from './VideoPanel'
import { recordSession } from '../playkitClient'

interface Props {
  targetRef: React.MutableRefObject<TargetPose>
  /** Which dance is loaded, so practice is filed against it in the library. */
  videoId?: string
  videoName?: string
}

export default function WebcamPanel({ targetRef, videoId, videoName }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const landmarkerRef = useRef<PoseLandmarker | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const emaRef = useRef<number | null>(null)
  const lastUiRef = useRef(0)
  const mirrorCompareRef = useRef(true)

  // Aggregates for the practice session, so a signed-in dancer keeps a history
  // instead of a number that vanishes when the camera stops.
  const sessionRef = useRef({ startedAt: 0, sum: 0, count: 0, best: 0 })

  const [running, setRunning] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mirrorCompare, setMirrorCompare] = useState(true)
  const [score, setScore] = useState<number | null>(null)
  const [problems, setProblems] = useState<string[]>([])

  mirrorCompareRef.current = mirrorCompare

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
          ? 'Camera permission denied — allow it in your browser settings'
          : 'Could not start the camera',
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
    emaRef.current = null
    setRunning(false)
    setScore(null)
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

      const pose = res.landmarks[0]
      const target = targetRef.current.angles
      let frameScore: number | null = null
      let frameProblems: string[] = []
      if (pose) {
        const user = computeAngles(pose, cv.width / cv.height)
        const cmp = compareAngles(user, target, mirrorCompareRef.current)
        drawSkeleton(ctx, pose, cv.width, cv.height, {
          color: LEVEL_COLORS.na,
          lineWidth: 7,
          connectionColors: target ? levelConnectionColors(cmp.levels, LEVEL_COLORS) : undefined,
        })
        frameScore = cmp.score
        frameProblems = cmp.problems
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
      const now = performance.now()
      if (now - lastUiRef.current > 200) {
        lastUiRef.current = now
        setScore(emaRef.current === null ? null : Math.round(emaRef.current))
        setProblems(frameProblems)
      }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [running, targetRef])

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>You</h2>
        <span className="hint">{running ? 'Comparing live' : 'Turn on your camera to follow along'}</span>
      </div>

      <div className="stage mirrored webcam-stage">
        <video ref={videoRef} playsInline muted />
        <canvas ref={canvasRef} />
        {!running && (
          <div className="stage-overlay">
            <button className="btn primary" onClick={start} disabled={starting}>
              {starting ? 'Starting…' : 'Turn on camera'}
            </button>
            {error && <p className="error">{error}</p>}
          </div>
        )}
        {running && (
          <div className="score-badge">
            <span className="score-num">{score ?? '—'}</span>
            <span className="score-label">match</span>
          </div>
        )}
      </div>

      <div className="controls">
        <div className="ctrl-group">
          {running && (
            <button className="btn" onClick={stop}>
              Stop camera
            </button>
          )}
          <button
            className={`btn ${mirrorCompare ? 'active' : ''}`}
            onClick={() => setMirrorCompare(!mirrorCompare)}
            title="Compare as if facing a mirror — your left hand matches the dancer's right"
          >
            Mirror compare
          </button>
        </div>
        <div className="ctrl-group problems">
          {running && problems.length > 0 && (
            <span className="hint">
              Watch: <b>{problems.join(', ')}</b>
            </span>
          )}
        </div>
      </div>
    </section>
  )
}
