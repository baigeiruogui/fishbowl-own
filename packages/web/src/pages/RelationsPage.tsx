import { loadRelations } from '../api.ts'
import { useResource } from '../hooks.ts'
import { Avatar, Empty, KindBadge, Loading, SourceBadge } from '../components/ui.tsx'
import { relTime } from '../format.ts'
import { fishHref } from '../router.ts'
import type { RelationPlan, RelationsPayload } from '../types.ts'

const PLAN_STATUS: Record<string, string> = { planned: '待赴约', done: '已完成', cancelled: '已取消' }

export function RelationsPage() {
  const { loading, result } = useResource<RelationsPayload>(loadRelations, [])
  if (loading || !result) return <Loading label="正在翻关系簿…" />
  const { friends, crush, plans } = result.data

  return (
    <div className="page">
      <section className="hero hero--slim">
        <div className="hero__head">
          <div>
            <p className="hero__eyebrow">RELATIONSHIPS</p>
            <h1 className="hero__title">
              关系<span aria-hidden="true">💞</span>
            </h1>
            <p className="hero__sub">好友、心上鱼、还有约好的那些小事——小镇里的鱼也有自己的社交圈。</p>
          </div>
          <SourceBadge source={result.source} error={result.error} />
        </div>
      </section>

      {crush ? (
        <section className="panel crush-panel">
          <header className="panel__head">
            <h2>心上鱼</h2>
            <span className="panel__hint">最想一起消磨时间的那条</span>
          </header>
          <div className="crush">
            <Avatar avatar={crush.avatar ?? '🐟'} name={crush.name} size={64} />
            <div className="crush__body">
              <div className="crush__name">
                <a href={fishHref(crush.fishId)}>{crush.name}</a>
                {crush.kind ? <KindBadge kind={crush.kind} /> : null}
                <span className="crush__heart" aria-hidden="true">
                  💗
                </span>
              </div>
              <div className="crush__note">{crush.note ?? '心里有你，嘴上不说。'}</div>
            </div>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <header className="panel__head">
          <h2>好友</h2>
          <span className="panel__hint">{friends.length} 位</span>
        </header>
        {friends.length === 0 ? (
          <Empty>还没有好友，去大厅认识几条鱼吧。</Empty>
        ) : (
          <div className="friend-grid">
            {friends.map((f) => (
              <a key={f.fishId} className="friend-card" href={fishHref(f.fishId)}>
                <Avatar avatar={f.avatar ?? '🐟'} name={f.name} size={44} />
                <div className="friend-card__body">
                  <div className="friend-card__name">
                    {f.name}
                    {f.kind ? <KindBadge kind={f.kind} /> : null}
                  </div>
                  <div className="friend-card__note">{f.note ?? '点头之交'}</div>
                </div>
              </a>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <header className="panel__head">
          <h2>约好的事</h2>
          <span className="panel__hint">{plans.length} 件</span>
        </header>
        {plans.length === 0 ? (
          <Empty>还没有约好的事。</Empty>
        ) : (
          <div className="plan-list">
            {plans.map((p) => (
              <PlanCard key={p.id} plan={p} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function PlanCard({ plan }: { plan: RelationPlan }) {
  return (
    <div className={`plan-card plan-card--${plan.status}`}>
      <div className="plan-card__top">
        <span className="plan-card__title">{plan.title}</span>
        <span className={`plan-status plan-status--${plan.status}`}>{PLAN_STATUS[plan.status] ?? plan.status}</span>
      </div>
      <div className="plan-card__meta">
        <span>
          与 <a href={fishHref(plan.with.fishId)}>{plan.with.name}</a>
        </span>
        {plan.place ? (
          <>
            <span className="dot-sep">·</span>
            <span>{plan.place}</span>
          </>
        ) : null}
        <span className="dot-sep">·</span>
        <span>{whenLabel(plan.when)}</span>
      </div>
    </div>
  )
}

/** 未来时间用「x 小时后 / 明天」，过去时间用相对时间。 */
export function whenLabel(ts: number): string {
  const diff = ts - Date.now()
  if (diff > 0) {
    const min = Math.round(diff / 60_000)
    if (min < 60) return `${min} 分钟后`
    const hr = Math.round(min / 60)
    if (hr < 24) return `${hr} 小时后`
    return `${Math.round(hr / 24)} 天后`
  }
  return relTime(ts)
}
