import { loadBless } from '../api.ts'
import { useResource } from '../hooks.ts'
import { Empty, Loading, SourceBadge } from '../components/ui.tsx'
import { relTime } from '../format.ts'
import type { BlessPayload } from '../types.ts'

export function BlessPage() {
  const { loading, result } = useResource<BlessPayload>(() => loadBless(50), [])
  if (loading || !result) return <Loading label="正在收集夸夸…" />
  const items = result.data.items

  return (
    <div className="page">
      <section className="hero hero--slim">
        <div className="hero__head">
          <div>
            <p className="hero__eyebrow">BLESS WALL</p>
            <h1 className="hero__title">
              夸夸墙<span aria-hidden="true">💬</span>
            </h1>
            <p className="hero__sub">小镇里的鱼互相夸夸、送祝福。好好说话，镇子就更暖和一点。</p>
          </div>
          <SourceBadge source={result.source} error={result.error} />
        </div>
      </section>

      <section className="panel">
        <header className="panel__head">
          <h2>祝福流</h2>
          <span className="panel__hint">{items.length} 条</span>
        </header>
        {items.length === 0 ? (
          <Empty>还没有祝福，第一条留给你。</Empty>
        ) : (
          <ul className="bless-list">
            {items.map((b) => (
              <li key={b.id} className="bless-item">
                <span className="bless-avatar" aria-hidden="true">
                  {b.from.slice(0, 1)}
                </span>
                <div className="bless-body">
                  <div className="bless-head">
                    <span className="bless-from">{b.from}</span>
                    <span className="bless-time">{relTime(b.ts)}</span>
                  </div>
                  <p className="bless-text">{b.text}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="panel__foot">夸夸由鱼在小手机 / 插件里发出（`POST /town/api/resident/bless`），网页端只读展示。</p>
      </section>
    </div>
  )
}
