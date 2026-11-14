/**
 * 斗地主规则引擎（纯逻辑，无 IO / 无框架）。
 *
 * 牌面 rank 编码（3 最小，2 大，王炸最大）：
 *   3..10  -> 3..10
 *   11     -> J
 *   12     -> Q
 *   13     -> K
 *   14     -> A
 *   15     -> 2
 *   16     -> 小王（joker: true）
 *   17     -> 大王（joker: true）
 *
 * 说明：任务描述里「rank 3..17」的父注存在笔误，这里采用唯一自洽的编码：
 * 15 表示 2，16/17 表示大小王（均带 joker 字段）。整副牌 13*4 + 2 = 54 张。
 */

export type Suit = 'S' | 'H' | 'D' | 'C'

export interface Card {
  rank: number
  suit: Suit
  joker?: boolean
}

export type PlayType =
  | 'single'
  | 'pair'
  | 'triple'
  | 'triple_single'
  | 'triple_pair'
  | 'straight'
  | 'double_straight'
  | 'airplane'
  | 'four_two'
  | 'bomb'
  | 'rocket'

export interface Play {
  type: PlayType
  mainRank: number
  length: number
}

const NORMAL_RANKS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
const SUITS: Suit[] = ['S', 'H', 'D', 'C']
const SMALL_JOKER = 16
const BIG_JOKER = 17

/** 生成一副标准 54 张牌（未洗牌）。 */
export function createDeck(): Card[] {
  const deck: Card[] = []
  for (const rank of NORMAL_RANKS) {
    for (const suit of SUITS) {
      deck.push({ rank, suit })
    }
  }
  deck.push({ rank: SMALL_JOKER, suit: 'S', joker: true })
  deck.push({ rank: BIG_JOKER, suit: 'S', joker: true })
  return deck
}

/** 确定性伪随机数生成器（mulberry32），相同 seed 得到相同序列。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 洗牌，返回新数组（不修改入参）。相同 seed 结果可复现。 */
export function shuffle(deck: Card[], seed = 1): Card[] {
  const rnd = mulberry32(seed)
  const out = deck.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

export interface DealResult {
  /** 三家手牌，各 17 张 */
  hands: [Card[], Card[], Card[]]
  /** 3 张底牌 */
  bottom: Card[]
}

/**
 * 发牌：把一副（通常已洗好的）牌按轮次发给三家，各 17 张，剩余 3 张为底牌。
 * 不修改入参。
 */
export function deal(deck: Card[]): DealResult {
  const hands: [Card[], Card[], Card[]] = [[], [], []]
  const safe = deck.slice(0, 54)
  for (let i = 0; i < 51; i++) {
    hands[i % 3].push(safe[i])
  }
  const bottom = safe.slice(51, 54)
  return { hands, bottom }
}

function groupByRank(cards: Card[]): Map<number, Card[]> {
  const map = new Map<number, Card[]>()
  for (const c of cards) {
    const arr = map.get(c.rank)
    if (arr) arr.push(c)
    else map.set(c.rank, [c])
  }
  return map
}

function isConsecutive(ranks: number[]): boolean {
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i] !== ranks[i - 1] + 1) return false
  }
  return true
}

/** 判断牌集在「顺子」维度是否合法（3..A，即 3..14，连续）。 */
function isStraightRanks(ranks: number[]): boolean {
  if (ranks.length < 5) return false
  for (const r of ranks) {
    if (r < 3 || r > 14) return false
  }
  return isConsecutive(ranks)
}

function findTripleWindow(byRank: Map<number, Card[]>, m: number): number | null {
  for (let start = 3; start + m - 1 <= 14; start++) {
    let ok = true
    for (let r = start; r < start + m; r++) {
      if ((byRank.get(r)?.length ?? 0) !== 3) {
        ok = false
        break
      }
    }
    if (ok) return start
  }
  return null
}

function parseAirplane(
  byRank: Map<number, Card[]>,
  ranks: number[],
  n: number,
): Play | null {
  // 纯飞机：n 个连续三张（n >= 2）
  if (n % 3 === 0) {
    const m = n / 3
    if (m >= 2) {
      const start = findTripleWindow(byRank, m)
      if (start !== null && ranks.length === m) {
        return { type: 'airplane', mainRank: start, length: m }
      }
    }
  }
  // 飞机带单：m 个连续三张 + m 张单牌
  if (n % 4 === 0) {
    const m = n / 4
    if (m >= 2) {
      const start = findTripleWindow(byRank, m)
      if (start !== null) {
        return { type: 'airplane', mainRank: start, length: m }
      }
    }
  }
  // 飞机带对：m 个连续三张 + m 个对子
  if (n % 5 === 0) {
    const m = n / 5
    if (m >= 2) {
      const start = findTripleWindow(byRank, m)
      if (start === null) return null
      const rest = new Map<number, number>()
      for (const r of ranks) {
        if (r >= start && r <= start + m - 1) continue
        rest.set(r, byRank.get(r)!.length)
      }
      if (rest.size === m) {
        let allPairs = true
        for (const cnt of rest.values()) {
          if (cnt !== 2) {
            allPairs = false
            break
          }
        }
        if (allPairs) return { type: 'airplane', mainRank: start, length: m }
      }
    }
  }
  return null
}

