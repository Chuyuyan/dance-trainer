import { T } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import type { HandLandmarker, NormalizedLandmark, PoseLandmarker } from '@mediapipe/tasks-vision'
import { createHandLandmarker, createPoseLandmarker } from '../pose/landmarker'
import {
  clampCrop,
  cropAround,
  cropAtPoint,
  cropForHand,
  drawHand,
  drawSkeleton,
  lerpCrop,
  pickPose,
  poseBBox,
  poseCenter,
  poseHit,
  SIDE_COLORS,
  unproject,
  type CropBox,
} from '../pose/skeleton'
import { computeAngles, type Landmark3, type PoseFeature, type TargetFrame } from '../pose/angles'
import { facing, type Facing } from '../pose/skeleton'
import { LandmarkSmoother } from '../pose/filter'
import SectionList from './SectionList'
import { activeSection, newSectionId, type Section, type SectionStat } from '../lib/library'

export interface TargetPose {
  feature: PoseFeature | null
  /** Which marked phrase the video is inside, so practice can be filed to it. */
  sectionId: string | null
  /** Recent reference frames, oldest first, so scoring can tolerate lag. */
  history: TargetFrame[]
  /** Current video time in seconds. */
  time: number
  /** Which way the reference dancer is facing, or null when side-on. */
  facing: Facing | null
}

/** Video seconds of lag the comparison will forgive. */
const LAG_WINDOW_S = 1

interface Props {
  src: string
  targetRef: React.MutableRefObject<TargetPose>
  sections: Section[]
  sectionStats?: Record<string, SectionStat>
  onSectionsChange: (sections: Section[]) => void
}


const RATES = [0.25, 0.5, 0.75, 1]

/** Side length fed to the model when following one dancer inside a crop. */
const CROP_PX = 384

/**
 * Past this the source has no more detail to give — it just magnifies blur.
 */
const MAX_ZOOM = 2.5

export type ZoomMode = 'off' | 'fit' | 'follow'

interface BBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * How long Fit watches before committing to a framing and freezing. Measured
 * in wall-clock, not frames: on a slow machine a frame count would leave the
 * shot drifting for seconds. The frame minimum just guarantees some data.
 */
const FIT_WARMUP_MS = 1500
const FIT_WARMUP_MIN_FRAMES = 8

/** Slack around the framed region, as a fraction of it. */
const FIT_PAD = 0.1

const boxArea = (b: BBox) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0)

const unionBox = (a: BBox, b: BBox): BBox => ({
  x0: Math.min(a.x0, b.x0),
  y0: Math.min(a.y0, b.y0),
  x1: Math.max(a.x1, b.x1),
  y1: Math.max(a.y1, b.y1),
})

/** Grow a box by `f` of its own size on every side. */
const expandBox = (b: BBox, f: number): BBox => {
  const dx = (b.x1 - b.x0) * f
  const dy = (b.y1 - b.y0) * f
  return { x0: b.x0 - dx, y0: b.y0 - dy, x1: b.x1 + dx, y1: b.y1 + dy }
}

const containsBox = (outer: BBox, inner: BBox) =>
  inner.x0 >= outer.x0 && inner.x1 <= outer.x1 && inner.y0 >= outer.y0 && inner.y1 <= outer.y1

const lerpBox = (a: BBox, b: BBox, t: number): BBox => ({
  x0: a.x0 + (b.x0 - a.x0) * t,
  y0: a.y0 + (b.y0 - a.y0) * t,
  x1: a.x1 + (b.x1 - a.x1) * t,
  y1: a.y1 + (b.y1 - a.y1) * t,
})

