// 海龟汤（情景推理）纯引擎：题目卡 + 提问判定 + 猜谜底。
// 无 IO / 无框架 / 无外部依赖；抽卡随机可注入 rng / seed（默认 mulberry32）。
//
// 判定规则：
//  - 提问包含「谜底」原文 → 'correct'（等于猜中）
//  - 提问包含任一判定关键词 → 该关键词约定的 'yes' / 'no'
//  - 否则 → 'irrelevant'
// 猜谜底：guess(a) 对大小写 / 首尾空白不敏感，完全匹配才判对。

export interface SoupCard {
  id: string
  /** 谜面（情境） */
  riddle: string
  /** 谜底（真相） */
  answer: string
  /** 判定关键词：命中则按约定回答 */
  keywords: { word: string; answer: 'yes' | 'no' }[]
}

export type SoupAnswer = 'yes' | 'no' | 'irrelevant' | 'correct'

export interface TurtleSoupState {
  card: SoupCard
  /** 是否已猜中谜底 */
  solved: boolean
  /** 已提问次数（纯展示；由上层自增，引擎不主动改动） */
  asked: number
}

export interface TurtleSoupOptions {
  deck?: SoupCard[]
  rng?: () => number
  seed?: number
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const BUILTIN_DECK: SoupCard[] = [
  {
    id: 'soup_bar_water',
    riddle: '一个男人走进酒吧，点了一杯水。酒保却从柜台下掏出一把枪指着他。男人说了声「谢谢」，然后离开了。为什么？',
    answer: '男人在打嗝，酒保用枪吓唬他，把他的嗝吓停了。',
    keywords: [
      { word: '打嗝', answer: 'yes' },
      { word: '枪', answer: 'yes' },
      { word: '吓', answer: 'yes' },
      { word: '水', answer: 'yes' },
    ],
  },
  {
    id: 'soup_desert_match',
    riddle: '一个人死在沙漠里，头朝下，手里紧紧捏着半根火柴。周围没有脚印。为什么？',
    answer: '他和同伴乘热气球失重下坠，抽签决定谁跳下去减重，他抽中了短火柴。',
    keywords: [
      { word: '热气球', answer: 'yes' },
      { word: '抽签', answer: 'yes' },
      { word: '跳', answer: 'yes' },
      { word: '短', answer: 'yes' },
    ],
  },
  {
    id: 'soup_snow_blind',
    riddle: '一个盲人在雪地里被发现，手里握着一根燃尽的火柴。他明明可以生火取暖，为什么还是死了？',
    answer: '他划完了身上最后一根火柴，想靠火光向远处的人求救，却没人看见。',
    keywords: [
      { word: '盲人', answer: 'yes' },
      { word: '求救', answer: 'yes' },
      { word: '火柴', answer: 'yes' },
      { word: '生火', answer: 'yes' },
    ],
  },
  {
    id: 'soup_elevator_umbrella',
    riddle: '一个女人住在十楼。下雨天她坐电梯到十楼，晴天却只坐到七楼再走楼梯上去。为什么？',
    answer: '她个子矮，够不到十楼的按钮；下雨天有伞可以戳到按钮。',
    keywords: [
      { word: '矮', answer: 'yes' },
      { word: '个子', answer: 'yes' },
      { word: '伞', answer: 'yes' },
      { word: '按钮', answer: 'yes' },
    ],
  },
]

/** 返回内置题目卡的副本。 */
export function defaultSoupDeck(): SoupCard[] {
  return BUILTIN_DECK.map((c) => ({ ...c, keywords: c.keywords.map((k) => ({ ...k })) }))
}

/** 从 deck 抽一张卡（seed 可复现；rng 为 [0,1) 函数时用它选牌）。 */
export function drawSoupCard(deck: SoupCard[] = BUILTIN_DECK, rngOrSeed: (() => number) | number = 1): SoupCard {
  if (!Array.isArray(deck) || deck.length === 0) throw new Error('deck must be a non-empty array')
  const rng = typeof rngOrSeed === 'function' ? rngOrSeed : mulberry32(rngOrSeed)
  const idx = Math.floor(rng() * deck.length) % deck.length
  return deck[idx]!
}

/** 新开一局海龟汤：按 rng / seed 抽一张题卡。 */
export function createTurtleSoup(opts: TurtleSoupOptions = {}): TurtleSoupState {
  const deck = opts.deck && opts.deck.length > 0 ? opts.deck : BUILTIN_DECK
  const rng = opts.rng ?? mulberry32(opts.seed ?? 1)
  const card = drawSoupCard(deck, rng)
  return { card, solved: false, asked: 0 }
}

function normalize(text: unknown): string {
  return String(text ?? '').toLowerCase().trim()
}

/**
 * 提问判定：'yes' | 'no' | 'irrelevant' | 'correct'。纯函数，不修改 state。
 * 优先判定是否直接说出谜底（correct），再按关键词命中判定 yes/no。
 */
export function askQuestion(state: TurtleSoupState, question: string): SoupAnswer {
  const q = normalize(question)
  if (!q) return 'irrelevant'
  const answer = normalize(state.card.answer)
  if (q.includes(answer)) return 'correct'
  for (const k of state.card.keywords) {
    if (q.includes(normalize(k.word))) return k.answer
  }
  return 'irrelevant'
}

/** 猜谜底：大小写 / 首尾空白不敏感，完全匹配为对。纯函数，不修改 state。 */
export function guess(state: TurtleSoupState, answer: string): boolean {
  return normalize(answer) === normalize(state.card.answer)
}