/**
 * 识别一组牌的牌型。非法牌型返回 null。
 */
export function parsePlay(cards: Card[]): Play | null {
  if (!cards || cards.length === 0) return null
  const n = cards.length
  const byRank = groupByRank(cards)
  const ranks = [...byRank.keys()].sort((a, b) => a - b)

  // 王炸
  if (n === 2 && byRank.has(SMALL_JOKER) && byRank.has(BIG_JOKER)) {
    return { type: 'rocket', mainRank: BIG_JOKER, length: 2 }
  }
  // 炸弹
  if (n === 4 && ranks.length === 1) {
    return { type: 'bomb', mainRank: ranks[0], length: 4 }
  }
  if (n === 1) {
    return { type: 'single', mainRank: cards[0].rank, length: 1 }
  }
  if (n === 2) {
    if (ranks.length === 1 && !cards[0].joker) {
      return { type: 'pair', mainRank: ranks[0], length: 2 }
    }
    return null
  }
  if (n === 3) {
    if (ranks.length === 1 && !cards[0].joker) {
      return { type: 'triple', mainRank: ranks[0], length: 3 }
    }
    return null
  }
  if (n === 4) {
    // 三带一
    if (ranks.length === 2) {
      const c0 = byRank.get(ranks[0])!.length
      const c1 = byRank.get(ranks[1])!.length
      if ((c0 === 3 && c1 === 1) || (c0 === 1 && c1 === 3)) {
        const tripleRank = c0 === 3 ? ranks[0] : ranks[1]
        return { type: 'triple_single', mainRank: tripleRank, length: 4 }
      }
    }
    return null
  }
  if (n === 5) {
    // 三带一对
    if (ranks.length === 2) {
      const c0 = byRank.get(ranks[0])!.length
      const c1 = byRank.get(ranks[1])!.length
      if ((c0 === 3 && c1 === 2) || (c0 === 2 && c1 === 3)) {
        const tripleRank = c0 === 3 ? ranks[0] : ranks[1]
        return { type: 'triple_pair', mainRank: tripleRank, length: 5 }
      }
    }
  }
  // 顺子
  if (n >= 5 && ranks.length === n && isStraightRanks(ranks)) {
    return { type: 'straight', mainRank: ranks[0], length: n }
  }
  // 连对（>=3 对连续）
  if (n >= 6 && n % 2 === 0) {
    const pairCount = n / 2
    if (
      ranks.length === pairCount &&
      isConsecutive(ranks) &&
      ranks.every((r) => r >= 3 && r <= 14) &&
      ranks.every((r) => byRank.get(r)!.length === 2)
    ) {
      return { type: 'double_straight', mainRank: ranks[0], length: n }
    }
  }
  // 四带二
  if (n === 6 || n === 8) {
    const quadRank = ranks.find((r) => byRank.get(r)!.length === 4)
    if (quadRank !== undefined) {
      if (n === 6) {
        return { type: 'four_two', mainRank: quadRank, length: 6 }
      }
      const rest = cards.filter((c) => c.rank !== quadRank)
      const restBy = groupByRank(rest)
      if (restBy.size === 2 && [...restBy.values()].every((v) => v.length === 2)) {
        return { type: 'four_two', mainRank: quadRank, length: 8 }
      }
    }
  }
  // 飞机
  const air = parseAirplane(byRank, ranks, n)
  if (air) return air

  return null
}

/**
 * candidate 能否压过 last。
 * - last 为 null 表示任意合法出牌都能出。
 * - 王炸最大；炸弹压一切非炸弹，炸弹之间比大小；同类型同长度比 mainRank。
 */
export function canBeat(candidate: Play | null, last: Play | null): boolean {
  if (!candidate) return false
  if (!last) return true
  if (candidate.type === 'rocket') return last.type !== 'rocket'
  if (candidate.type === 'bomb') {
    if (last.type === 'rocket') return false
    if (last.type === 'bomb') return candidate.mainRank > last.mainRank
    return true
  }
  if (last.type === 'rocket' || last.type === 'bomb') return false
  if (candidate.type !== last.type) return false
  if (candidate.length !== last.length) return false
  return candidate.mainRank > last.mainRank
}

const TYPE_ORDER: Record<PlayType, number> = {
  single: 0,
  pair: 1,
  triple: 2,
  triple_single: 3,
  triple_pair: 4,
  straight: 5,
  double_straight: 6,
  airplane: 7,
  four_two: 8,
  bomb: 9,
  rocket: 10,
}

