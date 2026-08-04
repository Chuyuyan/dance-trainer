import { LM, type Level } from './skeleton'

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

export interface Vec {
  x: number
  y: number
  z: number
}

const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const mid = (a: Vec, b: Vec): Vec => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 })
const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y + a.z * b.z
const scale = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k, z: a.z * k })
const cross = (a: Vec, b: Vec): Vec => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})
const norm = (a: Vec) => Math.hypot(a.x, a.y, a.z)
const unit = (a: Vec): Vec | null => {
  const l = norm(a)
  return l < 1e-6 ? null : scale(a, 1 / l)
}

/**
 * One limb segment. Comparing where these point — rather than the angle at
 * each joint — is what makes the score mean anything.
 *
 * A joint angle is blind to direction: an arm held straight down and an arm
 * held straight overhead both read as a 180 degree elbow. Measured that way,
 * standing still scored 78 against a dancer with their arms up. A direction
 * tells them apart, and the joint angle is still implicit in the two segments
 * either side of a joint, so nothing is lost by the change.
 */
export interface BoneDef {
  name: string
  label: string
  /** The matching segment on the other side, for mirrored comparison. */
  mirror: string
  from: number
  to: number
}

export const BONES: BoneDef[] = [
  { name: 'lUpperArm', label: 'left upper arm', mirror: 'rUpperArm', from: LM.lShoulder, to: LM.lElbow },
  { name: 'lForearm', label: 'left forearm', mirror: 'rForearm', from: LM.lElbow, to: LM.lWrist },
  { name: 'rUpperArm', label: 'right upper arm', mirror: 'lUpperArm', from: LM.rShoulder, to: LM.rElbow },
  { name: 'rForearm', label: 'right forearm', mirror: 'lForearm', from: LM.rElbow, to: LM.rWrist },
  { name: 'lThigh', label: 'left thigh', mirror: 'rThigh', from: LM.lHip, to: LM.lKnee },
  { name: 'lShin', label: 'left shin', mirror: 'rShin', from: LM.lKnee, to: LM.lAnkle },
  { name: 'rThigh', label: 'right thigh', mirror: 'lThigh', from: LM.rHip, to: LM.rKnee },
  { name: 'rShin', label: 'right shin', mirror: 'lShin', from: LM.rKnee, to: LM.rAnkle },
]

/** Segment to paint for each bone, keyed as CONNECTIONS keys are. */
const BONE_SEGMENTS: Record<string, [number, number]> = {
  lUpperArm: [LM.lShoulder, LM.lElbow],
  lForearm: [LM.lElbow, LM.lWrist],
  rUpperArm: [LM.rShoulder, LM.rElbow],
  rForearm: [LM.rElbow, LM.rWrist],
  lThigh: [LM.lHip, LM.lKnee],
  lShin: [LM.lKnee, LM.lAnkle],
  rThigh: [LM.rHip, LM.rKnee],
  rShin: [LM.rKnee, LM.rAnkle],
}

export const HEAD = 'head'
export const HEAD_LABEL = 'head'

/** Where each limb points, in a frame carried by the body itself. */
export type PoseFeature = Record<string, Vec | null>

const VIS_MIN = 0.4
const vis = (lm: Landmark3 | undefined) => !!lm && (lm.visibility ?? 1) >= VIS_MIN

/**
 * Axes anchored to the torso: across the shoulders, up the spine, out of the
 * chest. Expressing limbs in this frame is what makes the comparison
 * independent of which way the dancer happens to be turned.
 */
function torsoFrame(lm: Landmark3[]): { lateral: Vec; up: Vec; forward: Vec } | null {
  const ls = lm[LM.lShoulder]
  const rs = lm[LM.rShoulder]
  const lh = lm[LM.lHip]
  const rh = lm[LM.rHip]
  if (!vis(ls) || !vis(rs) || !vis(lh) || !vis(rh)) return null
  const up = unit(sub(mid(ls, rs), mid(lh, rh)))
  if (!up) return null
  const across = sub(ls, rs) // towards their own left
  // Gram-Schmidt, so the axes stay square even when the shoulders are not.
  const lateral = unit(sub(across, scale(up, dot(across, up))))
  if (!lateral) return null
  return { lateral, up, forward: cross(lateral, up) }
}

