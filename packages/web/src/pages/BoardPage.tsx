import { useMemo, useState } from 'react'
import { loadBoard } from '../api.ts'
import { useResource } from '../hooks.ts'
import { Avatar, Empty, KindBadge, Loading, SourceBadge } from '../components/ui.tsx'
import { fmtCoins, relTime } from '../format.ts'
import { fishHref } from '../router.ts'
import type { BoardEntry, BoardPayload } from '../types.ts'

type Metric = 'balance' | 'wins'

const MEDAL = ['🥇', '🥈', '🥉']

export function BoardPage() {
  const { loading, result } = useResource<BoardPayload>(loadBoard, [])
  const [metric, setMetric] = useState<Metric>('balance')

  const sorted = useMemo(() => {
    const entries = result?.data?.entries ?? []
    return [...entries].sort((a, b) => {
      if (metric === 'wins') return b.wins - a.wins || b.balance - a.balance
      return b.balance - a.balance || b.wins - a.wins
    })
  }, [result, metric])

  if (loading || !result) return <Loading label="正在统计积分…" />
  const note = result.data.note

  return (
    <div className="page">
      <section className="hero hero--slim">
        <div className="hero__head">
          <div>
            <p className="hero__eyebrow">LEADERBOARD</p>
            <h1 className="hero__title">
              积分榜<span aria-hidden="true">🏆</span>
            </h1>
            <p className="hero__sub">按鱼币、按胜场两种看法。点名字进鱼的主页看她的完整流水。</p>
          </div>
          <SourceBadge source={result.source} error={result.error} />
        </div>
      </section>

      <section className="panel">
        <header className="panel__head">
          <h2>排行</h2>
          <div className="segmented" role="tablist" aria-label="排名依据">
            <button
              type="button"
              role="tab"
              aria-selected={metric === 'balance'}
              className={`segmented__btn ${metric === 'balance' ? 'is-active' : ''}`}
              onClick={() => setMetric('balance')}
            >
              按鱼币
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={metric === 'wins'}
              className={`segmented__btn ${metric === 'wins' ? 'is-active' : ''}`}
              onClick={() => setMetric('wins')}
            >
              按胜场
            </button>
          </div>
        </header>

        {sorted.length === 0 ? (
          <Empty>还没有鱼上榜。</Empty>
        ) : (
          <div className="table-wrap">
            <table className="ledger-table board-table">
              <thead>
                <tr>
                  <th className="ta-c">名次</th>
                  <th>鱼</th>
                  <th>类型</th>
                  <th className="ta-r">鱼币</th>
                  <th className="ta-r">胜 / 负</th>
                  <th className="ta-r">胜率</th>
                  <th className="ta-r">牌桌净赚</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((e, i) => (
                  <tr key={e.fishId} className={i < 3 ? 'board-row--top' : undefined}>
                    <td className="ta-c">
                      <span className="rank">{MEDAL[i] ?? i + 1}</span>
                    </td>
                    <td>
                      <a className="board-fish" href={fishHref(e.fishId)}>
                        <Avatar avatar="🐟" name={e.name} size={30} />
                        <span>{e.name}</span>
                      </a>
                    </td>
                    <td>
                      <KindBadge kind={e.kind} />
                    </td>
                    <td className="ta-r num">{fmtCoins(e.balance)}</td>
                    <td className="ta-r num">
                      {e.wins} / {e.losses}
                    </td>
                    <td className="ta-r">{formatRate(e)}</td>
                    <td className="ta-r">
                      <span className={e.net >= 0 ? 'delta delta--earn' : 'delta delta--spend'}>
                        {e.net > 0 ? '+' : ''}
                        {fmtCoins(e.net)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="panel__foot">
          {note ? `${note} ` : ''}更新于 {relTime(result.data.updatedAt)}。
        </p>
      </section>
    </div>
  )
}

function formatRate(e: BoardEntry): string {
  if (!e.wins && !e.losses) return '—'
  return `${Math.round(e.winRate * 100)}%`
}