function consecutiveRuns(sorted: number[]): number[][] {
  const runs: number[][] = []
  let cur: number[] = []
  for (const r of sorted) {
    if (cur.length === 0 || r === cur[cur.length - 1] + 1) cur.push(r)
    else {
      if (cur.length > 0) runs.push(cur)
      cur = [r]
    }
  }
  if (cur.length > 0) runs.push(cur)
  return runs
}

function generateCandidates(hand: Card[]): Card[][] {
  const res: Card[][] = []
  const byRank = groupByRank(hand)
  const ranks = [...byRank.keys()].sort((a, b) => a - b)
  const rc = (r: number): Card[] => byRank.get(r)!

  // 单张 / 对子 / 三张 / 炸弹
  for (const r of ranks) {
    const cs = rc(r)
    res.push([cs[0]])
    if (cs.length >= 2) res.push(cs.slice(0, 2))
    if (cs.length >= 3) res.push(cs.slice(0, 3))
    if (cs.length >= 4) res.push(cs.slice(0, 4))
  }
  // 王炸
  if (byRank.has(SMALL_JOKER) && byRank.has(BIG_JOKER)) {
    res.push([rc(SMALL_JOKER)[0], rc(BIG_JOKER)[0]])
  }
  // 三带一 / 三带一对
  for (const r of ranks) {
    const cs = rc(r)
    if (cs.length < 3) continue
    const triple = cs.slice(0, 3)
    for (const r2 of ranks) {
      if (r2 === r) continue
      res.push([...triple, rc(r2)[0]])
      if (rc(r2).length >= 2) res.push([...triple, ...rc(r2).slice(0, 2)])
    }
  }
  // 顺子
  const suitRanks = ranks.filter((r) => r >= 3 && r <= 14)
  for (const run of consecutiveRuns(suitRanks)) {
    for (let L = 5; L <= run.length; L++) {
      for (let s = 0; s + L <= run.length; s++) {
        const win = run.slice(s, s + L)
        res.push(win.map((r) => rc(r)[0]))
      }
    }
  }
  // 连对
  const pairRanks = ranks.filter((r) => r >= 3 && r <= 14 && rc(r).length >= 2)
  for (const run of consecutiveRuns(pairRanks)) {
    for (let L = 3; L <= run.length; L++) {
      for (let s = 0; s + L <= run.length; s++) {
        const cards: Card[] = []
        for (const r of run.slice(s, s + L)) cards.push(...rc(r).slice(0, 2))
        res.push(cards)
      }
    }
  }
  // 飞机（纯）
  const tripleRanks = ranks.filter((r) => r >= 3 && r <= 14 && rc(r).length >= 3)
  for (const run of consecutiveRuns(tripleRanks)) {
    for (let L = 2; L <= run.length; L++) {
      for (let s = 0; s + L <= run.length; s++) {
        const cards: Card[] = []
        for (const r of run.slice(s, s + L)) cards.push(...rc(r).slice(0, 3))
        res.push(cards)
      }
    }
  }
  // 四带二（两单 / 两对）
  for (const r of ranks) {
    const cs = rc(r)
    if (cs.length < 4) continue
    const quad = cs.slice(0, 4)
    const rest = ranks.filter((x) => x !== r)
    for (let i = 0; i < rest.length; i++) {
      for (let j = i + 1; j < rest.length; j++) {
        res.push([...quad, rc(rest[i])[0], rc(rest[j])[0]])
      }
    }
    const pairR = rest.filter((x) => rc(x).length >= 2)
    for (let i = 0; i < pairR.length; i++) {
      for (let j = i + 1; j < pairR.length; j++) {
        res.push([...quad, ...rc(pairR[i]).slice(0, 2), ...rc(pairR[j]).slice(0, 2)])
      }
    }
  }
  return res
}

/**
 * 枚举手牌中所有能压过 last 的合法出牌（last 为 null 时枚举全部合法牌型）。
 * 结果按牌型从小到大排序，最多返回 limit 个（默认 200）。
 */
export function legalPlays(hand: Card[], last: Play | null, limit = 200): Card[][] {
  const candidates = generateCandidates(hand)
  const seen = new Set<string>()
  const out: Array<{ cards: Card[]; play: Play }> = []
  for (const cards of candidates) {
    const play = parsePlay(cards)
    if (!play) continue
    if (!canBeat(play, last)) continue
    const key = cards
      .map((c) => `${c.rank}${c.suit}`)
      .sort()
      .join(',')
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ cards, play })
  }
  out.sort((a, b) => {
    const t = TYPE_ORDER[a.play.type] - TYPE_ORDER[b.play.type]
    if (t !== 0) return t
    if (a.play.mainRank !== b.play.mainRank) return a.play.mainRank - b.play.mainRank
    return a.play.length - b.play.length
  })
  return out.slice(0, limit).map((o) => o.cards)
}
