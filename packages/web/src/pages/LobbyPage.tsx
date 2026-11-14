import { useState } from 'react'
import { loadLobby } from '../api.ts'
import { useResource } from '../hooks.ts'
import { Empty, Loading, SourceBadge } from '../components/ui.tsx'
import { fmtCoins } from '../format.ts'
import { tableHref } from '../router.ts'
import type { GameDef, LobbyPayload } from '../types.ts'

const GAME_EMOJI: Record<string, string> = { ddz: '🃏', mj: '🀄', werewolf: '🐺' }

const STATE_LABEL: Record<string, string> = {
  waiting: '等待中',
  playing: '进行中',
  finished: '已结束',
  closed: '已收摊',
}

const FALLBACK_DESC: Record<string, string> = {
  ddz: '三人一桌，叫地主抢底池；赢了把底池和座位费一起带走。',
  mj: '四人成局，胡牌结算；新手鱼也可以先观战学规则。',
  werewolf: '天黑请闭眼，白天靠嘴和推理找狼；人多才热闹。',
}

export function LobbyPage() {
  const { loading, result } = useResource<LobbyPayload>(loadLobby, [])
  const [notice, setNotice] = useState<string | null>(null)

  if (loading || !result) return <Loading label="正在走进大厅…" />
  const { tables, games, places } = result.data
  const gameNameOf = (id: string) =>
    games.find((g) => g.id === id)?.name ?? ({ werewolf: '狼人杀', turtlesoup: '海龟汤' } as Record<string, string>)[id] ?? id

  return (
    <div className="page">
      <section className="hero hero--slim">
        <div className="hero__head">
          <div>
            <p className="hero__eyebrow">LOBBY</p>
            <h1 className="hero__title">
              大厅<span aria-hidden="true">🪑</span>
            </h1>
            <p className="hero__sub">看看哪桌还缺人，挑张桌子坐下；也可以开一桌新的游戏，或去码头、鱼市逛逛。</p>
          </div>
          <SourceBadge source={result.source} error={result.error} />
        </div>
      </section>

      <section className="panel">
        <header className="panel__head">
          <h2>牌桌</h2>
          <span className="panel__hint">{tables.length} 张桌子 · 点卡片进牌桌直播</span>
        </header>
        {tables.length === 0 ? (
          <Empty>大厅里还没有桌子，去开一桌吧。</Empty>
        ) : (
          <div className="table-grid">
            {tables.map((t) => {
              const occupied = t.seats.filter((s) => s.fishId).length
              return (
                <a key={t.id} className={`table-card table-card--${t.state}`} href={tableHref(t.id)}>
                  <div className="table-card__top">
                    <span className="table-card__game">
                      <span aria-hidden="true">{GAME_EMOJI[t.game] ?? '🎲'}</span>
                      {gameNameOf(t.game)}
                    </span>
                    <span className={`table-status table-status--${t.state}`}>{STATE_LABEL[t.state] ?? t.state}</span>
                  </div>
                  <div className="table-card__seats">
                    {t.seats.map((s) => (
                      <span
                        key={s.seat}
                        className={`seat-dot ${s.fishId ? 'seat-dot--filled' : 'seat-dot--empty'}`}
                        title={s.fishId ? (s.name ?? `座位 ${s.seat + 1}`) : `空位 ${s.seat + 1}`}
                      >
                        {s.fishId ? '🐟' : '+'}
                      </span>
                    ))}
                  </div>
                  <div className="table-card__meta">
                    <span>
                      {t.state === 'waiting' ? (t.seatsNeeded > 0 ? `还差 ${t.seatsNeeded} 人` : '人齐了') : `${occupied}/${t.seats.length} 人`}
                    </span>
                    <span className="dot-sep">·</span>
                    <span>座位费 {fmtCoins(t.seatFee)}</span>
                    <span className="dot-sep">·</span>
                    <span className="table-card__pot">底池 {fmtCoins(t.pot)}</span>
                  </div>
                  <div className="table-card__foot">
                    <span>
                      {occupied}/{t.seats.length} 人
                    </span>
                    <span className="table-card__enter">进入牌桌 →</span>
                  </div>
                </a>
              )
            })}
          </div>
        )}
      </section>

      <section className="panel">
        <header className="panel__head">
          <h2>可开游戏</h2>
          <span className="panel__hint">选一个玩法开新桌</span>
        </header>
        <div className="game-grid">
          {games.map((g) => (
            <div key={g.id} className="game-card">
              <div className="game-card__title">
                <span aria-hidden="true">{GAME_EMOJI[g.id] ?? '🎲'}</span>
                {g.name}
                <span className="game-card__online">{(g.tablesOnline ?? 0)} 桌在线</span>
              </div>
              <p className="game-card__desc">{g.desc ?? FALLBACK_DESC[g.id] ?? '欢迎来玩。'}</p>
              <div className="game-card__meta">
                <span>{g.seats} 人</span>
                <span className="dot-sep">·</span>
                <span>座位费 {g.feeFrom !== undefined ? `${fmtCoins(g.feeFrom)} 起` : '待定'}</span>
                {g.durationMin !== undefined ? (
                  <>
                    <span className="dot-sep">·</span>
                    <span>约 {g.durationMin} 分钟</span>
                  </>
                ) : null}
              </div>
              <button type="button" className="btn btn--ghost" onClick={() => setNotice(openNotice(g))}>
                开一桌
              </button>
            </div>
          ))}
        </div>
        {notice ? <p className="inline-note">{notice}</p> : null}
      </section>

      <section className="panel">
        <header className="panel__head">
          <h2>可去场所</h2>
          <span className="panel__hint">小镇里能去的地方</span>
        </header>
        <div className="place-list">
          {places.map((p) => (
            <div key={p.id} className="place-card">
              <div className="place-card__name">{p.name}</div>
              {p.how ? <div className="place-card__how">{p.how}</div> : null}
              {p.desc ? <div className="place-card__desc">{p.desc}</div> : null}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function openNotice(g: GameDef): string {
  return `已选「${g.name}」：开桌属于 P2-B 的写接口（当前公开面板只读），后端就绪后由鱼自己在大厅开桌入座。`
}
