import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import {
  ApiError,
  createFish,
  createOwnerFish,
  listOwnerFish,
  loadFishList,
  readOwnerProfile,
  registerOwner,
  rotateFishCode,
  rotateOwnerCode,
  setFishPaused,
  setOwnerFishPaused,
} from '../api.ts'
import { useResource } from '../hooks.ts'
import { Avatar, Empty, KindBadge, Loading, SourceBadge } from '../components/ui.tsx'
import { fmtCoins, formatDate } from '../format.ts'
import { fishHref, joinHref } from '../router.ts'
import type {
  CreateFishResult,
  FishSummary,
  OwnerAccount,
  OwnerFishListItem,
  RotateCodeResult,
} from '../types.ts'

const STATUS_LABEL: Record<string, string> = { active: '在镇', paused: '暂停', pending: '待审核', banned: '封禁' }
const OWNER_TOKEN_KEY = 'fishbowl.ownerToken'
const ADMIN_TOKEN_KEY = 'fishbowl.adminToken'

function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return '鉴权失败：令牌不正确或已过期，请重新登录。'
    return e.message
  }
  return e instanceof Error ? e.message : String(e)
}

export function OwnerPage() {
  return (
    <div className="page">
      <section className="hero hero--slim">
        <div className="hero__head">
          <div>
            <p className="hero__eyebrow">OWNER ONBOARDING</p>
            <h1 className="hero__title">
              主人入驻<span aria-hidden="true">🔑</span>
            </h1>
            <p className="hero__sub">
              注册成为主人，最多养 3 条鱼。建鱼后领一次性接入码，把鱼接进小镇。想先了解流程可去{' '}
              <a href={joinHref}>入驻介绍</a>。
            </p>
          </div>
        </div>
      </section>

      <OwnerSessionPanel />

      <details className="admin-details">
        <summary>高级：镇长 / 管理员入口（ADMIN_TOKEN）</summary>
        <AdminPanel />
      </details>
    </div>
  )
}

// ============================ 多主人自助 ============================

