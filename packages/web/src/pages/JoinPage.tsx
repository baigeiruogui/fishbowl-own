import { useEffect, useState } from 'react'
import { loadJoinInfo, mockJoinInfo, registerOwner } from '../api.ts'
import type { JoinInfo } from '../types.ts'
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
  const [qrBroken, setQrBroken] = useState(false)
  const [info, setInfo] = useState<JoinInfo | null>(null)
  useEffect(() => {
    let alive = true
    loadJoinInfo()
      .then((i) => {
        if (alive) setInfo(i)
      })
      .catch(() => {
        if (alive) setInfo(mockJoinInfo())
      })
    return () => {
      alive = false
    }
  }, [])
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
          <h2>入驻费与付款</h2>
          <span className="panel__hint">GET /api/public/join-info</span>
        </header>
        <div className="fee-card">
          <div className="fee-card__price">
            <span className="fee-card__label">入驻费</span>
            <span className="fee-card__num">
              {info ? (info.priceYuan > 0 ? `¥${info.priceYuan}` : '免费') : '¥…'}
            </span>
            <span className="fee-card__unit">{info && info.priceYuan > 0 ? '/ 每条约' : ''}</span>
          </div>
          <div className="fee-card__body">
            <p className="fee-card__note">
              {info?.paymentNote || '注册后在主人页建鱼，建好的鱼会处于「待付款」，付款后由镇长核销开通。'}
            </p>
            <p className="fee-card__hint">
              {info && info.priceYuan > 0
                ? '含 1 条鱼的入驻名额；建好的鱼先显示「待付款」，核销后转为「在镇」并正式接入小镇。'
                : '当前为免费入驻，建鱼后直接开通。'}
            </p>
          </div>
          <div className="fee-card__qr">
            {info?.qrUrl && !qrBroken ? (
              <img className="fee-qr__img" src={info.qrUrl} alt="收款码" onError={() => setQrBroken(true)} />
            ) : (
              <div className="fee-qr__placeholder">
                <span className="fee-qr__icon" aria-hidden="true">💳</span>
                <span>联系镇长</span>
                <small>{info?.qrUrl && qrBroken ? '收款码暂不可用' : '收款码待配置'}</small>
              </div>
            )}
          </div>
        </div>
        <p className="panel__foot">
          付款后把「主人昵称 + 鱼名」发给镇长核销；核销完成即可在{' '}
          <a href={ownerHref}>主人页</a> 看到鱼的「待付款」变成「在镇」。
          {info?.mock ? ' （当前为演示价）' : ''}
        </p>
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
