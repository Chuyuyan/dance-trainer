import type { NormalizedLandmark } from '@mediapipe/tasks-vision'

export type Level = 'ok' | 'warn' | 'bad' | 'na'

// BlazePose 33-landmark indices
export const LM = {
  nose: 0,
  lEar: 7,
  rEar: 8,
  lShoulder: 11,
  rShoulder: 12,
  lElbow: 13,
  rElbow: 14,
  lWrist: 15,
  rWrist: 16,
  lHip: 23,
  rHip: 24,
  lKnee: 25,
  rKnee: 26,
  lAnkle: 27,
  rAnkle: 28,
  lFoot: 31,
  rFoot: 32,
} as const

/** Which half of the body a segment belongs to, for limb coloring. */
export type Side = 'left' | 'right' | 'center'

export interface Connection {
  a: number
  b: number
  side: Side
}

export const CONNECTIONS: Connection[] = [
  // Torso stays neutral so the coloured limbs read clearly against it.
  { a: LM.lShoulder, b: LM.rShoulder, side: 'center' },
  { a: LM.lShoulder, b: LM.lHip, side: 'center' },
  { a: LM.rShoulder, b: LM.rHip, side: 'center' },
  { a: LM.lHip, b: LM.rHip, side: 'center' },
  { a: LM.lShoulder, b: LM.lElbow, side: 'left' },
  { a: LM.lElbow, b: LM.lWrist, side: 'left' },
  { a: LM.rShoulder, b: LM.rElbow, side: 'right' },
  { a: LM.rElbow, b: LM.rWrist, side: 'right' },
  { a: LM.lHip, b: LM.lKnee, side: 'left' },
  { a: LM.lKnee, b: LM.lAnkle, side: 'left' },
  { a: LM.lAnkle, b: LM.lFoot, side: 'left' },
  { a: LM.rHip, b: LM.rKnee, side: 'right' },
  { a: LM.rKnee, b: LM.rAnkle, side: 'right' },
  { a: LM.rAnkle, b: LM.rFoot, side: 'right' },
]

/** MediaPipe hand topology, 21 landmarks per hand. */
export const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],           // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],           // index
  [9, 10], [10, 11], [11, 12],              // middle
  [13, 14], [14, 15], [15, 16],             // ring
  [0, 17], [17, 18], [18, 19], [19, 20],    // pinky
  [5, 9], [9, 13], [13, 17],                // palm
]

const VIS_MIN = 0.4

export const LEVEL_COLORS: Record<Level, string> = {
  ok: '#3ddc84',
  warn: '#ffd23f',
  bad: '#ff5a76',
  // Neutral, so it can't be mistaken for the reference panel's limb colors.
  na: '#a8b8cc',
}

/** Limb colors for the reference dancer. These are the dancer's own left and
 * right — with the mirror on, their left limb appears on your right. */
export const SIDE_COLORS: Record<Side, string> = {
  left: '#43e8ff',
  right: '#ff9f43',
  center: '#dbe7f5',
}

function visible(lm: NormalizedLandmark) {
  return (lm.visibility ?? 1) >= VIS_MIN
}

export interface DrawOptions {
  color?: string
  lineWidth?: number
  glow?: boolean
  /**
   * Per-connection colors, keyed by "a-b" of CONNECTIONS entries. Takes
   * precedence over `sideColors` — the match feedback on the webcam skeleton
   * matters more than which limb it is.
   */
  connectionColors?: Map<string, string>
  /** Color each segment by which half of the body it belongs to. */
  sideColors?: Record<Side, string>
  /** Overrides the head circle and nose stub, for match feedback. */
  headColor?: string
  /** Connections to draw faintly: present, but not what you are practising. */
  dimmed?: Set<string>
}

