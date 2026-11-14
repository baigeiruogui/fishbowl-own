import { useState } from 'react'
import { loadCourt } from '../api.ts'
import { useResource } from '../hooks.ts'
import { Empty, Loading, SourceBadge } from '../components/ui.tsx'
import { relTime } from '../format.ts'
import type { CourtCase, CourtEventKind, CourtPayload } from '../types.ts'

const STATE_LABEL: Record<string, string> = {
  filed: '已立案',
  evidence: '举证中',
  hearing: '开庭中',
  jury: '陪审投票中',
  verdict: '已判决',
  judged: '已判决',
  dismissed: '已撤诉',
}

const EVENT_ICON: Record<string, string> = {
  file: '📝',
  evidence: '🔍',
  hearing: '⚖️',
  verdict: '🔨',
  dismissed: '🚫',
}

export function CourtPage() {
  const { loading, result } = useResource<CourtPayload>(loadCourt, [])
  const [selectedId, setSelectedId] = useState<string | null>(null)

  if (loading || !result) return <Loading label="正在打开法庭…" />
  const { cases } = result.data
  const selected: CourtCase | undefined = cases.find((c) => c.id === selectedId) ?? cases[0]

  return (
    <div className="page">
      <section className="hero hero--slim">
        <div className="hero__head">
          <div>
            <p className="hero__eyebrow">TOWN COURT</p>
            <h1 className="hero__title">
              法庭<span aria-hidden="true">⚖️</span>
            </h1>
            <p className="hero__sub">小镇里的纠纷都在这儿审：立案、举证、开庭、判决，一条案子一条时间线。</p>
          </div>
          <SourceBadge source={result.source} error={result.error} />
        </div>
      </section>

      {cases.length === 0 ? (
        <section className="panel">
          <Empty>今天法庭很清静，没有案子。</Empty>
        </section>
      ) : (
        <div className="cols court-cols">
          <section className="panel">
            <header className="panel__head">
              <h2>案件</h2>
              <span className="panel__hint">{cases.length} 件</span>
            </header>
            <ul className="court-list">
              {cases.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className={`court-case ${selected?.id === c.id ? 'court-case--active' : ''}`}
                    onClick={() => setSelectedId(c.id)}
                  >
                    <div className="court-case__top">
                      <span className="court-case__title">{c.title}</span>
                      <span className={`court-state court-state--${c.state}`}>{STATE_LABEL[c.state] ?? c.state}</span>
                    </div>
                    <div className="court-case__parties">
                      <span className="court-party court-party--plaintiff">原告 {c.plaintiff.name}</span>
                      <span className="court-vs">vs</span>
                      <span className="court-party court-party--defendant">被告 {c.defendant.name}</span>
                    </div>
                    <div className="court-case__meta">
                      {c.kind ? <span>{c.kind}</span> : null}
                      <span className="dot-sep">·</span>
                      <span>立案 {relTime(c.filedAt)}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          {selected ? (
            <section className="panel">
              <header className="panel__head">
                <h2>审判过程</h2>
                <span className={`court-state court-state--${selected.state}`}>{STATE_LABEL[selected.state] ?? selected.state}</span>
              </header>

              <div className="court-detail">
                <h3 className="court-detail__title">{selected.title}</h3>
                <div className="court-detail__parties">
                  <div>
                    <span className="court-detail__label">原告</span>
                    <span>{selected.plaintiff.name}</span>
                  </div>
                  <div>
                    <span className="court-detail__label">被告</span>
                    <span>{selected.defendant.name}</span>
                  </div>
                  {selected.kind ? (
                    <div>
                      <span className="court-detail__label">案由</span>
                      <span>{selected.kind}</span>
                    </div>
                  ) : null}
                </div>

                <ol className="timeline">
                  {selected.timeline.map((ev, i) => (
                    <li key={`${ev.ts}-${i}`} className={`timeline__item timeline__item--${ev.kind}`}>
                      <span className="timeline__dot" aria-hidden="true">
                        {EVENT_ICON[ev.kind as CourtEventKind] ?? '•'}
                      </span>
                      <div className="timeline__body">
                        <div className="timeline__head">
                          <span className="timeline__title">{ev.title}</span>
                          <span className="timeline__time">{relTime(ev.ts)}</span>
                        </div>
                        {ev.detail ? <p className="timeline__detail">{ev.detail}</p> : null}
                      </div>
                    </li>
                  ))}
                </ol>

                {selected.verdict ? (
                  <div className="verdict">
                    <span className="verdict__label">判决</span>
                    <span>{selected.verdict}</span>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  )
}
