import { useState } from 'react'
import { loadTownPage } from '../api.ts'
import { useResource } from '../hooks.ts'
import { Avatar, Delta, Empty, KindBadge, Loading, SourceBadge, Stat } from '../components/ui.tsx'
import { fmtCoins, reasonMeta, relTime } from '../format.ts'
import { fishHref } from '../router.ts'

const MINI_GAMES = [
  { id: 'rps', emoji: '✊', name: '猜拳', desc: '石头剪刀布，赢了赚鱼币', cmd: '/town rps' },
  { id: 'dice', emoji: '🎲', name: '骰子', desc: '比大小，点数说话', cmd: '/town dice' },
  { id: 'lottery', emoji: '🎁', name: '抽奖', desc: '每天 1 次，试试手气', cmd: '/town lottery' },
]

export function TownPage() {
  const { loading, result } = useResource(loadTownPage, [])
  const [gameNotice, setGameNotice] = useState<string | null>(null)
  if (loading || !result) return <Loading label="正在连接小镇…" />

  const { town, recent, fish } = result.data

  return (
    <div className="page">
      <section className="hero">
        <div className="hero__head">
          <div>
            <p className="hero__eyebrow">WELCOME TO</p>
            <h1 className="hero__title">
              {town.name}
              <span className="hero__wave" aria-hidden="true">
                🌊
              </span>
            </h1>
            <p className="hero__sub">
              一个鱼自己赚钱、也自己花钱的小镇。今天有 {town.onlineFish} 条鱼在线，账本一直在翻页。
            </p>
          </div>
          <SourceBadge source={result.source} error={result.error} />
        </div>

        <div className="stats-grid">
          <Stat
            label="在线鱼数"
            value={town.onlineFish}
            unit={`/ ${town.totalFish} 条`}
            tone="accent"
            hint="有镇民鱼在镇上活动"
          />
          <Stat
            label="今日赚到"
            value={`+${fmtCoins(town.today.earned)}`}
            unit={town.currency}
            tone="earn"
            hint="打工 / 卖鱼获 / 悬赏 / 赢钱"
          />
          <Stat
            label="今日花掉"
            value={`-${fmtCoins(town.today.spent)}`}
            unit={town.currency}
            tone="spend"
            hint="座位费 / 购物 / 送礼 / 社交"
          />
          <Stat
            label="今日净增"
            value={`${town.today.net >= 0 ? '+' : ''}${fmtCoins(town.today.net)}`}
            unit={town.currency}
            tone={town.today.net >= 0 ? 'earn' : 'spend'}
            hint="赚 − 花"
          />
        </div>
      </section>

      <section className="panel mini-games-panel">
        <header className="panel__head">
          <h2>小游戏</h2>
          <span className="panel__hint">鱼自己玩，赢了进钱包</span>
        </header>
        <div className="mini-games">
          {MINI_GAMES.map((g) => (
            <div key={g.id} className="mini-game-card">
              <div className="mini-game-card__emoji" aria-hidden="true">
                {g.emoji}
              </div>
              <div className="mini-game-card__body">
                <div className="mini-game-card__name">{g.name}</div>
                <div className="mini-game-card__desc">{g.desc}</div>
              </div>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setGameNotice(`「${g.name}」要在鱼的小手机 / 插件里玩（${g.cmd}），网页端先做入口占位。`)}
              >
                去玩
              </button>
            </div>
          ))}
        </div>
        {gameNotice ? <p className="inline-note">{gameNotice}</p> : null}
      </section>

      <div className="cols">
        <section className="panel">
          <header className="panel__head">
            <h2>最近动态</h2>
            <span className="panel__hint">全小镇账本流水</span>
          </header>
          {recent.length === 0 ? (
            <Empty>还没有任何流水，镇子刚开张。</Empty>
          ) : (
            <ul className="feed">
              {recent.map((item) => {
                const meta = reasonMeta(item.reason, item.delta)
                return (
                  <li key={item.id} className="feed__item">
                    <span className={`feed__icon feed__icon--${meta.kind}`} aria-hidden="true">
                      {meta.icon}
                    </span>
                    <div className="feed__body">
                      <div className="feed__line">
                        <a className="feed__fish" href={fishHref(item.fishId)}>
                          {item.fishName}
                        </a>
                        <span className="feed__reason">{meta.label}</span>
                        {item.ref ? <span className="feed__ref">· {item.ref}</span> : null}
                      </div>
                      <div className="feed__time">{relTime(item.ts)}</div>
                    </div>
                    <Delta value={item.delta} />
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="panel">
          <header className="panel__head">
            <h2>镇上的鱼</h2>
            <span className="panel__hint">点名片进鱼的主页看余额与流水</span>
          </header>
          {fish.length === 0 ? (
            <Empty>还没有鱼入住。</Empty>
          ) : (
            <div className="fish-list">
              {fish.map((f) => (
                <a key={f.id} className="fish-card" href={fishHref(f.id)}>
                  <Avatar avatar={f.avatar} name={f.name} size={44} />
                  <div className="fish-card__body">
                    <div className="fish-card__name">
                      {f.name}
                      <KindBadge kind={f.kind} />
                      {f.online ? <span className="online-dot" title="在线" /> : null}
                    </div>
                    <div className="fish-card__intro">{f.intro || '（还没有写名片）'}</div>
                  </div>
                  <div className="fish-card__balance">
                    <span className="num">{fmtCoins(f.balance)}</span>
                    <small>{town.currency}</small>
                  </div>
                </a>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
