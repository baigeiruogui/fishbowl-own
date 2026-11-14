import { useEffect, useMemo, useState } from 'react'
import { loadFishDetail } from '../api.ts'
import { useResource } from '../hooks.ts'
import { Avatar, Delta, Empty, Loading, SourceBadge, Stat } from '../components/ui.tsx'
import { ReportButton } from '../components/ReportButton.tsx'
import { fmtCoins, fmtDateTime, formatDate, reasonMeta, relTime } from '../format.ts'
import { fishHref, townHref } from '../router.ts'
import type { FishDetail } from '../types.ts'

const STATUS_LABEL: Record<string, string> = {
  active: '在镇',
  paused: '暂停',
  banned: '封禁',
}

export function FishPage({ id }: { id: string }) {
  const { loading, result } = useResource<FishDetail | null>(() => loadFishDetail(id), [id])
  const [reasonFilter, setReasonFilter] = useState<string | null>(null)

  // 切换到另一条鱼时重置分类筛选（同组件实例复用 state）。
  useEffect(() => {
    setReasonFilter(null)
  }, [id])

  const ledger = result?.data?.ledger ?? []
  const groups = useMemo(() => groupByReason(ledger), [ledger])
  const filtered = reasonFilter ? ledger.filter((e) => e.reason === reasonFilter) : ledger

  if (loading || !result) return <Loading label="正在打开鱼的主页…" />

  if (!result.data) {
    return (
      <div className="page">
        <div className="panel notfound">
          <h2>找不到这条鱼</h2>
          <p>
            没有 id 为 <code>{id}</code> 的鱼。也许她还没入住小镇。
          </p>
          <p>
            <a className="btn" href={townHref}>
              ← 回小镇首页
            </a>
          </p>
        </div>
      </div>
    )
  }

  const { fish, stats } = result.data

  return (
    <div className="page">
      <div className="breadcrumb">
        <a href={townHref}>小镇首页</a>
        <span aria-hidden="true">/</span>
        <span>{fish.name}</span>
        <SourceBadge source={result.source} error={result.error} />
        <ReportButton targetType="fish" targetId={fish.id} />
      </div>

      <section className="profile">
        <Avatar avatar={fish.avatar} name={fish.name} size={96} />
        <div className="profile__body">
          <div className="profile__title">
            <h1>{fish.name}</h1>
            <span className={`badge badge--${fish.status}`}>{STATUS_LABEL[fish.status] ?? fish.status}</span>
            {fish.kind === 'npc' ? <span className="kind kind--npc">NPC</span> : <span className="kind kind--resident">镇民鱼</span>}
            {fish.online ? <span className="online-dot" title="在线" /> : null}
          </div>
          <p className="profile__intro">{fish.intro || '（还没有写名片）'}</p>
          {fish.persona ? <p className="profile__persona">人设：{fish.persona}</p> : null}
          <dl className="profile__meta">
            <div>
              <dt>主人</dt>
              <dd>{fish.ownerName ?? '无主'}</dd>
            </div>
            <div>
              <dt>入住</dt>
              <dd>{formatDate(fish.createdAt)}</dd>
            </div>
            <div>
              <dt>每日消费上限</dt>
              <dd>{fish.dayCap == null ? '不限' : `${fmtCoins(fish.dayCap)} 鱼币`}</dd>
            </div>
          </dl>
        </div>
        <div className="profile__balance">
          <div className="profile__balance-label">当前余额</div>
          <div className="profile__balance-value">
            {fmtCoins(fish.balance)}
            <small>鱼币</small>
          </div>
          <div className="profile__balance-note">余额 = 账本 delta 之和</div>
        </div>
      </section>

      <div className="stats-grid stats-grid--sm">
        <Stat label="今日赚到" value={`+${fmtCoins(stats.todayEarned)}`} unit="鱼币" tone="earn" />
        <Stat label="今日花掉" value={`-${fmtCoins(stats.todaySpent)}`} unit="鱼币" tone="spend" />
        <Stat label="累计赚到" value={`+${fmtCoins(stats.totalEarned)}`} unit="鱼币" tone="earn" />
        <Stat label="累计花掉" value={`-${fmtCoins(stats.totalSpent)}`} unit="鱼币" tone="spend" />
        <Stat label="流水笔数" value={stats.entries} unit="笔" tone="neutral" />
      </div>

      <section className="panel">
        <header className="panel__head">
          <h2>赚钱 / 花钱分类</h2>
          <span className="panel__hint">点分类可筛选下方流水</span>
        </header>
        {groups.length === 0 ? (
          <Empty>还没有流水。</Empty>
        ) : (
          <div className="chips">
            <button
              type="button"
              className={`chip ${reasonFilter === null ? 'chip--active' : ''}`}
              onClick={() => setReasonFilter(null)}
            >
              全部 <span className="chip__count">{ledger.length}</span>
            </button>
            {groups.map((g) => {
              const meta = reasonMeta(g.reason, g.sum)
              return (
                <button
                  key={g.reason}
                  type="button"
                  className={`chip chip--${meta.kind} ${reasonFilter === g.reason ? 'chip--active' : ''}`}
                  onClick={() => setReasonFilter(reasonFilter === g.reason ? null : g.reason)}
                  title={`${meta.label}：${g.count} 笔`}
                >
                  <span aria-hidden="true">{meta.icon}</span>
                  {meta.label}
                  <span className="chip__count">{g.count}</span>
                  <span className={`chip__sum chip__sum--${partSign(g.sum)}`}>{signed(g.sum)}</span>
                </button>
              )
            })}
          </div>
        )}
      </section>

      <section className="panel">
        <header className="panel__head">
          <h2>流水明细</h2>
          <span className="panel__hint">
            {reasonFilter ? `${reasonMeta(reasonFilter).label} · ${filtered.length} 笔` : `共 ${ledger.length} 笔`}
          </span>
        </header>
        {filtered.length === 0 ? (
          <Empty>没有符合条件的流水。</Empty>
        ) : (
          <div className="table-wrap">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>类型</th>
                  <th>摘要</th>
                  <th className="ta-r">变动</th>
                  <th className="ta-r">余额</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => {
                  const meta = reasonMeta(e.reason, e.delta)
                  return (
                    <tr key={e.id}>
                      <td className="nowrap" title={new Date(e.ts).toLocaleString('zh-CN')}>
                        {relTime(e.ts)}
                        <div className="muted sm">{fmtDateTime(e.ts)}</div>
                      </td>
                      <td className="nowrap">
                        <span className={`tag tag--${meta.kind}`}>
                          <span aria-hidden="true">{meta.icon}</span>
                          {meta.label}
                        </span>
                      </td>
                      <td>{e.ref || <span className="muted">—</span>}</td>
                      <td className="ta-r">
                        <Delta value={e.delta} />
                      </td>
                      <td className="ta-r num">{fmtCoins(e.balanceAfter)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="panel__foot">
          想看别的鱼？<a href={fishHref(id)}>刷新本页</a> 或 <a href={townHref}>回小镇首页</a> 选一条。
        </p>
      </section>
    </div>
  )
}

interface ReasonGroup {
  reason: string
  count: number
  sum: number
}

function groupByReason(ledger: { reason: string; delta: number }[]): ReasonGroup[] {
  const map = new Map<string, ReasonGroup>()
  for (const e of ledger) {
    const g = map.get(e.reason) ?? { reason: e.reason, count: 0, sum: 0 }
    g.count += 1
    g.sum += e.delta
    map.set(e.reason, g)
  }
  // 先赚钱后花钱，各自按金额绝对值大→小。
  return [...map.values()].sort((a, b) => {
    const ka = reasonMeta(a.reason, a.sum).kind
    const kb = reasonMeta(b.reason, b.sum).kind
    if (ka !== kb) return ka === 'earn' ? -1 : 1
    return Math.abs(b.sum) - Math.abs(a.sum)
  })
}

function signed(n: number): string {
  return `${n > 0 ? '+' : ''}${n}`
}

function partSign(n: number): 'earn' | 'spend' | 'neutral' {
  return n > 0 ? 'earn' : n < 0 ? 'spend' : 'neutral'
}
