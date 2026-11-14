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
  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__inner">
          <a className="brand" href={townHref} onClick={() => setOpen(false)}>
            <span className="brand__mark" aria-hidden="true">
              🐠
            </span>
            <span className="brand__text">
              鱼缸小镇
              <small>自建版 · P3.5 小镇生活</small>
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
              <a key={n.href} href={n.href} onClick={() => setOpen(false)}>
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