function fmt(t: number) {
  // Screen-recorded/MediaRecorder webm files report Infinity until played.
  if (!Number.isFinite(t)) return '–:–'
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function VideoPanel({
  src,
  targetRef,
  sections,
  sectionStats,
  onSectionsChange,
}: Props) {
  const sectionsRef = useRef<Section[]>([])
  sectionsRef.current = sections
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const stageInnerRef = useRef<HTMLDivElement>(null)
  const zoomModeRef = useRef<ZoomMode>('off')
  const mirrorRef = useRef(true)
  // Current eased zoom transform: [scale, translateX, translateY].
  const zoomRef = useRef<[number, number, number]>([1, 0, 0])
  // The region we are framing, in unmirrored video coords.
  const framedRef = useRef<BBox | null>(null)
  // Deadbanded destination, so small wobbles never move the shot.
  const zoomTargetRef = useRef<[number, number, number] | null>(null)
  // Fit: once committed the framing stops responding to ordinary movement.
  const fitFrozenRef = useRef(false)
  const fitFramesRef = useRef(0)
  const fitStartRef = useRef(0)
  const lastPoseRef = useRef<NormalizedLandmark[] | null>(null)
  const smootherRef = useRef(new LandmarkSmoother())
  // Separate instances: a VIDEO-mode tracker keeps internal state per stream,
  // so feeding one both whole frames and crops corrupts its predictions.
  const fullLmkRef = useRef<PoseLandmarker | null>(null)
  const cropLmkRef = useRef<PoseLandmarker | null>(null)
  const handLmkRef = useRef<{ left: HandLandmarker | null; right: HandLandmarker | null }>({
    left: null,
    right: null,
  })
  const handsOnRef = useRef(false)
  const offscreenRef = useRef<HTMLCanvasElement | null>(null)
  const selCenterRef = useRef<[number, number] | null>(null)
  const clickRef = useRef<[number, number] | null>(null)
  const lastTimeRef = useRef(-1)
  const lockRef = useRef<CropBox | null>(null)
  const missRef = useRef(0)
  // Frames still to re-detect even if the video has not advanced, so a paused
  // frame converges instead of freezing on a warm-up result.
  const settleRef = useRef(0)
  const tsRef = useRef(0)

  const [modelState, setModelState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [mirror, setMirror] = useState(true)
  const [ghost, setGhost] = useState(false)
  const [rate, setRate] = useState(1)
  const [loopA, setLoopA] = useState<number | null>(null)
  const [loopB, setLoopB] = useState<number | null>(null)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [personCount, setPersonCount] = useState(0)
  const [locked, setLocked] = useState(false)
  const [handsOn, setHandsOn] = useState(false)
  const [handsLoading, setHandsLoading] = useState(false)
  const [handCount, setHandCount] = useState(0)
  const [zoomMode, setZoomMode] = useState<ZoomMode>('off')
  const [more, setMore] = useState(false)

  handsOnRef.current = handsOn
  zoomModeRef.current = zoomMode
  mirrorRef.current = mirror

  /** Re-frame from scratch: the old region no longer describes the subject. */
  const resetFraming = () => {
    framedRef.current = null
    zoomTargetRef.current = null
    fitFrozenRef.current = false
    fitFramesRef.current = 0
    fitStartRef.current = 0
  }

  useEffect(() => {
    let closed = false
    Promise.all([createPoseLandmarker(5), createPoseLandmarker(1)])
      .then(([full, crop]) => {
        if (closed) {
          full.close()
          crop.close()
          return
        }
        fullLmkRef.current = full
        cropLmkRef.current = crop
        setModelState('ready')
      })
      .catch((e) => {
        console.error('PoseLandmarker init failed', e)
        setModelState('error')
      })
    return () => {
      closed = true
      fullLmkRef.current?.close()
      cropLmkRef.current?.close()
      handLmkRef.current.left?.close()
      handLmkRef.current.right?.close()
      fullLmkRef.current = null
      cropLmkRef.current = null
      handLmkRef.current = { left: null, right: null }
    }
  }, [])

  // The hand model is a second inference pass per frame, so only load it when
  // the user actually turns fingers on.
  const toggleHands = async () => {
    if (handsOn) {
      setHandsOn(false)
      return
    }
    if (!handLmkRef.current.left) {
      setHandsLoading(true)
      try {
        const [left, right] = await Promise.all([createHandLandmarker(1), createHandLandmarker(1)])
        handLmkRef.current = { left, right }
      } catch (e) {
        console.error('HandLandmarker init failed', e)
        setHandsLoading(false)
        return
      }
      setHandsLoading(false)
    }
    settleRef.current = 8
    setHandsOn(true)
  }

  // Reset per-video state when the source changes.
  useEffect(() => {
    selCenterRef.current = null
    lastTimeRef.current = -1
    lockRef.current = null
    missRef.current = 0
    lastPoseRef.current = null
    smootherRef.current.reset()
    zoomRef.current = [1, 0, 0]
    framedRef.current = null
    zoomTargetRef.current = null
    fitFrozenRef.current = false
    fitFramesRef.current = 0
    fitStartRef.current = 0
    if (stageInnerRef.current) stageInnerRef.current.style.transform = ''
    setLoopA(null)
    setLoopB(null)
    setPersonCount(0)
    setLocked(false)
    targetRef.current.feature = null
    targetRef.current.history = []
    targetRef.current.facing = null
  }, [src, targetRef])

  useEffect(() => {
    let raf = 0
    let hadPose = false
    let lastTry = 0
    const loop = () => {
      raf = requestAnimationFrame(loop)
      const v = videoRef.current
      const cv = canvasRef.current
      const fullLmk = fullLmkRef.current
      const cropLmk = cropLmkRef.current
      if (!v || !cv || !fullLmk || !cropLmk || v.readyState < 2 || v.videoWidth === 0) return
      // Ease the zoom every frame, not just on frames that run detection —
      // otherwise it freezes mid-animation whenever the video is paused.
      applyZoom(lastPoseRef.current, v.videoWidth, v.videoHeight)
      const clicked = clickRef.current !== null
      // While paused with nothing detected yet, retry at a low rate — the
      // first frame of a never-played video can decode as empty for MediaPipe.
      const retry = !hadPose && performance.now() - lastTry > 250
      const settling = settleRef.current > 0
      if (v.currentTime === lastTimeRef.current && !clicked && !retry && !settling) return
      if (settling) settleRef.current--
      lastTimeRef.current = v.currentTime
      lastTry = performance.now()
      // Timestamps must strictly increase per landmarker.
      const stamp = () => ++tsRef.current

      const vw = v.videoWidth
      const vh = v.videoHeight
      const click = clickRef.current
      clickRef.current = null

      // Route the frame through a 2D canvas: WebGL uploads straight from a
      // paused/seeked <video> can come up empty, while drawImage never does.
      const off = (offscreenRef.current ??= document.createElement('canvas'))
      const drawFrame = (box: CropBox | null) => {
        const w = box ? CROP_PX : vw
        const h = box ? CROP_PX : vh
        if (off.width !== w || off.height !== h) {
          off.width = w
          off.height = h
        }
        const c = off.getContext('2d')!
        if (box) c.drawImage(v, box.x, box.y, box.size, box.size, 0, 0, w, h)
        else c.drawImage(v, 0, 0, w, h)
        return off
      }

      if (cv.width !== vw || cv.height !== vh) {
        cv.width = vw
        cv.height = vh
      }
      const ctx = cv.getContext('2d')!
      ctx.clearRect(0, 0, vw, vh)

      // A click always re-picks. Prefer a pose the full-frame pass can see;
      // otherwise lock a default box on the click and let the crop pass find
      // the dancer there — that is the only way to follow someone the
      // whole-frame detector never reports.
      if (click) {
        missRef.current = 0
        const full = fullLmk.detectForVideo(drawFrame(null), stamp()).landmarks
        const idx = pickPose(full, null, click)
        // Only trust the whole-frame pose if the click actually landed on it.
        // Otherwise the click is on a dancer the detector never reported, and
        // snapping to the one it did see would follow the wrong person.
        const onPose = idx >= 0 && poseHit(full[idx], click[0], click[1])
        lockRef.current =
          (onPose ? cropAround(full[idx], vw, vh) : null) ??
          cropAtPoint(click[0], click[1], vw, vh)
        // Give the crop tracker a few frames to converge on the new framing.
        settleRef.current = 8
        // Different dancer, so anything we learned about them is stale.
        smootherRef.current.reset()
        framedRef.current = null
        zoomTargetRef.current = null
        fitFrozenRef.current = false
        fitFramesRef.current = 0
        fitStartRef.current = 0
      }

      let selected: NormalizedLandmark[] | null = null
      let selectedWorld: Landmark3[] | null = null
      let others: NormalizedLandmark[][] = []

      if (lockRef.current) {
        const box = lockRef.current
        const res = cropLmk.detectForVideo(drawFrame(box), stamp())
        const local = res.landmarks[0]
        if (local) {
          selected = unproject(local, box, vw, vh)
          // World landmarks are hip-centred metres, so a crop does not distort
          // them and they need no unprojection.
          selectedWorld = res.worldLandmarks[0] ?? null
          missRef.current = 0
          // Ease the box toward the dancer so it follows without jitter.
          const next = cropAround(selected, vw, vh)
          if (next) lockRef.current = clampCrop(lerpCrop(box, next, 0.25), vw, vh)
        } else if (++missRef.current > 20) {
          // Lost them for good — fall back to whole-frame tracking.
          lockRef.current = null
        } else {
          // Widen the search a little in case they danced out of the box.
          lockRef.current = clampCrop({ ...box, size: box.size * 1.06 }, vw, vh)
        }
      }

      if (!lockRef.current) {
        const res = fullLmk.detectForVideo(drawFrame(null), stamp())
        const poses = res.landmarks
        const idx = pickPose(poses, selCenterRef.current, null)
        selected = idx >= 0 ? poses[idx] : null
        selectedWorld = idx >= 0 ? res.worldLandmarks[idx] ?? null : null
        others = poses.filter((_, i) => i !== idx)
        setPersonCount(poses.length)
      }

      hadPose = selected !== null
      for (const p of others) {
        drawSkeleton(ctx, p, vw, vh, { color: 'rgba(255,255,255,0.3)', lineWidth: 3, glow: false })
      }
      if (selected) {
        // The reference jitters for the same reason the webcam does, and its
        // noise feeds straight into the target angles.
        selected = smootherRef.current.filter(selected, performance.now() / 1000)
        selCenterRef.current = poseCenter(selected) ?? selCenterRef.current
        drawSkeleton(ctx, selected, vw, vh, { lineWidth: 7, sideColors: SIDE_COLORS })
        const feature = selectedWorld ? computeAngles(selectedWorld) : null
        const target = targetRef.current
        target.feature = feature
        target.time = v.currentTime
        target.sectionId = activeSection(sectionsRef.current, v.currentTime)?.id ?? null
        // Side-on frames report nothing; hold the last confident reading.
        target.facing = facing(selected) ?? target.facing

        // A seek or a loop makes earlier frames meaningless as "what they were
        // copying a moment ago", so the window restarts.
        const hist = target.history
        const last = hist[hist.length - 1]
        if (last && (v.currentTime < last.t || v.currentTime > last.t + LAG_WINDOW_S)) hist.length = 0
        if (feature) hist.push({ t: v.currentTime, feature })
        while (hist.length > 1 && hist[0].t < v.currentTime - LAG_WINDOW_S) hist.shift()
      } else {
        targetRef.current.feature = null
      }

      // Fingers: search a small box anchored on each wrist rather than the
      // whole frame. One landmarker per hand, since a VIDEO-mode tracker fed
      // two different crops would mix the two hands' state.
      if (handsOnRef.current && selected) {
        let found = 0
        for (const side of ['left', 'right'] as const) {
          const lmk = handLmkRef.current[side]
          if (!lmk) continue
          const box = cropForHand(selected, side, vw, vh)
          if (!box) continue
          const res = lmk.detectForVideo(drawFrame(box), stamp())
          const hand = res.landmarks[0]
          if (!hand) continue
          found++
          const pts = unproject(hand, box, vw, vh)
          drawHand(ctx, pts, vw, vh, SIDE_COLORS[side], Math.max(2, vh / 200))
        }
        setHandCount(found)
      } else if (handsOnRef.current) {
        setHandCount(0)
      }

      const box = lockRef.current
      if (box) {
        ctx.save()
        ctx.strokeStyle = 'rgba(67,232,255,0.5)'
        ctx.lineWidth = 2
        ctx.setLineDash([10, 8])
        ctx.strokeRect(box.x, box.y, box.size, box.size)
        ctx.restore()
      }
      setLocked(box !== null)
      lastPoseRef.current = selected
    }

    /**
     * Scale the stage so the dancer fills it. Written straight to the DOM
     * rather than through state — this runs every frame and re-rendering React
     * that often would be wasteful.
     */
    const applyZoom = (pose: NormalizedLandmark[] | null, vw: number, vh: number) => {
      const stage = stageRef.current
      const inner = stageInnerRef.current
      if (!stage || !inner) return
      const W = stage.clientWidth
      const H = stage.clientHeight
      if (!W || !H) return

      const mode = zoomModeRef.current
      if (mode === 'off') {
        framedRef.current = null
        fitFrozenRef.current = false
        fitFramesRef.current = 0
        fitStartRef.current = 0
      } else if (pose) {
        const bb = poseBBox(pose)
        if (bb.x1 > bb.x0 && bb.y1 > bb.y0) {
          // Accumulate in unmirrored video space, so flipping the mirror does
          // not throw away what we have learned about where the dancer moves.
          if (mode === 'fit') {
            // Fit watches for a moment, commits to a framing, and then holds it
            // — a shot that keeps creeping as the union grows is exactly the
            // jitter this mode exists to avoid. After freezing it only moves if
            // the dancer would otherwise leave the visible area.
            const cur = framedRef.current
            if (!fitFrozenRef.current) {
              // One bad frame must not widen the shot, so reject a box that
              // suddenly balloons.
              if (!cur) framedRef.current = bb
              else if (boxArea(bb) <= boxArea(cur) * 3) framedRef.current = unionBox(cur, bb)
              fitFramesRef.current++
              fitStartRef.current ||= performance.now()
              if (
                fitFramesRef.current >= FIT_WARMUP_MIN_FRAMES &&
                performance.now() - fitStartRef.current >= FIT_WARMUP_MS &&
                framedRef.current
              ) {
                // Commit, with headroom so ordinary movement never nudges it.
                framedRef.current = expandBox(framedRef.current, 0.08)
                fitFrozenRef.current = true
              }
            } else if (cur && !containsBox(expandBox(cur, FIT_PAD * 0.7), bb)) {
              // About to be clipped — re-frame once, then freeze again.
              framedRef.current = expandBox(unionBox(cur, bb), 0.08)
            }
          } else {
            // Follow: track the dancer, but off a heavily smoothed box so the
            // shot does not breathe every time an arm extends.
            const cur = framedRef.current
            framedRef.current = cur ? lerpBox(cur, bb, 0.05) : bb
          }
        }
      }
      // A pose that blinks out for a frame must not snap the view back — keep
      // the last framing until the mode changes or the video does.

      let target: [number, number, number] = zoomTargetRef.current ?? [1, 0, 0]
      const framed = framedRef.current
      if (mode === 'off') {
        target = [1, 0, 0]
        zoomTargetRef.current = null
      } else if (framed) {
        // object-fit: contain letterboxes the frame inside the stage.
        const fit = Math.min(W / vw, H / vh)
        const drawnW = vw * fit
        const drawnH = vh * fit
        const offX = (W - drawnW) / 2
        const offY = (H - drawnH) / 2

        // Mirroring flips which side of the stage the dancer is on.
        const [nx0, nx1] = mirrorRef.current
          ? [1 - framed.x1, 1 - framed.x0]
          : [framed.x0, framed.x1]
        // Fit already spans the whole routine, so it needs less slack than
        // Follow, which has to leave room for the next limb to extend.
        const pad = mode === 'fit' ? FIT_PAD : 0.2
        const bw = (nx1 - nx0) * drawnW * (1 + pad * 2)
        const bh = (framed.y1 - framed.y0) * drawnH * (1 + pad * 2)
        const s = Math.min(MAX_ZOOM, Math.max(1, Math.min(W / bw, H / bh)))

        const pdx = offX + ((nx0 + nx1) / 2) * drawnW
        const pdy = offY + ((framed.y0 + framed.y1) / 2) * drawnH
        let tx = -s * (pdx - W / 2)
        let ty = -s * (pdy - H / 2)

        // Keep the frame covering the stage so we never pan into the void.
        const clamp = (t: number, off: number, drawn: number, size: number) => {
          const lo = size - (size / 2 + s * (off + drawn - size / 2))
          const hi = -(size / 2 + s * (off - size / 2))
          return lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, t))
        }
        tx = clamp(tx, offX, drawnW, W)
        ty = clamp(ty, offY, drawnH, H)

        // Deadband: ignore changes too small to be worth moving the shot for.
        // Without this the view creeps continuously and reads as jitter.
        const prev = zoomTargetRef.current
        if (
          !prev ||
          Math.abs(s - prev[0]) > prev[0] * 0.05 ||
          Math.abs(tx - prev[1]) > 8 ||
          Math.abs(ty - prev[2]) > 8
        ) {
          zoomTargetRef.current = [s, tx, ty]
        }
        target = zoomTargetRef.current!
      }

      const cur = zoomRef.current
      const ease = 0.1
      const next: [number, number, number] = [
        cur[0] + (target[0] - cur[0]) * ease,
        cur[1] + (target[1] - cur[1]) * ease,
        cur[2] + (target[2] - cur[2]) * ease,
      ]
      zoomRef.current = next
      inner.style.transform =
        next[0] > 1.001 || Math.abs(next[1]) > 0.5 || Math.abs(next[2]) > 0.5
          ? `translate(${next[1].toFixed(2)}px, ${next[2].toFixed(2)}px) scale(${next[0].toFixed(4)})`
          : ''
    }

    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [targetRef])

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cv = e.currentTarget
    const rect = cv.getBoundingClientRect()
    if (!cv.width || !cv.height) return
    // The canvas is letterboxed inside its box by object-fit: contain, so undo
    // the bars before normalizing or every click lands off the dancer.
    const scale = Math.min(rect.width / cv.width, rect.height / cv.height)
    const drawnW = cv.width * scale
    const drawnH = cv.height * scale
    const px = e.clientX - rect.left - (rect.width - drawnW) / 2
    const py = e.clientY - rect.top - (rect.height - drawnH) / 2
    if (px < 0 || py < 0 || px > drawnW || py > drawnH) return
    let x = px / drawnW
    const y = py / drawnH
    if (mirror) x = 1 - x
    clickRef.current = [x, y]
  }

  const onTimeUpdate = () => {
    const v = videoRef.current
    if (!v) return
    setCurrentTime(v.currentTime)
    if (loopA !== null && loopB !== null && v.currentTime > loopB) {
      v.currentTime = loopA
    }
  }

  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play()
    else v.pause()
  }

  const setRateAndApply = (r: number) => {
    setRate(r)
    if (videoRef.current) videoRef.current.playbackRate = r
  }

  /**
   * Marks the phrase that just finished.
   *
   * Marking eight sections should not mean dragging the scrubber sixteen
   * times, so each new phrase starts where the last one ended: play, click at
   * the end of each phrase, done. An explicit A-B still wins when it is set.
   */
  const lastEnd = sections.length ? Math.max(...sections.map((s) => s.end)) : 0
  const sectionStart = loopA ?? lastEnd
  const sectionEnd = loopB ?? currentTime
  const canAddSection = sectionEnd - sectionStart >= 0.5

  const addSection = () => {
    if (!canAddSection) return
    onSectionsChange([
      ...sections,
      {
        id: newSectionId(),
        name: `Section ${sections.length + 1}`,
        start: sectionStart,
        end: sectionEnd,
      },
    ])
    // Chain straight into marking the next phrase.
    setLoopA(null)
    setLoopB(null)
  }

  const playSection = (section: Section) => {
    const v = videoRef.current
    if (!v) return
    setLoopA(section.start)
    setLoopB(section.end)
    v.currentTime = section.start
    void v.play()
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{T('Reference')}</h2>
        <span className="hint">
          {modelState === 'loading' && T('Loading pose model…')}
          {modelState === 'error' && T('Model failed to load — try reloading')}
          {modelState === 'ready' && locked && T('Following one dancer · click another to switch')}
          {modelState === 'ready' && !locked && personCount > 1 && T('Multiple dancers · click the one to follow')}
          {modelState === 'ready' && !locked && personCount <= 1 && T('Click a dancer to lock on')}
        </span>
      </div>

      <div className={`stage ${mirror ? 'mirrored' : ''}`} ref={stageRef}>
        <div className="stage-inner" ref={stageInnerRef}>
        <video
          ref={videoRef}
          src={src}
          playsInline
          style={{ opacity: ghost ? 0.16 : 1 }}
          onLoadedMetadata={(e) => {
            setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)
            e.currentTarget.playbackRate = rate
          }}
          onDurationChange={(e) => {
            setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)
          }}
          onLoadedData={() => {
            // Force one re-detect once the first frame is actually paintable.
            lastTimeRef.current = -1
          }}
          onTimeUpdate={onTimeUpdate}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />
        <canvas ref={canvasRef} onClick={onCanvasClick} />
        </div>
      </div>

      <div className="transport">
        <button className="btn play" onClick={togglePlay}>
          {playing ? '⏸' : '▶'}
        </button>
        <span className="time">{fmt(currentTime)}</span>
        <input
          className="seek"
          type="range"
          min={0}
          max={duration || 0}
          step={0.01}
          value={currentTime}
          onChange={(e) => {
            const v = videoRef.current
            if (v) v.currentTime = Number(e.target.value)
          }}
        />
        <span className="time">{fmt(duration)}</span>
      </div>

      <div className="controls">
        <div className="ctrl-group">
          <span className="ctrl-label">{T('Speed')}</span>
          {RATES.map((r) => (
            <button key={r} className={`btn ${rate === r ? 'active' : ''}`} onClick={() => setRateAndApply(r)}>
              {r}×
            </button>
          ))}
        </div>

        <div className="ctrl-group">
          <button className={`btn ${mirror ? 'active' : ''}`} onClick={() => setMirror(!mirror)}>
            {T('Mirror')}
          </button>
          <button
            className="btn"
            onClick={addSection}
            disabled={!canAddSection}
            title={
              canAddSection
                ? `${T('Mark a phrase ending here')} (${fmt(sectionStart)}–${fmt(sectionEnd)})`
                : T('Play past the end of a phrase, then mark it')
            }
          >
            {T('Mark to here')}
          </button>
          {locked && (
            <button
              className="btn active"
              onClick={() => {
                lockRef.current = null
                missRef.current = 0
                settleRef.current = 8
                resetFraming()
                setLocked(false)
              }}
              title={T('Go back to following whoever dominates the frame')}
            >
              {T('Unlock')}
            </button>
          )}
          <button
            className={`btn subtle ${more ? 'active' : ''}`}
            onClick={() => setMore(!more)}
            title={T('Outline, fingers, zoom and A-B loop')}
          >
            {more ? T('Fewer options') : T('More options')}
          </button>
        </div>
      </div>

      {/* Everything below is occasionally useful and permanently in the way, so
          it stays folded until asked for. */}
      {more && (
      <div className="controls controls-more">
        <div className="ctrl-group">
          <button className={`btn ${ghost ? 'active' : ''}`} onClick={() => setGhost(!ghost)}>
            {T('Outline only')}
          </button>
          <button
            className={`btn ${handsOn ? 'active' : ''}`}
            onClick={() => void toggleHands()}
            disabled={handsLoading}
            title={T('Track finger positions — costs an extra model pass per frame')}
          >
            {T(handsLoading ? 'Loading…' : 'Fingers')}
          </button>
        </div>

        <div className="ctrl-group">
          <span className="ctrl-label">{T('Zoom')}</span>
          {(
            [
              ['off', T('Off'), T('Show the whole frame')],
              ['fit', T('Fit'), T('Settle on a framing, then hold it — the shot stops moving')],
              ['follow', T('Follow'), T('Keep the dancer centred as they move around')],
            ] as const
          ).map(([mode, label, tip]) => (
            <button
              key={mode}
              className={`btn ${zoomMode === mode ? 'active' : ''}`}
              onClick={() => {
                resetFraming()
                setZoomMode(mode)
              }}
              title={tip}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="ctrl-group">
          <span className="ctrl-label">{T('Loop')}</span>
          <button
            className={`btn ${loopA !== null ? 'active' : ''}`}
            onClick={() => setLoopA(videoRef.current?.currentTime ?? 0)}
          >
            A{loopA !== null ? ` ${fmt(loopA)}` : ''}
          </button>
          <button
            className={`btn ${loopB !== null ? 'active' : ''}`}
            onClick={() => {
              const t = videoRef.current?.currentTime ?? 0
              setLoopB(loopA !== null && t <= loopA ? null : t)
            }}
          >
            B{loopB !== null ? ` ${fmt(loopB)}` : ''}
          </button>
          {(loopA !== null || loopB !== null) && (
            <button
              className="btn"
              onClick={() => {
                setLoopA(null)
                setLoopB(null)
              }}
            >
              Clear
            </button>
          )}
        </div>

        {handsOn && (
          <div className="ctrl-group">
            <span className="hint">
              {handCount > 0
                ? `${handCount} hand${handCount > 1 ? 's' : ''} tracked`
                : T('No hands found — try zooming in or locking on a dancer')}
            </span>
          </div>
        )}
      </div>
      )}

      <SectionList
        sections={sections}
        stats={sectionStats}
        activeId={activeSection(sections, currentTime)?.id ?? null}
        onPlay={playSection}
        onRemove={(s) => onSectionsChange(sections.filter((x) => x.id !== s.id))}
        onRename={(s, name) =>
          onSectionsChange(sections.map((x) => (x.id === s.id ? { ...x, name } : x)))
        }
      />
    </section>
  )
}
