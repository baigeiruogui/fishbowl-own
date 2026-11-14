import { loadPaper } from '../api.ts'
import { useResource } from '../hooks.ts'
import { Empty, Loading, SourceBadge } from '../components/ui.tsx'
import { relTime } from '../format.ts'
import { fishHref } from '../router.ts'
import type { PaperPayload } from '../types.ts'

/** 日报 kind → 展示标签。kind 与 server sim/paper.ts 的 kind 对齐。 */
function tagLabel(kind: string): string {
  switch (kind) {
    case 'money':
      return '经济'
    case 'games':
      return '牌桌'
    case 'bounty':
      return '悬赏'
    case 'shop':
      return '店铺'
    case 'notice':
      return '公告'
    case 'social':
      return '社交'
    case 'paper':
      return '日报'
    default:
      return kind
  }
}

function tagClass(kind: string): string {
  switch (kind) {
    case 'money':
      return 'paper-tag--money'
    case 'games':
      return 'paper-tag--table'
    case 'bounty':
      return 'paper-tag--bounty'
    case 'shop':
      return 'paper-tag--money'
    case 'notice':
      return 'paper-tag--notice'
    case 'social':
      return 'paper-tag--social'
    case 'paper':
      return 'paper-tag--default'
    default:
      return 'paper-tag--default'
  }
}

export function PaperPage() {
  const { loading, result } = useResource<PaperPayload>(loadPaper, [])
  if (loading || !result) return <Loading label="正在排版今天的日报…" />
  const { date, items } = result.data

  return (
    <div className="page">
      <section className="hero hero--slim">
        <div className="hero__head">
          <div>
            <p className="hero__eyebrow">DAILY PAPER</p>
            <h1 className="hero__title">
              鱼缸日报<span aria-hidden="true">📰</span>
            </h1>
            <p className="hero__sub">{date} · 今日要闻 {items.length} 条 · 由镇长办公室整理</p>
          </div>
          <SourceBadge source={result.source} error={result.error} />
        </div>
      </section>

      <section className="panel">
        <header className="panel__head">
          <h2>今日要闻</h2>
          <span className="panel__hint">按时间倒序</span>
        </header>
        {items.length === 0 ? (
          <Empty>今天还没有新闻，镇上一片平静。</Empty>
        ) : (
          <div className="paper-list">
            {items.map((it, i) => (
              <article key={it.id} className={`paper-item ${i === 0 ? 'paper-item--lead' : ''}`}>
                <div className="paper-item__head">
                  <span className={`paper-tag ${tagClass(it.kind)}`}>{tagLabel(it.kind)}</span>
                  <span className="paper-item__time">{relTime(it.ts)}</span>
                </div>
                <h3 className="paper-item__title">{it.title}</h3>
                <p className="paper-item__summary">{it.summary}</p>
                {it.fishId ? (
                  <a className="paper-item__fish" href={fishHref(it.fishId)}>
                    相关鱼 →
                  </a>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
