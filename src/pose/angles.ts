import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { LM, type Level } from './skeleton'

export interface JointDef {
  name: string
  label: string
  mirror: string
  /** Angle is measured at `b`, between rays b→a and b→c. */
  a: number
  b: number
  c: number
  /** Skeleton segments adjacent to this joint, used for coloring. */
  segs: [number, number][]
}

export const JOINTS: JointDef[] = [
  { name: 'lElbow', label: 'left elbow', mirror: 'rElbow', a: LM.lShoulder, b: LM.lElbow, c: LM.lWrist, segs: [[LM.lShoulder, LM.lElbow], [LM.lElbow, LM.lWrist]] },
  { name: 'rElbow', label: 'right elbow', mirror: 'lElbow', a: LM.rShoulder, b: LM.rElbow, c: LM.rWrist, segs: [[LM.rShoulder, LM.rElbow], [LM.rElbow, LM.rWrist]] },
  { name: 'lShoulder', label: 'left shoulder', mirror: 'rShoulder', a: LM.lHip, b: LM.lShoulder, c: LM.lElbow, segs: [[LM.lShoulder, LM.lElbow]] },
  { name: 'rShoulder', label: 'right shoulder', mirror: 'lShoulder', a: LM.rHip, b: LM.rShoulder, c: LM.rElbow, segs: [[LM.rShoulder, LM.rElbow]] },
  { name: 'lHip', label: 'left hip', mirror: 'rHip', a: LM.lShoulder, b: LM.lHip, c: LM.lKnee, segs: [[LM.lHip, LM.lKnee]] },
  { name: 'rHip', label: 'right hip', mirror: 'lHip', a: LM.rShoulder, b: LM.rHip, c: LM.rKnee, segs: [[LM.rHip, LM.rKnee]] },
  { name: 'lKnee', label: 'left knee', mirror: 'rKnee', a: LM.lHip, b: LM.lKnee, c: LM.lAnkle, segs: [[LM.lHip, LM.lKnee], [LM.lKnee, LM.lAnkle]] },
  { name: 'rKnee', label: 'right knee', mirror: 'lKnee', a: LM.rHip, b: LM.rKnee, c: LM.rAnkle, segs: [[LM.rHip, LM.rKnee], [LM.rKnee, LM.rAnkle]] },
]

export type JointAngles = Record<string, number | null>

/** Key for the head's yaw inside a JointAngles map. */
export const HEAD = 'head'
export const HEAD_LABEL = 'head turn'

/**
 * Which way the head is turned, in degrees: 0 looking straight at the camera,
 * positive turned towards their own left, +-90 in full profile.
 *
 * Derived from where the nose sits between the ears. Facing forward it is
 * centred; as the head turns, it slides towards the ear it is turning
 * towards, reaching that ear in profile — so the offset over the half-span
 * approximates the sine of the yaw. Ear landmarks are inferred rather than
 * seen once the head turns far, which is why this is treated as a coarse
 * direction and not a precise measurement.
 */
export function headYaw(lm: NormalizedLandmark[], aspect: number): number | null {
  const nose = lm[LM.nose]
  const le = lm[LM.lEar]
  const re = lm[LM.rEar]
  if (!vis(nose) || !vis(le) || !vis(re)) return null
  const ex = (le.x - re.x) * aspect
  const ey = le.y - re.y
  const span = Math.hypot(ex, ey)
  // Half the ear span shrinks as cos(yaw); the nose's offset from their
  // midpoint grows as sin(yaw). The ratio is therefore a tangent, not a sine —
  // normalising by the span alone saturates long before the head is in profile.
  const half = span / 2
  const mx = ((le.x + re.x) / 2) * aspect
  const my = (le.y + re.y) / 2
  const offset =
    span < 1e-6 ? nose.x * aspect - mx : (((nose.x * aspect) - mx) * ex + (nose.y - my) * ey) / span
  // In full profile the ears converge, so guard on the head's overall scale
  // rather than the span, which is exactly what vanishes there.
  if (Math.hypot(offset, half) < 1e-4) return null
  return (Math.atan2(offset, half) * 180) / Math.PI
}

const VIS_MIN = 0.4

function vis(lm: NormalizedLandmark) {
  return (lm.visibility ?? 1) >= VIS_MIN
}

function angleAt(lm: NormalizedLandmark[], a: number, b: number, c: number, aspect: number): number | null {
  if (!vis(lm[a]) || !vis(lm[b]) || !vis(lm[c])) return null
  // Landmarks are normalized per-axis, so x is squashed by the frame aspect.
  // Scale x back into units of frame height or every angle is skewed — and the
  // video and the webcam usually have different aspect ratios.
  const v1x = (lm[a].x - lm[b].x) * aspect
  const v1y = lm[a].y - lm[b].y
  const v2x = (lm[c].x - lm[b].x) * aspect
  const v2y = lm[c].y - lm[b].y
  const dot = v1x * v2x + v1y * v2y
  const m1 = Math.hypot(v1x, v1y)
  const m2 = Math.hypot(v2x, v2y)
  if (m1 < 1e-6 || m2 < 1e-6) return null
  const cos = Math.min(1, Math.max(-1, dot / (m1 * m2)))
  return (Math.acos(cos) * 180) / Math.PI
}

