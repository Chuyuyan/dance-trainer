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


/**
 * A landmark with real depth. MediaPipe returns these alongside the projected
 * ones, in metres from the hips — the same pose gives the same numbers whatever
 * the camera is doing, which the flattened version cannot promise.
 */
export interface Landmark3 {
  x: number
  y: number
  z: number
  visibility?: number
}

type Vec = { x: number; y: number; z: number }

const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const mid = (a: Vec, b: Vec): Vec => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 })
const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y + a.z * b.z
const len = (a: Vec) => Math.hypot(a.x, a.y, a.z)
const unit = (a: Vec): Vec | null => {
  const l = len(a)
  return l < 1e-6 ? null : { x: a.x / l, y: a.y / l, z: a.z / l }
}

/** Key for the head's yaw inside a JointAngles map. */
export const HEAD = 'head'
export const HEAD_LABEL = 'head turn'

/**
 * Which way the head is turned, in degrees relative to the shoulders: 0
 * looking the same way the body faces, positive turned towards their own left,
 * ±90 in full profile.
 *
 * Measured in three dimensions and against the shoulder line, so it means the
 * same thing whatever the camera is doing — and "turned relative to the body"
 * is what a routine actually calls for. Ear landmarks are inferred rather than
 * seen once the head turns far, so treat this as a direction, not a precise
 * measurement.
 */
export function headYaw(lm: Landmark3[]): number | null {
  const nose = lm[LM.nose]
  const le = lm[LM.lEar]
  const re = lm[LM.rEar]
  const ls = lm[LM.lShoulder]
  const rs = lm[LM.rShoulder]
  if (!vis(nose) || !vis(le) || !vis(re) || !vis(ls) || !vis(rs)) return null
  // Where the face points, from the middle of the head outwards.
  const forward = unit(sub(nose, mid(le, re)))
  // The body's own left, so the result is head-relative-to-torso.
  const across = unit(sub(ls, rs))
  if (!forward || !across) return null
  return (Math.asin(Math.max(-1, Math.min(1, dot(forward, across)))) * 180) / Math.PI
}

const VIS_MIN = 0.4


function vis(lm: Landmark3) {
  return (lm.visibility ?? 1) >= VIS_MIN
}

function angleAt(lm: Landmark3[], a: number, b: number, c: number): number | null {
  if (!vis(lm[a]) || !vis(lm[b]) || !vis(lm[c])) return null
  const v1 = sub(lm[a], lm[b])
  const v2 = sub(lm[c], lm[b])
  const m1 = len(v1)
  const m2 = len(v2)
  if (m1 < 1e-6 || m2 < 1e-6) return null
  const cos = Math.min(1, Math.max(-1, dot(v1, v2) / (m1 * m2)))
  return (Math.acos(cos) * 180) / Math.PI
}

export function computeAngles(lm: Landmark3[]): JointAngles {
  const out: JointAngles = {}
  for (const j of JOINTS) out[j.name] = angleAt(lm, j.a, j.b, j.c)
  out[HEAD] = headYaw(lm)
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
