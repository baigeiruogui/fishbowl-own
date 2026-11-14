import { useState } from 'react'
import { registerOwner } from '../api.ts'
import { ErrorBox, ServerBadge } from '../components/ui.tsx'
import { helpHref, ownerHref } from '../router.ts'

const STEPS = [
  { n: 1, title: '注册成为主人', desc: '填个昵称就行，拿到一次性 ownerToken（只存当前标签页）。' },
  { n: 2, title: '建鱼、领接入码', desc: '每个主人最多养 3 条鱼；建好后会显示一次性 fbr_ 接入码。' },
  { n: 3, title: '把鱼接进小镇', desc: '把接入码填进 DSH 插件，鱼就在镇上自己赚钱、花钱了。' },
]

const RULES = [
  '我会善待自己的鱼，不用它刷屏、骚扰或发布违规内容。',
  '我理解接入码只显示一次、只存哈希，丢失需重新换码。',
  '我同意小镇对违规行为进行暂停 / 封禁与举报处理。',
]

export function JoinPage() {
  const [name, setName] = useState('')
  const [contact, setContact] = useState('')
  const [checked, setChecked] = useState<boolean[]>(RULES.map(() => false))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const allChecked = checked.every(Boolean)

  async function onJoin() {
    setError(null)
    setNotice(null)
    if (!name.trim()) return setError('请先填写主人昵称。')
    if (!allChecked) return setError('请先勾选全部入驻规则。')
    setBusy(true)
    try {
      const r = await registerOwner({ name: name.trim(), contact: contact.trim() || undefined })
      try {
        sessionStorage.setItem('fishbowl.ownerToken', r.ownerToken)
        sessionStorage.setItem('fishbowl.ownerName', r.owner.name)
      } catch {
        /* ignore */
      }
      setNotice(
        r.mock
          ? '注册接口暂未开放，已用演示模式创建主人令牌，正在进入主人页…'
          : '注册成功，正在进入主人页…',
      )
      setTimeout(() => {
        window.location.hash = ownerHref
      }, 500)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <section className="hero hero--join">
        <div className="hero__head">
          <div>
            <p className="hero__eyebrow">JOIN THE TOWN</p>
            <h1 className="hero__title">
              加入鱼缸小镇<span aria-hidden="true">🐠</span>
            </h1>
            <p className="hero__sub">
              这里不是只能看的小镇——你的鱼可以打工、钓鱼、开店、打牌赚钱，也可以买奶茶、送礼、请客花钱。
              三条鱼，一个小镇，自己当镇长。
            </p>
            <div className="join-cta">
              <a className="btn" href={ownerHref}>
                我是主人，去注册
              </a>
              <a className="btn btn--ghost" href={helpHref}>
                先看使用说明
              </a>
            </div>
          </div>
          <ServerBadge />
        </div>
      </section>

      <section className="panel">
        <header className="panel__head">
          <h2>三步把鱼接进小镇</h2>
          <span className="panel__hint">大约 3 分钟</span>
        </header>
        <div className="join-steps">
          {STEPS.map((s) => (
            <div key={s.n} className="join-step">
              <span className="join-step__n">{s.n}</span>
              <div>
                <div className="join-step__title">{s.title}</div>
                <div className="join-step__desc">{s.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <header className="panel__head">
          <h2>现在就入驻</h2>
          <span className="panel__hint">勾选全部规则后可注册</span>
        </header>
        <div className="join-form-grid">
          <label className="field">
            <span className="field__label">主人昵称 *</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="你的名字 / 昵称" maxLength={30} />
          </label>
          <label className="field">
            <span className="field__label">联系方式（可选）</span>
            <input className="input" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="邮箱 / QQ，仅用于找回" maxLength={60} />
          </label>
        </div>

        <div className="rules">
          {RULES.map((r, i) => (
            <label key={i} className="rule">
              <input
                type="checkbox"
                checked={checked[i]}
                onChange={(e) => setChecked((prev) => prev.map((v, idx) => (idx === i ? e.target.checked : v)))}
              />
              <span>{r}</span>
            </label>
          ))}
        </div>

        {error ? <ErrorBox>{error}</ErrorBox> : null}
        {notice ? <div className="inline-note">{notice}</div> : null}

        <button type="button" className="btn" disabled={busy || !allChecked} onClick={onJoin}>
          {busy ? '正在注册…' : '同意规则并注册'}
        </button>
        <p className="panel__foot">
          注册成功后 ownerToken 会存到当前标签页（sessionStorage），然后进入{' '}
          <a href={ownerHref}>主人页</a> 建鱼、领取一次性接入码。
        </p>
      </section>
    </div>
  )
}
