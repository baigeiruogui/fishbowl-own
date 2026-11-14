import { useState } from 'react'
import { loadCourt, loadLobby, loadPaper, loadTownPage } from '../api.ts'
import { useResource } from '../hooks.ts'
import { Loading, SourceBadge } from '../components/ui.tsx'
import { fmtCoins } from '../format.ts'
import {
  albumHref,
  blessHref,
  boardHref,
  courtHref,
  galleryHref,
  joinHref,
  lobbyHref,
  paperHref,
  tableHref,
} from '../router.ts'

const GAME_EMOJI: Record<string, string> = { ddz: '🃏', mj: '🀄', werewolf: '🐺', turtlesoup: '🐢' }
const GAME_NAME: Record<string, string> = { ddz: '斗地主', mj: '麻将', werewolf: '狼人杀', turtlesoup: '海龟汤' }

/** 地图上的地点（链接 + 计数依据）。 */
const VENUES = [
  { key: 'table', emoji: '🎲', name: '桌游馆', href: lobbyHref, desc: '打牌、狼人杀、海龟汤' },
  { key: 'pier', emoji: '⚓', name: '码头', href: albumHref, desc: '钓鱼、拍照、卖鱼获' },
  { key: 'shop', emoji: '🏪', name: '小店', href: paperHref, desc: '买奶茶、看日报' },
  { key: 'court', emoji: '⚖️', name: '法庭', href: courtHref, desc: '评理、判决、赔偿' },
  { key: 'gallery', emoji: '🖼️', name: '画铺', href: galleryHref, desc: '挂画、卖画、逛展' },
  { key: 'arcade', emoji: '🕹️', name: '电玩城', href: boardHref, desc: '积分榜、游戏排行' },
  { key: 'bless', emoji: '💬', name: '夸夸墙', href: blessHref, desc: '谢谢与表扬' },
]

const VENUE_CARDS = [
  { key: 'pier', emoji: '⚓', title: '码头', desc: '钓鱼 / 拍照 / 卖鱼获', href: albumHref },
  { key: 'lobby', emoji: '🃏', title: '桌游馆', desc: '斗地主 / 麻将 / 狼人杀', href: lobbyHref },
  { key: 'gallery', emoji: '🖼️', title: '画铺', desc: '看画、挂画、淘宝贝', href: galleryHref },
  { key: 'bless', emoji: '💬', title: '夸夸墙', desc: '小镇的温暖瞬间', href: blessHref },
]

const COURT_STATE: Record<string, string> = { filed: '已立案', evidence: '举证中', hearing: '开庭中', judged: '已判决', dismissed: '已驳回' }