export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  lm: NormalizedLandmark[],
  w: number,
  h: number,
  opts: DrawOptions = {},
) {
  const { color = '#43e8ff', lineWidth = 6, glow = true, connectionColors, sideColors } = opts
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (const { a, b, side } of CONNECTIONS) {
    if (!visible(lm[a]) || !visible(lm[b])) continue
    const faded = opts.dimmed?.has(`${a}-${b}`) ?? false
    const c = faded
      ? 'rgba(150,150,165,0.28)'
      : (connectionColors?.get(`${a}-${b}`) ?? sideColors?.[side] ?? color)
    ctx.strokeStyle = c
    ctx.lineWidth = faded ? lineWidth * 0.5 : lineWidth
    if (glow && !faded) {
      ctx.shadowColor = c
      ctx.shadowBlur = lineWidth * 2
    } else {
      ctx.shadowBlur = 0
    }
    ctx.beginPath()
    ctx.moveTo(lm[a].x * w, lm[a].y * h)
    ctx.lineTo(lm[b].x * w, lm[b].y * h)
    ctx.stroke()
  }

  // Head: a circle centred between the ears (falls back to the nose).
  const le = lm[LM.lEar]
  const re = lm[LM.rEar]
  let cx: number | null = null
  let cy = 0
  let r = 0
  if (visible(le) && visible(re)) {
    cx = ((le.x + re.x) / 2) * w
    cy = ((le.y + re.y) / 2) * h
    r = Math.max(Math.hypot((le.x - re.x) * w, (le.y - re.y) * h) * 0.9, lineWidth * 1.5)
  } else if (visible(lm[LM.nose])) {
    cx = lm[LM.nose].x * w
    cy = lm[LM.nose].y * h
    r = lineWidth * 2.2
  }
  if (cx !== null) {
    const headColor = opts.headColor ?? sideColors?.center ?? color
    ctx.strokeStyle = headColor
    ctx.lineWidth = lineWidth
    if (glow) {
      ctx.shadowColor = headColor
      ctx.shadowBlur = lineWidth * 2
    }
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()

    // A stub towards the nose, so which way the head is turned is visible at
    // a glance rather than implied by a circle that looks the same either way.
    const nose = lm[LM.nose]
    if (visible(nose)) {
      const dx = nose.x * w - cx
      const dy = nose.y * h - cy
      const len = Math.hypot(dx, dy)
      if (len > 1) {
        ctx.beginPath()
        ctx.moveTo(cx, cy)
        ctx.lineTo(cx + (dx / len) * r * 1.6, cy + (dy / len) * r * 1.6)
        ctx.stroke()
      }
    }
  }

  // Joint dots
  ctx.shadowBlur = 0
  ctx.fillStyle = '#ffffff'
  for (const i of Object.values(LM)) {
    if (i === LM.nose || i === LM.lEar || i === LM.rEar) continue
    if (!visible(lm[i])) continue
    ctx.beginPath()
    ctx.arc(lm[i].x * w, lm[i].y * h, lineWidth * 0.55, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

/** Draw one 21-landmark hand. Fingers are thin so they read as detail. */
export function drawHand(
  ctx: CanvasRenderingContext2D,
  lm: NormalizedLandmark[],
  w: number,
  h: number,
  color: string,
  lineWidth = 3,
) {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.shadowColor = color
  ctx.shadowBlur = lineWidth * 1.5
  for (const [a, b] of HAND_CONNECTIONS) {
    if (!lm[a] || !lm[b]) continue
    ctx.beginPath()
    ctx.moveTo(lm[a].x * w, lm[a].y * h)
    ctx.lineTo(lm[b].x * w, lm[b].y * h)
    ctx.stroke()
  }
  ctx.shadowBlur = 0
  ctx.fillStyle = '#ffffff'
  // Fingertips only — dotting all 21 points turns the hand into a blob.
  for (const i of [4, 8, 12, 16, 20]) {
    if (!lm[i]) continue
    ctx.beginPath()
    ctx.arc(lm[i].x * w, lm[i].y * h, lineWidth * 0.6, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

/**
 * A crop to look for one hand in, derived from the pose's wrist and elbow.
 *
 * Searching the whole frame for hands does not work on dance footage: hands are
 * small, and at thresholds low enough to find them the model reports feet and
 * faces as hands. Anchoring the search to a wrist removes that whole class of
 * false positive and hands the model a much larger subject.
 */
export function cropForHand(
  pose: NormalizedLandmark[],
  side: 'left' | 'right',
  vw: number,
  vh: number,
): CropBox | null {
  const wristIdx = side === 'left' ? LM.lWrist : LM.rWrist
  const elbowIdx = side === 'left' ? LM.lElbow : LM.rElbow
  const wrist = pose[wristIdx]
  if (!visible(wrist)) return null

  // Scale off the shoulders, falling back to torso height for a side-on pose.
  const ls = pose[LM.lShoulder]
  const rs = pose[LM.rShoulder]
  const lh = pose[LM.lHip]
  let scale = 0
  if (visible(ls) && visible(rs)) scale = Math.hypot((ls.x - rs.x) * vw, (ls.y - rs.y) * vh)
  if (scale < 1 && visible(ls) && visible(lh)) {
    scale = Math.hypot((ls.x - lh.x) * vw, (ls.y - lh.y) * vh) * 0.7
  }
  if (scale < 1) scale = Math.min(vw, vh) * 0.2
  const size = Math.max(scale * 1.3, 48)

  // The hand continues past the wrist, away from the elbow.
  let cx = wrist.x * vw
  let cy = wrist.y * vh
  const elbow = pose[elbowIdx]
  if (visible(elbow)) {
    const dx = (wrist.x - elbow.x) * vw
    const dy = (wrist.y - elbow.y) * vh
    const len = Math.hypot(dx, dy)
    if (len > 1) {
      cx += (dx / len) * size * 0.22
      cy += (dy / len) * size * 0.22
    }
  }
  return clampCrop({ x: cx - size / 2, y: cy - size / 2, size }, vw, vh)
}

export type Facing = 'front' | 'back'

/**
 * Whether the dancer faces the camera or away from it.
 *
 * A person facing you has their anatomical left on your right, so the left
 * shoulder lands at a greater image x than the right one; turned away, the
 * order flips. This decides whether the comparison should mirror: dance
 * tutorials are routinely filmed from behind precisely so you can copy the
 * moves directly, and mirroring those turns every asymmetric move into an
 * error. Returns null when the dancer is side-on and the cue is meaningless.
 */
export function facing(lm: NormalizedLandmark[]): Facing | null {
  const ls = lm[LM.lShoulder]
  const rs = lm[LM.rShoulder]
  if (!visible(ls) || !visible(rs)) return null
  const dx = ls.x - rs.x
  // Too narrow to call — the shoulders are edge-on to the camera.
  if (Math.abs(dx) < 0.03) return null
  return dx > 0 ? 'front' : 'back'
}

/** Torso centroid in normalized coords, or null if the torso isn't visible. */
export function poseCenter(lm: NormalizedLandmark[]): [number, number] | null {
  const pts = [LM.lShoulder, LM.rShoulder, LM.lHip, LM.rHip].filter((i) => visible(lm[i]))
  if (pts.length < 2) return null
  let x = 0
  let y = 0
  for (const i of pts) {
    x += lm[i].x
    y += lm[i].y
  }
  return [x / pts.length, y / pts.length]
}

export function poseBBox(lm: NormalizedLandmark[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = 1
  let y0 = 1
  let x1 = 0
  let y1 = 0
  for (const p of lm) {
    if (!visible(p)) continue
    x0 = Math.min(x0, p.x)
    y0 = Math.min(y0, p.y)
    x1 = Math.max(x1, p.x)
    y1 = Math.max(y1, p.y)
  }
  return { x0, y0, x1, y1 }
}

/** A square crop of the source frame, in source pixels. */
export interface CropBox {
  x: number
  y: number
  size: number
}

/**
 * A square box around `lm`, padded to give the dancer room to move.
 * Square so the crop never distorts the pose; clamped to stay inside the frame.
 */
export function cropAround(
  lm: NormalizedLandmark[],
  vw: number,
  vh: number,
  pad = 1.7,
): CropBox | null {
  const bb = poseBBox(lm)
  if (bb.x1 <= bb.x0 || bb.y1 <= bb.y0) return null
  const cx = ((bb.x0 + bb.x1) / 2) * vw
  const cy = ((bb.y0 + bb.y1) / 2) * vh
  const reach = Math.max((bb.x1 - bb.x0) * vw, (bb.y1 - bb.y0) * vh) * pad
  return clampCrop({ x: cx - reach / 2, y: cy - reach / 2, size: reach }, vw, vh)
}

/**
 * Whether a click really landed on this pose. `pickPose` returns the nearest
 * pose however far away it is, so callers that want "the dancer I clicked, or
 * nobody" must check the hit as well.
 */
export function poseHit(lm: NormalizedLandmark[], nx: number, ny: number, slack = 0.04) {
  const bb = poseBBox(lm)
  if (bb.x1 <= bb.x0 || bb.y1 <= bb.y0) return false
  return (
    nx >= bb.x0 - slack && nx <= bb.x1 + slack && ny >= bb.y0 - slack && ny <= bb.y1 + slack
  )
}

/** A default-sized box centred on a click, for a dancer the detector missed. */
export function cropAtPoint(nx: number, ny: number, vw: number, vh: number): CropBox {
  const size = Math.min(vw, vh) * 0.85
  return clampCrop({ x: nx * vw - size / 2, y: ny * vh - size / 2, size }, vw, vh)
}

export function clampCrop(box: CropBox, vw: number, vh: number): CropBox {
  const size = Math.min(box.size, vw, vh)
  return {
    size,
    x: Math.max(0, Math.min(box.x, vw - size)),
    y: Math.max(0, Math.min(box.y, vh - size)),
  }
}

export function lerpCrop(from: CropBox, to: CropBox, t: number): CropBox {
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    size: from.size + (to.size - from.size) * t,
  }
}

/** Re-express crop-local landmarks in full-frame normalized coords. */
export function unproject(
  lm: NormalizedLandmark[],
  box: CropBox,
  vw: number,
  vh: number,
): NormalizedLandmark[] {
  return lm.map((p) => ({
    ...p,
    x: (box.x + p.x * box.size) / vw,
    y: (box.y + p.y * box.size) / vh,
  }))
}

/**
 * Choose which detected pose to follow.
 * A click always wins; otherwise stick with the pose nearest the previous
 * center; otherwise take the largest pose in frame.
 */
export function pickPose(
  poses: NormalizedLandmark[][],
  prevCenter: [number, number] | null,
  click: [number, number] | null,
): number {
  if (poses.length === 0) return -1
  if (click) {
    let best = -1
    let bestD = Infinity
    poses.forEach((p, i) => {
      const bb = poseBBox(p)
      const inside = click[0] >= bb.x0 && click[0] <= bb.x1 && click[1] >= bb.y0 && click[1] <= bb.y1
      const c = poseCenter(p)
      const d = c ? Math.hypot(c[0] - click[0], c[1] - click[1]) : Infinity
      const score = inside ? d * 0.25 : d
      if (score < bestD) {
        bestD = score
        best = i
      }
    })
    return best
  }
  if (prevCenter) {
    let best = -1
    let bestD = Infinity
    poses.forEach((p, i) => {
      const c = poseCenter(p)
      if (!c) return
      const d = Math.hypot(c[0] - prevCenter[0], c[1] - prevCenter[1])
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    if (best >= 0 && bestD < 0.3) return best
  }
  // Largest bbox area
  let best = 0
  let bestA = -1
  poses.forEach((p, i) => {
    const bb = poseBBox(p)
    const a = (bb.x1 - bb.x0) * (bb.y1 - bb.y0)
    if (a > bestA) {
      bestA = a
      best = i
    }
  })
  return best
}