export function computeFeature(lm: Landmark3[]): PoseFeature {
  const out: PoseFeature = {}
  const frame = torsoFrame(lm)
  if (!frame) {
    for (const b of BONES) out[b.name] = null
    out[HEAD] = null
    return out
  }
  const project = (v: Vec): Vec | null => {
    const u = unit(v)
    return u ? { x: dot(u, frame.lateral), y: dot(u, frame.up), z: dot(u, frame.forward) } : null
  }
  for (const b of BONES) {
    out[b.name] = vis(lm[b.from]) && vis(lm[b.to]) ? project(sub(lm[b.to], lm[b.from])) : null
  }
  const nose = lm[LM.nose]
  const le = lm[LM.lEar]
  const re = lm[LM.rEar]
  out[HEAD] = vis(nose) && vis(le) && vis(re) ? project(sub(nose, mid(le, re))) : null
  return out
}

/** Kept under the old name so the panels read unchanged. */
export const computeAngles = computeFeature

export interface Comparison {
  /** 0–100, or null when there is nothing to compare against. */
  score: number | null
  levels: Record<string, Level>
  /** Labels of the worst-matching limbs, most wrong first. */
  problems: string[]
}

/**
 * Tolerances in degrees of limb direction. Tighter than the joint-angle
 * numbers they replace, which had been loosened to paper over a perspective
 * error that no longer exists.
 */
const OK_DEG = 20
const WARN_DEG = 42
const MAX_DEG = 90

/** Reflect through the body's own midline: mirroring, in the torso frame. */
const reflect = (v: Vec): Vec => ({ x: -v.x, y: v.y, z: v.z })

const angleBetween = (a: Vec, b: Vec) =>
  (Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI

export function compareAngles(
  user: PoseFeature,
  target: PoseFeature | null,
  mirrored: boolean,
): Comparison {
  const levels: Record<string, Level> = {}
  const errs: { label: string; err: number }[] = []
  let sum = 0
  let n = 0

  const judge = (key: string, label: string, mine: Vec | null, theirsRaw: Vec | null) => {
    const theirs = theirsRaw && mirrored ? reflect(theirsRaw) : theirsRaw
    if (!mine || !theirs) {
      levels[key] = 'na'
      return
    }
    const err = angleBetween(mine, theirs)
    levels[key] = err < OK_DEG ? 'ok' : err < WARN_DEG ? 'warn' : 'bad'
    sum += 1 - Math.min(err, MAX_DEG) / MAX_DEG
    n++
    if (err >= OK_DEG) errs.push({ label, err })
  }

  for (const b of BONES) {
    judge(
      b.name,
      b.label,
      user[b.name] ?? null,
      target ? (target[mirrored ? b.mirror : b.name] ?? null) : null,
    )
  }
  judge(HEAD, HEAD_LABEL, user[HEAD] ?? null, target ? (target[HEAD] ?? null) : null)

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
  feature: PoseFeature
}

export interface TimedComparison extends Comparison {
  /** How far behind the reference this was, in video seconds. */
  lag: number | null
}

/** Carried between frames so the lag estimate can settle. */
export interface LagState {
  lag: number
}

/**
 * Scores against the reference as it was a moment ago, at a single lag that
 * moves slowly.
 *
 * Taking the best match anywhere in the window — which is what this did first —
 * quietly inflates every score: thirty candidate frames a second is thirty
 * chances to find a flattering one, so standing still went green whenever the
 * dancer passed through anything similar. Estimating one lag and easing it
 * keeps the tolerance for being late, while forcing the pose to match the frame
 * it claims to be copying.
 */
export function compareToHistory(
  user: PoseFeature,
  history: TargetFrame[],
  now: number,
  mirrored: boolean,
  state: LagState,
): TimedComparison {
  if (!history.length) return { ...compareAngles(user, null, mirrored), lag: null }

  let bestScore = -1
  let bestLag = state.lag
  for (const frame of history) {
    const c = compareAngles(user, frame.feature, mirrored)
    if (c.score == null) continue
    if (c.score > bestScore) {
      bestScore = c.score
      bestLag = now - frame.t
    }
  }
  // Ease towards it, so the lag describes the dancer rather than whichever
  // frame happened to flatter this instant.
  state.lag += (bestLag - state.lag) * 0.08
  const lag = Math.max(0, state.lag)

  let chosen = history[history.length - 1]
  let closest = Infinity
  for (const frame of history) {
    const d = Math.abs(now - frame.t - lag)
    if (d < closest) {
      closest = d
      chosen = frame
    }
  }
  return { ...compareAngles(user, chosen.feature, mirrored), lag }
}

/** Map per-limb levels onto per-connection colors for drawSkeleton. */
export function levelConnectionColors(
  levels: Record<string, Level>,
  palette: Record<Level, string>,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const b of BONES) {
    const seg = BONE_SEGMENTS[b.name]
    if (!seg) continue
    out.set(`${seg[0]}-${seg[1]}`, palette[levels[b.name] ?? 'na'])
  }
  return out
}
