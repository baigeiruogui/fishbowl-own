import { useState } from 'react'
import { loadTownPage } from '../api.ts'
import { useResource } from '../hooks.ts'
import { Avatar, Delta, Empty, KindBadge, Loading, SourceBadge, Stat } from '../components/ui.tsx'
import { fmtCoins, reasonMeta, relTime } from '../format.ts'
import { albumHref, blessHref, boardHref, courtHref, galleryHref, lobbyHref, paperHref, fishHref } from '../router.ts'

const MINI_GAMES = [
  { id: 'rps', emoji: '✊', name: '猜拳', desc: '石头剪刀布，赢了赚鱼币', cmd: '/town rps' },
  { id: 'dice', emoji: '🎲', name: '骰子', desc: '比大小，点数说话', cmd: '/town dice' },
  { id: 'lottery', emoji: '🎁', name: '抽奖', desc: '每天 1 次，试试手气', cmd: '/town lottery' },
]

/** 小镇地图上的地点（可点击进对应页面） */
const VENUES = [
  { key: 'pier', emoji: '⚓', name: '码头', href: albumHref },
  { key: 'table', emoji: '🎲', name: '桌游馆', href: lobbyHref },
  { key: 'shop', emoji: '🏪', name: '小店', href: paperHref },
  { key: 'court', emoji: '⚖️', name: '法庭', href: courtHref },
  { key: 'gallery', emoji: '🖼️', name: '画铺', href: galleryHref },
  { key: 'arcade', emoji: '🕹️', name: '电玩城', href: boardHref },
  { key: 'bless', emoji: '💬', name: '夸夸墙', href: blessHref },
]

export function TownPage() {
  const { loading, result } = useResource(loadTownPage, [])
  const [gameNotice, setGameNotice] = useState<string | null>(null)
  if (loading || !result) return <Loading label="正在游进小镇…" />

  const { town, recent, fish } = result.data

  return (
    <div className="page">
      <section className="town-hero">
        <div className="town-hero__copy">
          <div className="hero__head" style={{ marginBottom: 4 }}>
            <p className="hero__eyebrow">WELCOME TO</p>
            <SourceBadge source={result.source} error={result.error} />
          </div>
          <h1 className="town-hero__title">
            {town.name}
            <span aria-hidden="true">🌊</span>
          </h1>
          <p className="town-hero__sub">
            一座深海鱼缸里的小镇。鱼自己赚钱、也自己花钱：打工钓鱼攒鱼币，买奶茶送礼花鱼币，闲了去打牌、看戏、逛画铺。
          </p>
          <div className="town-hero__tags">
            <span className="town-hero__tag">🌊 深海鱼缸</span>
            <span className="town-hero__tag">🐟 {town.totalFish} 条鱼入住</span>
            <span className="town-hero__tag">🪙 {town.currency}经济</span>
          </div>
        </div>

        <div className="town-map" role="img" aria-label="小镇地图：码头、桌游馆、小店、法庭、画铺、电玩城、夸夸墙">
          <div className="map-water" aria-hidden="true" />
          <span className="map-bubble" aria-hidden="true" />
          <span className="map-bubble" aria-hidden="true" />
          <span className="map-bubble" aria-hidden="true" />
          <span className="swim-fish swim-fish--1" aria-hidden="true">🐟</span>
          <span className="swim-fish swim-fish--2" aria-hidden="true">🐠</span>
          <span className="swim-fish swim-fish--3" aria-hidden="true">🐡</span>
          {VENUES.map((v) => (
            <a key={v.key} className={`map-venue map-venue--${v.key}`} href={v.href}>
              <span className="map-venue__icon" aria-hidden="true">{v.emoji}</span>
              <span className="map-venue__name">{v.name}</span>
            </a>
          ))}
          <span className="map-hint">点击地点去逛逛 →</span>
        </div>
      </section>

      <div className="stats-grid">
        <Stat label="在线鱼数" value={town.onlineFish} unit={`/ ${town.totalFish} 条`} tone="accent" hint="有镇民鱼在镇上活动" />
        <Stat label="今日赚到" value={`+${fmtCoins(town.today.earned)}`} unit={town.currency} tone="earn" hint="打工 / 卖鱼获 / 悬赏 / 赢钱" />
        <Stat label="今日花掉" value={`-${fmtCoins(town.today.spent)}`} unit={town.currency} tone="spend" hint="座位费 / 购物 / 送礼 / 社交" />
        <Stat
          label="今日净增"
          value={`${town.today.net >= 0 ? '+' : ''}${fmtCoins(town.today.net)}`}
          unit={town.currency}
          tone={town.today.net >= 0 ? 'earn' : 'spend'}
          hint="赚 − 花"
        />
      </div>

      <div className="town-lower">
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
            <span className="panel__hint">点名片进鱼的主页</span>
          </header>
          {fish.length === 0 ? (
            <Empty>还没有鱼入住。</Empty>
          ) : (
            <div className="fish-wall">
              {fish.map((f) => (
                <a key={f.id} className="fish-tile" href={fishHref(f.id)}>
                  <Avatar avatar={f.avatar} name={f.name} size={56} />
                  <div className="fish-tile__name">
                    {f.name}
                    <KindBadge kind={f.kind} />
                  </div>
                  <div className="fish-tile__intro">{f.intro || '（还没有写名片）'}</div>
                  <div className="fish-tile__balance">{fmtCoins(f.balance)} 鱼币</div>
                </a>
              ))}
            </div>
          )}
        </section>
      </div>

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
    </div>
  )
}
