import { loadTable } from '../api.ts'
import { usePolledResource } from '../hooks.ts'
import { Empty, Loading, SourceBadge } from '../components/ui.tsx'
import { ReportButton } from '../components/ReportButton.tsx'
import { fmtCoins, relTime } from '../format.ts'
import { lobbyHref } from '../router.ts'
import type { TableDetail } from '../types.ts'

const GAME_EMOJI: Record<string, string> = { ddz: '🃏', mj: '🀄', werewolf: '🐺' }
const GAME_NAME: Record<string, string> = { ddz: '斗地主', mj: '麻将', werewolf: '狼人杀' }

const STATE_LABEL: Record<string, string> = {
  waiting: '等待中',
  playing: '进行中',
  finished: '已结束',
  closed: '已收摊',
}

export function TablePage({ id }: { id: string }) {
  const { loading, result } = usePolledResource<TableDetail | null>(() => loadTable(id), [id], 5000)
  if (loading || !result) return <Loading label="正在连上牌桌…" />

  if (!result.data) {
    return (
      <div className="page">
        <div className="panel notfound">
          <h2>找不到这张牌桌</h2>
          <p>
            牌桌 <code>{id}</code> 不存在或已收摊。
          </p>
          <p>
            <a className="btn" href={lobbyHref}>
              ← 回大厅
            </a>
          </p>
        </div>
      </div>
    )
  }

  const t = result.data
  const occupied = t.seats.filter((s) => s.fishId).length
  const missing = Math.max(0, t.seats.length - occupied)
  const gameName = GAME_NAME[t.game] ?? t.game

  return (
    <div className="page">
      <div className="breadcrumb">
        <a href={lobbyHref}>大厅</a>
        <span aria-hidden="true">/</span>
        <span>
          {gameName} · {t.id}
        </span>
        <SourceBadge source={result.source} error={result.error} />
        <ReportButton targetType="table" targetId={t.id} />
      </div>

      <section className="hero hero--slim">
        <div className="hero__head">
          <div>
            <p className="hero__eyebrow">TABLE LIVE · 每 5 秒自动刷新</p>
            <h1 className="hero__title">
              <span aria-hidden="true">{GAME_EMOJI[t.game] ?? '🎲'}</span>
              {gameName}
              <span className={`table-status table-status--${t.state}`}>{STATE_LABEL[t.state] ?? t.state}</span>
            </h1>
            <p className="hero__sub">
              底池 <b>{fmtCoins(t.pot)}</b> 鱼币 · 座位费 {fmtCoins(t.seatFee)} · {occupied}/{t.seats.length} 人 ·{' '}
              {t.state === 'playing' && t.round > 0 ? `第 ${t.round} 局` : missing > 0 ? `还差 ${missing} 人` : '人齐了'}
            </p>
          </div>
          <div className="live-clock">
            <span className="live-dot" aria-hidden="true" />
            最后更新 {relTime(t.updatedAt)}
          </div>
        </div>
      </section>

      <div className="cols cols--table">
        <section className="panel">
          <header className="panel__head">
            <h2>座位</h2>
            <span className="panel__hint">{t.state === 'playing' ? '轮到座位 ' + (t.turnSeat === null ? '—' : t.turnSeat + 1) : '等待鱼入座'}</span>
          </header>
          <div className="table-stage">
            {t.seats.map((s) => (
              <div
                key={s.seat}
                className={`player-seat ${s.fishId ? 'player-seat--filled' : 'player-seat--empty'} ${
                  t.turnSeat === s.seat ? 'player-seat--turn' : ''
                }`}
              >
                <span className="player-seat__no">座位 {s.seat + 1}</span>
                <span className="player-seat__avatar" aria-hidden="true">
                  {s.fishId ? '🐟' : '+'}
                </span>
                <span className="player-seat__name">{s.fishId ? (s.name ?? '入座鱼') : '空位'}</span>
                <span className="player-seat__ready">{s.fishId ? (t.turnSeat === s.seat ? '出牌中' : '已入座') : '等鱼来'}</span>
                {t.turnSeat === s.seat ? <span className="player-seat__turn-tag">出牌中</span> : null}
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <header className="panel__head">
            <h2>牌桌信息</h2>
            <span className="panel__hint">实时局面</span>
          </header>
          <dl className="kv">
            <div>
              <dt>底池</dt>
              <dd className="kv__big">{fmtCoins(t.pot)} 鱼币</dd>
            </div>
            <div>
              <dt>座位费</dt>
              <dd>{fmtCoins(t.seatFee)} 鱼币 / 人</dd>
            </div>
            <div>
              <dt>人数</dt>
              <dd>
                {occupied}/{t.seats.length} 人
              </dd>
            </div>
            <div>
              <dt>局数</dt>
              <dd>{t.round > 0 ? `第 ${t.round} 局` : '尚未开局'}</dd>
            </div>
            <div>
              <dt>牌桌编号</dt>
              <dd className="mono">{t.id}</dd>
            </div>
          </dl>
        </section>
      </div>

      <section className="panel">
        <header className="panel__head">
          <h2>最近动作</h2>
          <span className="panel__hint">直播流（占位，留轮询钩子 usePolledResource）</span>
        </header>
        {t.lastActions.length === 0 ? (
          <Empty>牌桌还没有动作。</Empty>
        ) : (
          <ol className="action-feed">
            {t.lastActions.map((a, i) => (
              <li key={`${a.ts}-${i}`} className="action-feed__item">
                <span className="action-feed__dot" aria-hidden="true" />
                <div className="action-feed__body">
                  <div className="action-feed__text">{a.text}</div>
                  <div className="action-feed__time">{relTime(a.ts)}</div>
                </div>
              </li>
            ))}
          </ol>
        )}
        <p className="panel__foot">
          页面每 5 秒静默刷新一次（页面不可见时暂停）。服务端 <code>/api/public/table/:id</code> 就绪后自动切入实时。
        </p>
      </section>
    </div>
  )
}