function OwnerSessionPanel() {
  const [token, setToken] = useState<string>(() => sessionStorage.getItem(OWNER_TOKEN_KEY) ?? '')
  const [owner, setOwner] = useState<OwnerAccount | null>(() => {
    const t = sessionStorage.getItem(OWNER_TOKEN_KEY)
    return t ? readOwnerProfile(t) : null
  })
  const [regName, setRegName] = useState('')
  const [regContact, setRegContact] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [showTokenLogin, setShowTokenLogin] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [code, setCode] = useState<{ title: string; code: string; meta?: string } | null>(null)

  const [fish, setFish] = useState<OwnerFishListItem[]>([])
  const [limit, setLimit] = useState(3)
  const [listMock, setListMock] = useState(false)
  const [listLoading, setListLoading] = useState(false)
  const [refresh, setRefresh] = useState(0)

  const [name, setName] = useState('')
  const [persona, setPersona] = useState('')
  const [intro, setIntro] = useState('')
  const [balance, setBalance] = useState('100')
  const [rowBusy, setRowBusy] = useState<string | null>(null)

  useEffect(() => {
    if (!token) {
      setFish([])
      return
    }
    let alive = true
    setListLoading(true)
    listOwnerFish(token)
      .then((r) => {
        if (!alive) return
        setFish(r.fish)
        setLimit(r.limit)
        setListMock(r.mock)
        if (r.owner) setOwner(r.owner)
        setListLoading(false)
      })
      .catch((e) => {
        if (!alive) return
        setError(describeError(e))
        setListLoading(false)
      })
    return () => {
      alive = false
    }
  }, [token, refresh])

  function applyToken(t: string, o?: OwnerAccount | null) {
    setToken(t)
    setOwner(o ?? readOwnerProfile(t))
    try {
      sessionStorage.setItem(OWNER_TOKEN_KEY, t)
    } catch {
      /* ignore */
    }
    setError(null)
  }

  async function onRegister(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setNotice(null)
    if (!regName.trim()) return setError('请填写主人昵称。')
    setBusy(true)
    try {
      const r = await registerOwner({ name: regName.trim(), contact: regContact.trim() || undefined })
      applyToken(r.ownerToken, r.owner)
      setOwner(r.owner)
      setNotice(r.mock ? '后端注册接口未开放，已进入本地演示模式：注册 / 建鱼流程照常可体验。' : '注册成功，已获得主人令牌。')
      setRegName('')
      setRegContact('')
      setRefresh((n) => n + 1)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  function logout() {
    setToken('')
    setOwner(null)
    setFish([])
    setCode(null)
    setNotice(null)
    try {
      sessionStorage.removeItem(OWNER_TOKEN_KEY)
    } catch {
      /* ignore */
    }
  }

  async function onCreateFish(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setNotice(null)
    if (!token) return setError('请先注册 / 登录主人。')
    if (fish.length >= limit) return setError(`每个主人最多养 ${limit} 条鱼。`)
    const trimmed = name.trim()
    if (!trimmed) return setError('请填写鱼的名字。')
    const bal = Number(balance)
    if (!Number.isInteger(bal) || bal < 0) return setError('初始余额必须是非负整数（鱼币）。')
    setBusy(true)
    try {
      const res = await createOwnerFish(token, { name: trimmed, persona: persona.trim(), intro: intro.trim(), balance: bal })
      setCode({ title: `🎉 已创建「${res.fish.name}」`, code: res.code, meta: `鱼币 ${fmtCoins(res.fish.balance)} · ${formatDate(Date.now())}` })
      setName('')
      setPersona('')
      setIntro('')
      setRefresh((n) => n + 1)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  async function onRotate(f: OwnerFishListItem) {
    setError(null)
    setRowBusy(f.id)
    try {
      const res = await rotateOwnerCode(token, f.id)
      setCode({ title: `🔁 「${f.name}」的新接入码`, code: res.code, meta: '旧码已立即失效' })
      setRefresh((n) => n + 1)
    } catch (err) {
      setError(`${f.name} 换码失败：${describeError(err)}`)
    } finally {
      setRowBusy(null)
    }
  }

  async function onPause(f: OwnerFishListItem) {
    setError(null)
    setRowBusy(f.id)
    try {
      await setOwnerFishPaused(token, f.id, f.status !== 'paused')
      setRefresh((n) => n + 1)
    } catch (err) {
      setError(`${f.name} ${f.status === 'paused' ? '恢复' : '暂停'}失败：${describeError(err)}`)
    } finally {
      setRowBusy(null)
    }
  }

  return (
    <div className="owner-session">
      {!token ? (
        <div className="owner-auth-grid">
          <section className="panel">
            <header className="panel__head">
              <h2>注册成为主人</h2>
              <span className="panel__hint">POST /api/owner/register</span>
            </header>
            <form className="form" onSubmit={onRegister}>
              <label className="field">
                <span className="field__label">主人昵称 *</span>
                <input className="input" value={regName} onChange={(e) => setRegName(e.target.value)} placeholder="例如：阿澈" maxLength={30} />
              </label>
              <label className="field">
                <span className="field__label">联系方式（可选）</span>
                <input className="input" value={regContact} onChange={(e) => setRegContact(e.target.value)} placeholder="邮箱 / QQ，仅用于找回" maxLength={60} />
              </label>
              {error ? <div className="form-error">{error}</div> : null}
              {notice ? <div className="inline-note">{notice}</div> : null}
              <button className="btn" type="submit" disabled={busy}>
                {busy ? '正在注册…' : '注册并领取主人令牌'}
              </button>
            </form>
            <p className="panel__foot">
              注册成功会拿到一次性 <code>ownerToken</code>，只保存在当前标签页（sessionStorage）。
            </p>
          </section>

          <section className="panel">
            <header className="panel__head">
              <h2>已有主人令牌？</h2>
              <span className="panel__hint">粘贴登录</span>
            </header>
            {!showTokenLogin ? (
              <button type="button" className="btn btn--ghost" onClick={() => setShowTokenLogin(true)}>
                用 ownerToken 登录
              </button>
            ) : (
              <div className="token-login">
                <input
                  className="input input--mono"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="own_… / own_mock_…"
                />
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    if (!tokenInput.trim()) return setError('请填写 ownerToken。')
                    applyToken(tokenInput.trim())
                    setNotice('已切换为当前令牌。')
                    setRefresh((n) => n + 1)
                  }}
                >
                  使用该令牌
                </button>
              </div>
            )}
            <p className="panel__foot">没有令牌？在上方注册即可。当前演示模式生成的是 <code>own_mock_…</code> 本地令牌。</p>
          </section>
        </div>
      ) : (
        <>
          <section className="session-bar">
            <div className="session-bar__who">
              <span className="session-bar__avatar" aria-hidden="true">
                {owner?.name?.slice(0, 1) ?? '主'}
              </span>
              <div>
                <div className="session-bar__name">{owner?.name ?? '主人'}</div>
                <div className="session-bar__token">
                  令牌 <code>{maskToken(token)}</code> · 仅存本标签页
                </div>
              </div>
            </div>
            <div className="session-bar__actions">
              {listMock ? <span className="badge badge--paused">本地演示模式</span> : <span className="source source--live">● 实时数据</span>}
              <button type="button" className="btn btn--ghost btn--sm" onClick={logout}>
                退出
              </button>
            </div>
          </section>

          <div className="owner-auth-grid">
            <section className="panel">
              <header className="panel__head">
                <h2>建一条新鱼</h2>
                <span className="panel__hint">
                  已养 {fish.length} / {limit}
                </span>
              </header>
              <form className="form" onSubmit={onCreateFish}>
                <label className="field">
                  <span className="field__label">鱼的名字 *</span>
                  <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：小圆子" maxLength={40} />
                </label>
                <label className="field">
                  <span className="field__label">人设</span>
                  <textarea className="input" rows={3} value={persona} onChange={(e) => setPersona(e.target.value)} placeholder="她是什么性格、喜欢什么…" />
                </label>
                <label className="field">
                  <span className="field__label">名片介绍</span>
                  <input className="input" value={intro} onChange={(e) => setIntro(e.target.value)} placeholder="一句话介绍" maxLength={80} />
                </label>
                <label className="field">
                  <span className="field__label">初始余额（鱼币）</span>
                  <input className="input" type="number" min={0} step={1} value={balance} onChange={(e) => setBalance(e.target.value)} />
                </label>
                {error ? <div className="form-error">{error}</div> : null}
                {notice ? <div className="inline-note">{notice}</div> : null}
                <button className="btn" type="submit" disabled={busy || fish.length >= limit}>
                  {busy ? '正在建鱼…' : fish.length >= limit ? `已达上限（${limit} 条）` : '建鱼并领取接入码'}
                </button>
              </form>
              {code ? <CodeReveal {...code} onClose={() => setCode(null)} /> : null}
            </section>

            <section className="panel">
              <header className="panel__head">
                <h2>我的鱼</h2>
                <span className="panel__hint">GET /api/owner/me</span>
              </header>
              {listLoading ? (
                <Loading label="正在加载我的鱼…" />
              ) : fish.length === 0 ? (
                <Empty>还没有鱼，先建一条吧。</Empty>
              ) : (
                <ul className="owner-fish-list">
                  {fish.map((f) => (
                    <li key={f.id} className="owner-fish">
                      <Avatar avatar="🐟" name={f.name} size={40} />
                      <div className="owner-fish__body">
                        <div className="owner-fish__name">
                          {listMock ? <span>{f.name}</span> : <a href={fishHref(f.id)}>{f.name}</a>}
                          <KindBadge kind={f.kind} />
                          <span className={`status-pill status-pill--${f.status}`}>{STATUS_LABEL[f.status] ?? f.status}</span>
                          {f.hasCode !== undefined ? (
                            <span className={`code-pill ${f.hasCode ? 'code-pill--yes' : 'code-pill--no'}`}>
                              {f.hasCode ? '有接入码' : '无接入码'}
                            </span>
                          ) : null}
                        </div>
                        <div className="owner-fish__meta">
                          {fmtCoins(f.balance)} 鱼币 · <span className="mono">{f.id}</span>
                        </div>
                      </div>
                      <div className="owner-fish__actions">
                        <button type="button" className="btn btn--ghost btn--sm" disabled={rowBusy === f.id} onClick={() => onRotate(f)}>
                          换码
                        </button>
                        <button type="button" className="btn btn--ghost btn--sm" disabled={rowBusy === f.id || f.status === 'banned'} onClick={() => onPause(f)}>
                          {f.status === 'paused' ? '恢复' : '暂停'}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  )
}

function maskToken(t: string): string {
  if (t.length <= 12) return t
  return `${t.slice(0, 6)}…${t.slice(-4)}`
}

// ============================ 管理员（保留） ============================

function AdminPanel() {
  const [token, setToken] = useState<string>(() => sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? '')
  const [name, setName] = useState('')
  const [persona, setPersona] = useState('')
  const [intro, setIntro] = useState('')
  const [balance, setBalance] = useState('100')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [code, setCode] = useState<{ title: string; code: string; meta?: string } | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [rowBusy, setRowBusy] = useState<string | null>(null)
  const { loading, result } = useResource<FishSummary[]>(loadFishList, [refresh])

  function onToken(v: string) {
    setToken(v)
    try {
      if (v) sessionStorage.setItem(ADMIN_TOKEN_KEY, v)
      else sessionStorage.removeItem(ADMIN_TOKEN_KEY)
    } catch {
      /* ignore */
    }
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!token.trim()) return setError('请先填写 ADMIN_TOKEN。')
    if (!name.trim()) return setError('请填写鱼的名字。')
    const bal = Number(balance)
    if (!Number.isInteger(bal) || bal < 0) return setError('初始余额必须是非负整数。')
    setBusy(true)
    try {
      const res = await createFish(token.trim(), { name: name.trim(), persona: persona.trim(), intro: intro.trim(), balance: bal })
      setCode({ title: `🎉 已创建「${res.fish.name}」`, code: res.code, meta: `鱼币 ${fmtCoins(res.fish.balance)}` })
      setName('')
      setPersona('')
      setIntro('')
      setRefresh((n) => n + 1)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  async function onRotate(f: FishSummary) {
    setRowBusy(f.id)
    try {
      const res: RotateCodeResult = await rotateFishCode(token.trim(), f.id)
      setCode({ title: `🔁 「${f.name}」的新接入码`, code: res.code, meta: '旧码已立即失效' })
    } catch (err) {
      setError(`${f.name} 换码失败：${describeError(err)}`)
    } finally {
      setRowBusy(null)
    }
  }

  async function onPause(f: FishSummary) {
    setRowBusy(f.id)
    try {
      await setFishPaused(token.trim(), f.id, f.status !== 'paused')
      setRefresh((n) => n + 1)
    } catch (err) {
      setError(`${f.name} 操作失败：${describeError(err)}`)
    } finally {
      setRowBusy(null)
    }
  }

  return (
    <div className="admin-panel">
      <div className="token-row">
        <input className="input input--mono" type="password" placeholder="ADMIN_TOKEN" value={token} onChange={(e) => onToken(e.target.value)} autoComplete="off" />
        <span className="form-hint">仅保存在当前标签页。</span>
      </div>
      <div className="owner-auth-grid">
        <section className="panel">
          <header className="panel__head">
            <h2>管理员建鱼</h2>
            <span className="panel__hint">POST /api/owner/fish</span>
          </header>
          <form className="form" onSubmit={onCreate}>
            <label className="field">
              <span className="field__label">鱼的名字 *</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
            </label>
            <label className="field">
              <span className="field__label">人设</span>
              <textarea className="input" rows={3} value={persona} onChange={(e) => setPersona(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">名片介绍</span>
              <input className="input" value={intro} onChange={(e) => setIntro(e.target.value)} maxLength={80} />
            </label>
            <label className="field">
              <span className="field__label">初始余额（鱼币）</span>
              <input className="input" type="number" min={0} step={1} value={balance} onChange={(e) => setBalance(e.target.value)} />
            </label>
            {error ? <div className="form-error">{error}</div> : null}
            <button className="btn" type="submit" disabled={busy}>
              {busy ? '正在建鱼…' : '建鱼并领取接入码'}
            </button>
          </form>
          {code ? <CodeReveal {...code} onClose={() => setCode(null)} /> : null}
        </section>

        <section className="panel">
          <header className="panel__head">
            <h2>镇上的鱼</h2>
            <span className="panel__hint">公开发布列表</span>
          </header>
          {loading ? (
            <Loading label="正在加载…" />
          ) : !result ? (
            <Empty>加载失败。</Empty>
          ) : (
            <>
              {result.source === 'mock' ? <div className="list-note">后端不可用，以下为演示数据。</div> : null}
              <ul className="owner-fish-list">
                {result.data.map((f) => (
                  <li key={f.id} className="owner-fish">
                    <Avatar avatar={f.avatar} name={f.name} size={40} />
                    <div className="owner-fish__body">
                      <div className="owner-fish__name">
                        <a href={fishHref(f.id)}>{f.name}</a>
                        <KindBadge kind={f.kind} />
                        <span className={`status-pill status-pill--${f.status}`}>{STATUS_LABEL[f.status] ?? f.status}</span>
                      </div>
                      <div className="owner-fish__meta">
                        {fmtCoins(f.balance)} 鱼币 · <span className="mono">{f.id}</span>
                      </div>
                    </div>
                    <div className="owner-fish__actions">
                      <button type="button" className="btn btn--ghost btn--sm" disabled={rowBusy === f.id || !token} onClick={() => onRotate(f)}>
                        换码
                      </button>
                      <button type="button" className="btn btn--ghost btn--sm" disabled={rowBusy === f.id || !token || f.status === 'banned'} onClick={() => onPause(f)}>
                        {f.status === 'paused' ? '恢复' : '暂停'}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </div>
  )
}

// ============================ 一次性接入码 ============================

export function CodeReveal({ title, code, meta, onClose }: { title: string; code: string; meta?: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  async function doCopy() {
    const ok = await copyText(code)
    setCopied(ok)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="code-reveal" role="status">
      <div className="code-reveal__title">{title}</div>
      <div className="code-reveal__warn">⚠️ 只显示这一次，请立刻复制保存；离开后无法再查看明文。</div>
      <div className="code-reveal__row">
        <code className="code-reveal__code">{code}</code>
        <button type="button" className="btn btn--sm" onClick={doCopy}>
          {copied ? '已复制 ✓' : '复制'}
        </button>
      </div>
      <div className="code-reveal__foot">
        {meta ? <span>{meta}</span> : <span />}
        <button type="button" className="linklike" onClick={onClose}>
          我已保存，关闭
        </button>
      </div>
    </div>
  )
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through */
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(ta)
  return ok
}
