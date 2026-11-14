import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { DataSource } from '../api.ts'
import { fmtDelta, isImageAvatar } from '../format.ts'

export function Avatar({ avatar, name, size = 48 }: { avatar: string; name: string; size?: number }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.55) }
  if (avatar && isImageAvatar(avatar)) {
    return <img className="avatar" style={style} src={avatar} alt={name} loading="lazy" />
  }
  return (
    <span className="avatar avatar--emoji" style={style} role="img" aria-label={name}>
      {avatar || name.slice(0, 1)}
    </span>
  )
}

export function Stat({
  label,
  value,
  unit,
  tone = 'neutral',
  hint,
}: {
  label: string
  value: ReactNode
  unit?: string
  tone?: 'neutral' | 'earn' | 'spend' | 'accent'
  hint?: string
}) {
  return (
    <div className={`stat stat--${tone}`}>
      <div className="stat__label">{label}</div>
      <div className="stat__value">
        {value}
        {unit ? <span className="stat__unit">{unit}</span> : null}
      </div>
      {hint ? <div className="stat__hint">{hint}</div> : null}
    </div>
  )
}

export function Delta({ value }: { value: number }) {
  const tone = value > 0 ? 'earn' : value < 0 ? 'spend' : 'neutral'
  return <span className={`delta delta--${tone}`}>{fmtDelta(value)}</span>
}

export function SourceBadge({ source, error }: { source: DataSource; error?: string }) {
  if (source === 'live') {
    return (
      <span className="source source--live" title="数据来自服务端 /api/public/*">
        ● 实时数据
      </span>
    )
  }
  return (
    <span className="source source--mock" title={error ? `后端未就绪，已用本地 mock 兜底：${error}` : '本地 mock 数据'}>
      ◐ 演示数据（mock）
    </span>
  )
}

/** 静态页（join/help）也显示真实服务端在线状态，避免“没有数据源”的歧义。 */
export function ServerBadge() {
  const [online, setOnline] = useState(false)
  useEffect(() => {
    let alive = true
    fetch('/api/public/ping', { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive) setOnline(!!d?.ok)
      })
      .catch(() => {
        if (alive) setOnline(false)
      })
    return () => {
      alive = false
    }
  }, [])
  return <SourceBadge source={online ? 'live' : 'mock'} error={online ? undefined : '服务端 ping 失败'} />
}

export function Loading({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="state state--loading" aria-busy="true">
      <div className="skeleton-wrap">
        <div className="skeleton skeleton--hero" />
        <div className="skeleton-row">
          <div className="skeleton skeleton--card" />
          <div className="skeleton skeleton--card" />
          <div className="skeleton skeleton--card" />
        </div>
        <div className="skeleton skeleton--line" style={{ width: '72%' }} />
        <div className="skeleton skeleton--line" style={{ width: '52%' }} />
      </div>
      <div className="skeleton-label">{label}</div>
    </div>
  )
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton-wrap" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton skeleton--line" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`.trim()}>{children}</section>
}

export function Badge({ tone = 'info', children }: { tone?: 'info' | 'earn' | 'spend' | 'gold'; children: ReactNode }) {
  const map = { info: 'source source--live', earn: 'source source--live', spend: 'source source--mock', gold: 'source source--mock' }
  return <span className={map[tone]}>{children}</span>
}

export function PageHeader({
  eyebrow,
  title,
  sub,
  actions,
  source,
  error,
}: {
  eyebrow?: string
  title: ReactNode
  sub?: ReactNode
  actions?: ReactNode
  source?: DataSource
  error?: string
}) {
  return (
    <section className="hero hero--slim">
      <div className="hero__head">
        <div>
          {eyebrow ? <p className="hero__eyebrow">{eyebrow}</p> : null}
          <h1 className="hero__title">{title}</h1>
          {sub ? <p className="hero__sub">{sub}</p> : null}
          {actions ? <div className="join-cta">{actions}</div> : null}
        </div>
        {source ? <SourceBadge source={source} error={error} /> : null}
      </div>
    </section>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="state state--empty">{children}</div>
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return <div className="form-error">{children}</div>
}

export function KindBadge({ kind }: { kind: 'resident' | 'npc' }) {
  return kind === 'npc' ? (
    <span className="kind kind--npc">NPC</span>
  ) : (
    <span className="kind kind--resident">镇民鱼</span>
  )
}
