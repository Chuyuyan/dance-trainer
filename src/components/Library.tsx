import { formatDuration, type LibraryEntry } from '../lib/library'
import { T } from '../i18n'
import type { VideoStats } from '../playkitClient'

interface Props {
  entries: LibraryEntry[]
  stats: Map<string, VideoStats>
  currentId: string | null
  onOpen: (entry: LibraryEntry) => void
  onForget: (entry: LibraryEntry) => void
  /** Shown when the list is empty, i.e. before anything has been loaded. */
  emptyHint?: string
}

function when(ts: number): string {
  if (!ts) return ''
  const days = Math.floor((Date.now() - ts) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

export default function Library({ entries, stats, currentId, onOpen, onForget, emptyHint }: Props) {
  if (!entries.length) {
    return emptyHint ? <p className="library-empty">{emptyHint}</p> : null
  }

  return (
    <ul className="library">
      {entries.map((entry) => {
        const s = stats.get(entry.id)
        const missing = !entry.hasVideo
        return (
          <li
            key={entry.id}
            className={`library-item${entry.id === currentId ? ' is-current' : ''}${missing ? ' is-missing' : ''}`}
          >
            <button
              className="library-open"
              onClick={() => onOpen(entry)}
              title={missing ? `${entry.name} — pick this file again to reload it` : entry.name}
            >
              <span className="library-thumb">
                {entry.thumb ? <img src={entry.thumb} alt="" /> : <span className="library-thumb-blank" />}
                {entry.duration > 0 && <span className="library-time">{formatDuration(entry.duration)}</span>}
              </span>
              <span className="library-meta">
                <span className="library-name">{entry.name}</span>
                <span className="library-sub">
                  {missing ? T('not on this device') : when(entry.lastOpenedAt)}
                  {s ? ` · ${Math.max(1, Math.round(s.seconds / 60))} min · best ${s.bestMatch}` : ''}
                </span>
              </span>
            </button>
            <button
              className="library-forget"
              onClick={() => onForget(entry)}
              title={T('Remove from library')}
              aria-label={`Remove ${entry.name} from library`}
            >
              &times;
            </button>
          </li>
        )
      })}
    </ul>
  )
}
