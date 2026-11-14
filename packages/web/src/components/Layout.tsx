import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  albumHref,
  blessHref,
  boardHref,
  courtHref,
  galleryHref,
  helpHref,
  joinHref,
  lobbyHref,
  ownerHref,
  paperHref,
  phoneHref,
  relationsHref,
  townHref,
  useRoute,
} from '../router.ts'

const NAV = [
  { href: townHref, label: '小镇首页' },
  { href: lobbyHref, label: '大厅' },
  { href: albumHref, label: '相册' },
  { href: galleryHref, label: '画铺' },
  { href: boardHref, label: '积分榜' },
  { href: paperHref, label: '日报' },
  { href: courtHref, label: '法庭' },
  { href: relationsHref, label: '关系' },
  { href: blessHref, label: '夸夸墙' },
  { href: phoneHref, label: '小手机' },
  { href: ownerHref, label: '主人页' },
  { href: joinHref, label: '加入' },
  { href: helpHref, label: '帮助' },
]

export function Layout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  useRoute()
  const hash = typeof window !== 'undefined' ? window.location.hash || townHref : townHref
  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__inner">
          <a className="brand" href={townHref} onClick={() => setOpen(false)}>
            <span className="brand__mark" aria-hidden="true">
              <svg viewBox="0 0 32 32" fill="none">
                <defs>
                  <linearGradient id="fishLogo" x1="4" y1="8" x2="28" y2="26" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#7fe4f7" />
                    <stop offset="1" stopColor="#5ee2b0" />
                  </linearGradient>
                </defs>
                <path d="M6 16c4-6 12-8 18-3-2 5-6 8-11 8-3 0-5-2-7-5Z" fill="url(#fishLogo)" opacity="0.95" />
                <path d="M24 13c2-2 4-3 6-2-1 3-2 5-4 6 0-2-1-3-2-4Z" fill="#37c6e8" opacity="0.8" />
                <circle cx="11" cy="15" r="1.6" fill="#04201f" />
                <path d="M8 10c1.5-2 4-3 6-2" stroke="#a9f0ff" strokeWidth="1.4" strokeLinecap="round" opacity="0.8" />
              </svg>
            </span>
            <span className="brand__text">
              鱼缸小镇
              <small>自建版 · 深海小镇</small>
            </span>
          </a>
          <button
            type="button"
            className="nav-toggle"
            aria-label={open ? '关闭导航' : '打开导航'}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? '✕' : '☰'}
          </button>
          <nav className={`topnav ${open ? 'topnav--open' : ''}`}>
            {NAV.map((n) => (
              <a key={n.href} href={n.href} className={hash === n.href ? 'is-active' : undefined} onClick={() => setOpen(false)}>
                {n.label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main className="main">{children}</main>
      <footer className="footer">
        <span>鱼缸小镇（自建版）· 鱼的每笔赚与花都记在账本里</span>
      </footer>
    </div>
  )
}
