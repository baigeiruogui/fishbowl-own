import { useState } from 'react'
import { loadPhone } from '../api.ts'
import { useResource } from '../hooks.ts'
import { Avatar, Empty, Loading, SourceBadge } from '../components/ui.tsx'
import { relTime } from '../format.ts'
import { fishHref } from '../router.ts'
import { whenLabel } from './RelationsPage.tsx'
import type { PhoneConversation, PhoneMessage, PhonePayload } from '../types.ts'

const DATE_STATUS: Record<string, string> = { planned: '待赴约', done: '已完成', cancelled: '已取消' }

export function PhonePage() {
  const { loading, result } = useResource<PhonePayload>(loadPhone, [])
  const [selectedId, setSelectedId] = useState<string | null>(null)

  if (loading || !result) return <Loading label="正在打开小手机…" />
  const { conversations, dates, public: isPublic, note } = result.data
  const selected: PhoneConversation | undefined = conversations.find((c) => c.id === selectedId) ?? conversations[0]

  return (
    <div className="page">
      <section className="hero hero--slim">
        <div className="hero__head">
          <div>
            <p className="hero__eyebrow">LITTLE PHONE</p>
            <h1 className="hero__title">
              小手机<span aria-hidden="true">📱</span>
            </h1>
            <p className="hero__sub">和别的鱼发消息、约时间。对话是骨架，约会才是正经事。</p>
          </div>
          <SourceBadge source={result.source} error={result.error} />
        </div>
      </section>

      {isPublic === false ? <div className="inline-note">🔒 {note ?? '小手机的私信仅当事人可见'}</div> : null}

      <div className="phone-layout">
        <section className="panel phone-convs">
          <header className="panel__head">
            <h2>消息</h2>
            <span className="panel__hint">{conversations.length} 个会话</span>
          </header>
          {conversations.length === 0 ? (
            <Empty>还没有消息。</Empty>
          ) : (
            <ul className="conv-list">
              {conversations.map((c) => {
                const last = c.messages[c.messages.length - 1]
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      className={`conv ${selected?.id === c.id ? 'conv--active' : ''}`}
                      onClick={() => setSelectedId(c.id)}
                    >
                      <Avatar avatar={c.with.avatar ?? '🐟'} name={c.with.name} size={38} />
                      <div className="conv__body">
                        <div className="conv__top">
                          <span className="conv__name">{c.with.name}</span>
                          <span className="conv__time">{relTime(c.lastTs)}</span>
                        </div>
                        <div className="conv__preview">{last ? last.text : '还没有聊天记录'}</div>
                      </div>
                      {c.unread > 0 ? <span className="conv__unread">{c.unread}</span> : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="panel phone-chat">
          <header className="panel__head">
            <h2>{selected ? selected.with.name : '对话'}</h2>
            {selected ? <span className="panel__hint">和 {selected.with.name} 的对话</span> : null}
          </header>
          {selected ? (
            <div className="chat">
              <div className="chat__head">
                <Avatar avatar={selected.with.avatar ?? '🐟'} name={selected.with.name} size={40} />
                <div>
                  <a className="chat__name" href={fishHref(selected.with.fishId)}>
                    {selected.with.name}
                  </a>
                  <div className="chat__sub">点名字进鱼主页</div>
                </div>
              </div>
              <div className="chat__bubbles">
                {selected.messages.map((m) => (
                  <Bubble key={m.id} msg={m} />
                ))}
              </div>
              <div className="chat__composer">
                <input className="input" placeholder="说点什么…（P3 只读骨架）" disabled />
                <button className="btn btn--ghost" type="button" disabled>
                  发送
                </button>
              </div>
            </div>
          ) : (
            <Empty>选一个会话看看。</Empty>
          )}
        </section>
      </div>

      <section className="panel">
        <header className="panel__head">
          <h2>约会卡片</h2>
          <span className="panel__hint">{dates.length} 个安排</span>
        </header>
        {dates.length === 0 ? (
          <Empty>还没有约会安排。</Empty>
        ) : (
          <div className="date-grid">
            {dates.map((d) => (
              <div key={d.id} className={`date-card date-card--${d.status ?? 'planned'}`}>
                <div className="date-card__top">
                  <span className="date-card__title">{d.title}</span>
                  <span className={`plan-status plan-status--${d.status ?? 'planned'}`}>{DATE_STATUS[d.status ?? 'planned'] ?? d.status}</span>
                </div>
                <div className="date-card__with">
                  <Avatar avatar={d.with.avatar ?? '🐟'} name={d.with.name} size={26} />
                  <a href={fishHref(d.with.fishId)}>{d.with.name}</a>
                </div>
                <div className="date-card__meta">
                  {d.place ? <span>{d.place}</span> : null}
                  {d.place ? <span className="dot-sep">·</span> : null}
                  <span>{whenLabel(d.when)}</span>
                </div>
                {d.note ? <div className="date-card__note">{d.note}</div> : null}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function Bubble({ msg }: { msg: PhoneMessage }) {
  const mine = msg.from === 'me'
  return (
    <div className={`bubble-row ${mine ? 'bubble-row--me' : 'bubble-row--them'}`}>
      <div className={`bubble ${mine ? 'bubble--me' : 'bubble--them'}`}>
        <div className="bubble__text">{msg.text}</div>
        <div className="bubble__time">{relTime(msg.ts)}</div>
      </div>
    </div>
  )
}
