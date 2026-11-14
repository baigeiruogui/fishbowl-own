/**
 * 麻将基础（纯逻辑，无 IO / 无框架）。
 *
 * 牌模型：Tile{kind:'wan'|'tong'|'tiao'|'zi', rank:1..9 或字牌 1..7}
 *   - wan（万）/ tong（筒）/ tiao（条）：rank 1..9
 *   - zi（字牌）：rank 1..7（东南西北中发白）
 * 一副牌 136 张 = 3 门 * 9 种 * 4 + 7 字 * 4。
 */

export type TileKind = 'wan' | 'tong' | 'tiao' | 'zi'

export interface Tile {
  kind: TileKind
  rank: number
}

export type MeldKind = 'peng' | 'chi' | 'gang'

export interface Meld {
  kind: MeldKind
  tiles: Tile[]
}

export interface State {
  hand: Tile[]
  wall: Tile[]
  discards: Tile[]
  melds: Meld[]
}

const SUIT_KINDS: TileKind[] = ['wan', 'tong', 'tiao']
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffleTiles(tiles: Tile[], seed: number): Tile[] {
  const rnd = mulberry32(seed)
  const out = tiles.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

/** 生成 136 张牌墙（已按 seed 洗牌，可复现）。 */
export function createWall(seed = 1): Tile[] {
  const tiles: Tile[] = []
  for (const kind of SUIT_KINDS) {
    for (let rank = 1; rank <= 9; rank++) {
      for (let k = 0; k < 4; k++) tiles.push({ kind, rank })
    }
  }
  for (let rank = 1; rank <= 7; rank++) {
    for (let k = 0; k < 4; k++) tiles.push({ kind: 'zi', rank })
  }
  return shuffleTiles(tiles, seed)
}

/** 初始状态：牌墙已洗好，手牌/弃牌为空。 */
export function createState(seed = 1): State {
  return { hand: [], wall: createWall(seed), discards: [], melds: [] }
}

/** 从牌墙摸一张进手牌，返回新状态与所摸的牌；牌墙为空返回 null。 */
export function draw(state: State): { state: State; tile: Tile } | null {
  if (state.wall.length === 0) return null
  const wall = state.wall.slice()
  const tile = wall.pop() as Tile
  const hand = [...state.hand, tile]
  return { state: { ...state, wall, hand }, tile }
}

/** 打出一张手牌（移动到弃牌堆），返回新状态。牌不在手中则抛错。 */
export function discard(state: State, tile: Tile): State {
  const idx = state.hand.findIndex((t) => t.kind === tile.kind && t.rank === tile.rank)
  if (idx < 0) throw new Error('discard: tile not in hand')
  const hand = state.hand.slice()
  hand.splice(idx, 1)
  return { ...state, hand, discards: [...state.discards, tile] }
}

function tileKey(t: Tile): string {
  return `${t.kind}-${t.rank}`
}

function countTiles(tiles: Tile[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const t of tiles) {
    const k = tileKey(t)
    map.set(k, (map.get(k) ?? 0) + 1)
  }
  return map
}

function splitKey(key: string): { kind: TileKind; rank: number } {
  const [kind, rankStr] = key.split('-')
  return { kind: kind as TileKind, rank: Number(rankStr) }
}

const KIND_ORDER: Record<TileKind, number> = {
  wan: 0,
  tong: 1,
  tiao: 2,
  zi: 3,
}

function compareKey(a: string, b: string): number {
  const ka = splitKey(a)
  const kb = splitKey(b)
  if (ka.kind !== kb.kind) return KIND_ORDER[ka.kind] - KIND_ORDER[kb.kind]
  return ka.rank - kb.rank
}

function addKey(counts: Map<string, number>, key: string, delta: number): void {
  counts.set(key, (counts.get(key) ?? 0) + delta)
}

/**
 * 递归判断 counts 中的牌能否恰好拆成 need 个面子（刻子或顺子）。
 * 每次取剩余牌中「最小」的一张：它只能作为刻子的一部分，或作为顺子的起点。
 */
function decompose(counts: Map<string, number>, need: number): boolean {
  if (need === 0) {
    for (const v of counts.values()) {
      if (v !== 0) return false
    }
    return true
  }
  let first: string | null = null
  for (const [k, v] of counts) {
    if (v > 0 && (first === null || compareKey(k, first) < 0)) first = k
  }
  if (first === null) return false

  const parsed = splitKey(first)

  // 刻子
  if ((counts.get(first) ?? 0) >= 3) {
    addKey(counts, first, -3)
    const ok = decompose(counts, need - 1)
    addKey(counts, first, 3)
    if (ok) return true
  }

  // 顺子（仅数牌，rank <= 7 才能作为起点）
  if (parsed.kind !== 'zi' && parsed.rank <= 7) {
    const k2 = `${parsed.kind}-${parsed.rank + 1}`
    const k3 = `${parsed.kind}-${parsed.rank + 2}`
    if ((counts.get(k2) ?? 0) > 0 && (counts.get(k3) ?? 0) > 0) {
      addKey(counts, first, -1)
      addKey(counts, k2, -1)
      addKey(counts, k3, -1)
      const ok = decompose(counts, need - 1)
      addKey(counts, first, 1)
      addKey(counts, k2, 1)
      addKey(counts, k3, 1)
      if (ok) return true
    }
  }
  return false
}

function isSevenPairs(counts: Map<string, number>): boolean {
  let total = 0
  let pairs = 0
  for (const v of counts.values()) {
    total += v
    if (v % 2 !== 0) return false
    pairs += v / 2
  }
  return total === 14 && pairs === 7
}

/**
 * 判定基本胡牌：
 *   - 标准型：4 面子 + 1 将（若给出 melds，则需凑齐 4 - melds.length 个面子 + 1 将）
 *   - 七对（仅在没有副露且 14 张时）
 */
export function canWin(handTiles: Tile[], melds: Meld[] = []): boolean {
  const needSets = 4 - melds.length
  if (needSets < 0) return false
  const total = handTiles.length
  if (total !== needSets * 3 + 2) return false

  const counts = countTiles(handTiles)

  // 七对
  if (melds.length === 0 && isSevenPairs(counts)) return true

  // 标准型：枚举将牌
  const keys = [...counts.keys()]
  for (const key of keys) {
    if ((counts.get(key) ?? 0) >= 2) {
      addKey(counts, key, -2)
      const ok = decompose(counts, needSets)
      addKey(counts, key, 2)
      if (ok) return true
    }
  }
  return false
}
