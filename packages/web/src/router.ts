// 极简 hash 路由：#/ 小镇首页，#/fish/<id> 鱼主页，#/lobby 大厅，#/table/<id> 牌桌直播，
// #/board 积分榜，#/paper 日报，#/owner 主人入驻，#/court 法庭，#/relations 关系，#/phone 小手机，
// #/album 相册，#/gallery 画铺，#/bless 夸夸墙，#/join 入驻落地页，#/help 帮助。
import { useEffect, useState } from 'react'

export type Route =
  | { name: 'town' }
  | { name: 'fish'; id: string }
  | { name: 'lobby' }
  | { name: 'table'; id: string }
  | { name: 'board' }
  | { name: 'paper' }
  | { name: 'owner' }
  | { name: 'court' }
  | { name: 'relations' }
  | { name: 'phone' }
  | { name: 'album' }
  | { name: 'gallery' }
  | { name: 'bless' }
  | { name: 'join' }
  | { name: 'help' }
  | { name: 'notfound'; path: string }

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '')
  const path = raw.startsWith('/') ? raw : `/${raw}`
  const segs = path.split('/').filter(Boolean)
  if (segs.length === 0) return { name: 'town' }
  switch (segs[0]) {
    case 'fish':
      return segs[1] ? { name: 'fish', id: decodeURIComponent(segs[1]) } : { name: 'town' }
    case 'lobby':
      return { name: 'lobby' }
    case 'table':
      return segs[1] ? { name: 'table', id: decodeURIComponent(segs[1]) } : { name: 'lobby' }
    case 'board':
      return { name: 'board' }
    case 'paper':
      return { name: 'paper' }
    case 'owner':
      return { name: 'owner' }
    case 'court':
      return { name: 'court' }
    case 'relations':
      return { name: 'relations' }
    case 'phone':
      return { name: 'phone' }
    case 'album':
      return { name: 'album' }
    case 'gallery':
      return { name: 'gallery' }
    case 'bless':
      return { name: 'bless' }
    case 'join':
      return { name: 'join' }
    case 'help':
      return { name: 'help' }
    default:
      return { name: 'notfound', path }
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash))
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

export function fishHref(id: string): string {
  return `#/fish/${encodeURIComponent(id)}`
}

export function tableHref(id: string): string {
  return `#/table/${encodeURIComponent(id)}`
}

export const townHref = '#/'
export const lobbyHref = '#/lobby'
export const boardHref = '#/board'
export const paperHref = '#/paper'
export const ownerHref = '#/owner'
export const courtHref = '#/court'
export const relationsHref = '#/relations'
export const phoneHref = '#/phone'
export const albumHref = '#/album'
export const galleryHref = '#/gallery'
export const blessHref = '#/bless'
export const joinHref = '#/join'
export const helpHref = '#/help'