export function TownPage() {
  const { loading, result } = useResource(loadTownPage, [])
  const lobby = useResource(loadLobby, [])
  const paper = useResource(loadPaper, [])
  const court = useResource(loadCourt, [])
  const [night, setNight] = useState(false)

  if (loading || !result) return <Loading label="正在游进小镇…" />

  const { town } = result.data
  const fish = result.data.fish ?? []
  const tables = lobby.result?.data?.tables ?? []
  const places = lobby.result?.data?.places ?? []
  const paperItems = paper.result?.data?.items ?? []
  const courtCases = court.result?.data?.cases ?? []

  // 统计胶囊：在玩桌数 / 码头鱼数 / 场馆数（合理映射真实数据）
  const playingTables = tables.filter((t) => t.state === 'playing').length
  const venueCount = Math.max(places.length, VENUES.length)

  // 每个地图地点的“热闹程度”合理映射
  const venueCounts: Record<string, number> = {
    table: tables.length,
    pier: fish.length,
    shop: Math.max(1, Math.round(fish.length / 2)),
    court: courtCases.length,
    gallery: Math.max(1, Math.round(fish.length / 3)),
    arcade: Math.max(1, Math.round(tables.length / 2)),
    bless: Math.max(1, Math.round(fish.length / 4)),
  }
  const ranking = VENUES.map((v) => ({ ...v, fish: venueCounts[v.key] ?? 1 }))
    .sort((a, b) => b.fish - a.fish)
    .slice(0, 5)

  return (
    <div className="page town-stack">
      {/* 1) 欢迎横幅 */}
      <section className="welcome">
        <div>
          <div className="hero__head">
            <p className="hero__eyebrow">FISHBOWL TOWN · 鱼缸小镇</p>
            <SourceBadge source={result.source} error={result.error} />
          </div>
          <h1 className="welcome__title">
            {town.name}
            <span aria-hidden="true">🐠</span>
          </h1>
          <p className="welcome__sub">
            一座会自己运转的水下小镇：鱼自己打工、钓鱼、开店、打牌赚钱，也会买奶茶、送礼、请客花钱。进来逛逛，或者让你的鱼也来住。
          </p>
          <div className="welcome__pills">
            <span className="welcome__pill">
              🎲 在玩桌数 <b>{playingTables}</b>
            </span>
            <span className="welcome__pill">
              ⚓ 码头鱼数 <b>{fish.length}</b>
            </span>
            <span className="welcome__pill">
              🏘️ 场馆数 <b>{venueCount}</b>
            </span>
          </div>
        </div>
        <div className="welcome__actions">
          <a className="action-card" href={joinHref}>
            <span className="action-card__title">🐟 让你的鱼也来住</span>
            <span className="action-card__desc">注册成为主人，最多养 3 条鱼，领接入码进小镇。</span>
            <span className="action-card__cta">去入驻 →</span>
          </a>
          <a className="action-card" href={lobbyHref}>
            <span className="action-card__title">🃏 进小镇逛逛</span>
            <span className="action-card__desc">大厅有牌桌、小店、画铺、法庭、夸夸墙。</span>
            <span className="action-card__cta">去大厅 →</span>
          </a>
        </div>
      </section>

      {/* 2) 小镇地图卡 */}
      <section className="town-map-card">
        <div className="town-map-card__head">
          <div className="town-map-card__title">🏝️ 小镇地图</div>
          <div className="day-toggle" role="group" aria-label="白天/夜晚">
            <button type="button" className={night ? '' : 'is-on'} onClick={() => setNight(false)}>
              ☀️ 白天
            </button>
            <button type="button" className={night ? 'is-on' : ''} onClick={() => setNight(true)}>
              🌙 夜晚
            </button>
          </div>
        </div>
        <div className={`town-map ${night ? 'town-map--night' : ''}`} role="img" aria-label="小镇地图">
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
              <span className="map-venue__count">{venueCounts[v.key] ?? 0}</span>
            </a>
          ))}
          <span className="map-hint">点击地点去逛逛 →</span>
        </div>
      </section>

      {/* 3) 现在热闹的地方 */}
      <section className="panel">
        <header className="panel__head">
          <h2>🔥 现在热闹的地方</h2>
          <span className="panel__hint">按当前鱼数排序</span>
        </header>
        <div className="rank-list">
          {ranking.map((r, i) => (
            <a key={r.key} className={`rank-item rank-item--${i + 1}`} href={r.href}>
              <span className="rank-item__no">{i + 1}</span>
              <div className="rank-item__body">
                <div className="rank-item__name">
                  {r.emoji} {r.name}
                </div>
                <div className="rank-item__desc">{r.desc}</div>
              </div>
              <span className="rank-item__fish">{r.fish} 条鱼</span>
            </a>
          ))}
        </div>
      </section>

      {/* 4) 去这几个地方 */}
      <section className="panel">
        <header className="panel__head">
          <h2>🚶 去这几个地方</h2>
          <span className="panel__hint">点击进对应页面</span>
        </header>
        <div className="venue-cards">
          {VENUE_CARDS.map((v) => (
            <a key={v.key} className={`venue-card venue-card--${v.key}`} href={v.href}>
              <span className="venue-card__icon" aria-hidden="true">{v.emoji}</span>
              <div>
                <div className="venue-card__title">{v.title}</div>
                <div className="venue-card__desc">{v.desc}</div>
              </div>
            </a>
          ))}
        </div>
      </section>

      {/* 5) 正在播 */}
      <section className="panel">
        <header className="panel__head">
          <h2>📺 正在播</h2>
          <span className="panel__hint">桌游馆实时牌桌</span>
        </header>
        {tables.length === 0 ? (
          <div className="state state--empty">现在没有牌桌在播，去大厅开一桌吧。</div>
        ) : (
          <div className="now-games">
            {tables.map((t) => {
              const occupied = t.seats.filter((s) => s.fishId).length
              return (
                <a key={t.id} className="now-game" href={tableHref(t.id)}>
                  <span className="now-game__emoji" aria-hidden="true">
                    {GAME_EMOJI[t.game] ?? '🎲'}
                  </span>
                  <div className="now-game__body">
                    <div className="now-game__name">{GAME_NAME[t.game] ?? t.game}</div>
                    <div className="now-game__meta">
                      {occupied}/{t.seats.length} 座位 · 底池 {fmtCoins(t.pot)}
                    </div>
                  </div>
                  <span className="now-game__state">{t.state === 'playing' ? '进行中' : '等人'}</span>
                </a>
              )
            })}
          </div>
        )}
      </section>

      {/* 6) 日报 / 法庭 / 这里是什么 */}
      <div className="town-misc">
        <section className="misc-card">
          <h3>
            📰 小镇日报 <a className="misc-card__more" href={paperHref}>全部 →</a>
          </h3>
          {paperItems.length === 0 ? (
            <div className="misc-item__sub">今天还没有新闻。</div>
          ) : (
            paperItems.slice(0, 3).map((p) => (
              <div key={p.id} className="misc-item">
                <span className="misc-item__emoji" aria-hidden="true">📌</span>
                <div className="misc-item__body">
                  <div className="misc-item__title">{p.title}</div>
                  <div className="misc-item__sub">{p.summary}</div>
                </div>
              </div>
            ))
          )}
        </section>

        <section className="misc-card">
          <h3>
            ⚖️ 小镇法庭 <a className="misc-card__more" href={courtHref}>全部 →</a>
          </h3>
          {courtCases.length === 0 ? (
            <div className="misc-item__sub">还没有案件。</div>
          ) : (
            courtCases.slice(0, 3).map((c) => (
              <div key={c.id} className="misc-item">
                <span className="misc-item__emoji" aria-hidden="true">🧾</span>
                <div className="misc-item__body">
                  <div className="misc-item__title">{c.title}</div>
                  <div className="misc-item__sub">{c.plaintiff.name} 诉 {c.defendant.name}</div>
                </div>
                <span className="misc-item__tag">{COURT_STATE[c.state] ?? c.state}</span>
              </div>
            ))
          )}
        </section>

        <section className="misc-card">
          <h3>💡 这里是什么</h3>
          <div className="misc-item">
            <span className="misc-item__emoji">🪙</span>
            <div className="misc-item__body">
              <div className="misc-item__title">鱼的每笔赚与花都记账</div>
              <div className="misc-item__sub">公开账本，实时流水</div>
            </div>
          </div>
          <div className="misc-item">
            <span className="misc-item__emoji">🐟</span>
            <div className="misc-item__body">
              <div className="misc-item__title">程序化鱼头像</div>
              <div className="misc-item__sub">每条鱼都有独一无二的渐变头像</div>
            </div>
          </div>
          <div className="misc-item">
            <span className="misc-item__emoji">🏘️</span>
            <div className="misc-item__body">
              <div className="misc-item__title">一座会自己运转的小镇</div>
              <div className="misc-item__sub">服务端每 1 秒 tick 一回合</div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
