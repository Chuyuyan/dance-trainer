import type { Section, SectionStat } from '../lib/library'

interface Props {
  sections: Section[]
  stats: Record<string, SectionStat> | undefined
  activeId: string | null
  onPlay: (section: Section) => void
  onRemove: (section: Section) => void
  onRename: (section: Section, name: string) => void
}

function clock(t: number): string {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * How much practice a phrase has had. Deliberately shows minutes and the mean
 * rather than a grade: the point is to see which phrase you have been avoiding.
 */
function summary(stat: SectionStat | undefined): string {
  if (!stat || !stat.samples) return 'not practised'
  const minutes = stat.seconds / 60
  const time = minutes >= 1 ? `${Math.round(minutes)} min` : `${Math.round(stat.seconds)}s`
  return `${time} · avg ${Math.round(stat.sumMatch / stat.samples)} · best ${Math.round(stat.bestMatch)}`
}

export default function SectionList({ sections, stats, activeId, onPlay, onRemove, onRename }: Props) {
  if (!sections.length) return null

  // The least practised phrase is the one worth pointing at.
  const practised = sections.map((s) => stats?.[s.id]?.seconds ?? 0)
  const most = Math.max(...practised, 1)

  return (
    <ul className="sections">
      {sections.map((section, i) => {
        const stat = stats?.[section.id]
        const share = (practised[i] / most) * 100
        return (
          <li key={section.id} className={`section${section.id === activeId ? ' is-active' : ''}`}>
            <button className="section-play" onClick={() => onPlay(section)} title="Loop this phrase">
              <span className="section-bar" style={{ width: `${share}%` }} aria-hidden="true" />
              <span className="section-body">
                <input
                  className="section-name"
                  value={section.name}
                  onChange={(e) => onRename(section, e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  aria-label="Section name"
                />
                <span className="section-sub">
                  {clock(section.start)}–{clock(section.end)} ({(section.end - section.start).toFixed(1)}s)
                  {' · '}
                  {summary(stat)}
                </span>
              </span>
            </button>
            <button
              className="section-remove"
              onClick={() => onRemove(section)}
              title="Remove section"
              aria-label={`Remove ${section.name}`}
            >
              &times;
            </button>
          </li>
        )
      })}
    </ul>
  )
}