/** `aspect` is the source frame's width / height. */
export function computeAngles(lm: NormalizedLandmark[], aspect: number): JointAngles {
  const out: JointAngles = {}
  for (const j of JOINTS) out[j.name] = angleAt(lm, j.a, j.b, j.c, aspect)
  out[HEAD] = headYaw(lm, aspect)
  return out
}

export interface Comparison {
  /** 0–100, or null when there is nothing to compare against. */
  score: number | null
  levels: Record<string, Level>
  /** Labels of the worst-matching joints, most wrong first. */
  problems: string[]
}

/**
 * Thresholds are deliberately loose. Two-dimensional joint angles carry real
 * noise — landmark jitter, body proportions, camera height — and a learner who
 * is told "wrong" for a 20-degree difference stops trusting the feedback, which
 * costs more than the precision is worth.
 */
const OK_DEG = 25
const WARN_DEG = 50
const MAX_DEG = 90

export function compareAngles(user: JointAngles, target: JointAngles | null, mirrored: boolean): Comparison {
  const levels: Record<string, Level> = {}
  const errs: { label: string; err: number }[] = []
  let sum = 0
  let n = 0
  for (const j of JOINTS) {
    const u = user[j.name]
    const t = target?.[mirrored ? j.mirror : j.name]
    if (u == null || t == null) {
      levels[j.name] = 'na'
      continue
    }
    const err = Math.abs(u - t)
    levels[j.name] = err < OK_DEG ? 'ok' : err < WARN_DEG ? 'warn' : 'bad'
    sum += 1 - Math.min(err, MAX_DEG) / MAX_DEG
    n++
    if (err >= OK_DEG) errs.push({ label: j.label, err })
  }
  // Head turn is a signed direction, so mirroring negates it rather than
  // swapping it with the joint on the other side.
  const uh = user[HEAD]
  const thRaw = target?.[HEAD]
  const th = thRaw == null ? null : mirrored ? -thRaw : thRaw
  if (uh == null || th == null) {
    levels[HEAD] = 'na'
  } else {
    const err = Math.abs(uh - th)
    levels[HEAD] = err < OK_DEG ? 'ok' : err < WARN_DEG ? 'warn' : 'bad'
    sum += 1 - Math.min(err, MAX_DEG) / MAX_DEG
    n++
    if (err >= OK_DEG) errs.push({ label: HEAD_LABEL, err })
  }

  errs.sort((a, b) => b.err - a.err)
  return {
    score: n > 0 ? Math.round((sum / n) * 100) : null,
    levels,
    problems: errs.slice(0, 3).map((e) => e.label),
  }
}

/** One frame of the reference, kept so the comparison can tolerate lag. */
export interface TargetFrame {
  /** Video time in seconds. */
  t: number
  angles: JointAngles
}

export interface TimedComparison extends Comparison {
  /**
   * How far behind the reference the best match was, in video seconds.
   * Null when there was nothing to compare against.
   */
  lag: number | null
}

/**
 * Scores the dancer against a window of recent reference frames rather than
 * the single current one.
 *
 * Someone learning a routine is always behind it — they watch, then react, then
 * move. Comparing frame to frame punishes that delay as if it were the wrong
 * move, which is both wrong and discouraging: at ordinary tempo a third of a
 * second is already a different pose. Searching back over the last second finds
 * the pose they are actually copying, which separates "wrong shape" from
 * "right shape, late" — and the delay is worth reporting in its own right.
 */
export function compareToHistory(
  user: JointAngles,
  history: TargetFrame[],
  now: number,
  mirrored: boolean,
): TimedComparison {
  if (!history.length) return { ...compareAngles(user, null, mirrored), lag: null }
  let best: Comparison | null = null
  let bestAt = now
  // Newest first, so an equally good older match never wins over a fresh one.
  for (let i = history.length - 1; i >= 0; i--) {
    const c = compareAngles(user, history[i].angles, mirrored)
    if (c.score == null) continue
    if (!best || c.score > best.score!) {
      best = c
      bestAt = history[i].t
    }
  }
  if (!best) return { ...compareAngles(user, null, mirrored), lag: null }
  return { ...best, lag: Math.max(0, now - bestAt) }
}

/** Map per-joint levels onto per-connection colors for drawSkeleton. */
export function levelConnectionColors(levels: Record<string, Level>, palette: Record<Level, string>): Map<string, string> {
  const rank: Record<Level, number> = { na: 0, ok: 1, warn: 2, bad: 3 }
  const worst = new Map<string, Level>()
  for (const j of JOINTS) {
    const lv = levels[j.name] ?? 'na'
    for (const [a, b] of j.segs) {
      const key = `${a}-${b}`
      const cur = worst.get(key)
      if (!cur || rank[lv] > rank[cur]) worst.set(key, lv)
    }
  }
  const out = new Map<string, string>()
  for (const [key, lv] of worst) out.set(key, palette[lv])
  return out
}
