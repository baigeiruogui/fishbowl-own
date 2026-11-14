// 狼人杀基础状态机（纯逻辑，无 IO / 无框架 / 无外部依赖，随机可注入 rng）。
//
// 支持角色：村民 villager / 狼人 werewolf / 预言家 seer / 女巫 witch / 守卫 guard。
// 阶段流转：night（狼刀 → 预言家验人 → 女巫救/毒 → 守卫守人，齐活自动天亮）
//         → day（白天发言，纯展示，由 advancePhase 推进）
//         → vote（白天投票，所有人投完自动结算）
//         → night（下一夜）… 直到 checkWin 判胜：狼全灭=好人赢；狼数 >= 存活好人总数=狼赢。
//
// 所有函数返回新状态（不修改入参）；非法动作抛 Error，便于上层捕获。

export type WerewolfRole = 'werewolf' | 'villager' | 'seer' | 'witch' | 'guard'
export type WerewolfPhase = 'night' | 'day' | 'vote' | 'ended'
export type WerewolfWinner = 'good' | 'werewolf'

export interface WerewolfPlayer {
  id: string
  name?: string
  seat: number
  role: WerewolfRole
  alive: boolean
}

export interface WerewolfNightAction {
  role: 'werewolf'
  target: string
}

export interface WerewolfSeerAction {
  role: 'seer'
  target: string
}

export interface WerewolfWitchAction {
  role: 'witch'
  /** 救人目标（整局只能救一次）；不给 = 不救 */
  save?: string | null
  /** 毒人目标（整局只能毒一次）；不给 = 不毒 */
  poison?: string | null
}

export interface WerewolfGuardAction {
  role: 'guard'
  target: string
}

export type WerewolfAction = WerewolfNightAction | WerewolfSeerAction | WerewolfWitchAction | WerewolfGuardAction

export interface VoteRecord {
  voter: string
  target: string
}

export interface DeathRecord {
  /** 死亡发生在第几天（day） */
  day: number
  target: string
  cause: 'wolf' | 'poison' | 'vote'
}

export interface NightState {
  /** 第几夜（从 1 开始） */
  number: number
  wolfTarget: string | null
  seerChecked: string | null
  /** 预言家最近一次查验结果：目标是否为狼 */
  seerResult: boolean | null
  witchSave: string | null
  witchPoison: string | null
  /** 女巫本夜是否已经表态（可同时救+毒，或都跳过） */
  witchActed: boolean
  guardProtect: string | null
  /** 女巫解药是否已用（整局） */
  saveUsed: boolean
  /** 女巫毒药是否已用（整局） */
  poisonUsed: boolean
}

export interface WerewolfState {
  players: WerewolfPlayer[]
  phase: WerewolfPhase
  /** 当前第几天（从 1 开始） */
  day: number
  winner: WerewolfWinner | null
  votes: VoteRecord[]
  night: NightState
  deaths: DeathRecord[]
}

export interface WerewolfOptions {
  rng?: () => number
  /** 自定义角色表（长度必须等于玩家数，且狼与好人各至少一个） */
  roles?: WerewolfRole[]
  seed?: number
}

export interface WerewolfPlayerInput {
  id: string
  name?: string
}

/** mulberry32：确定性伪随机。 */
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

function shuffleInPlace<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = arr[i]!
    arr[i] = arr[j]!
    arr[j] = tmp
  }
  return arr
}

/** 默认角色表：按人数给 2-3 狼 + 预言家/女巫/守卫 + 其余村民。 */
export function defaultWerewolfRoles(n: number): WerewolfRole[] {
  if (!Number.isInteger(n) || n < 6) throw new Error('werewolf needs at least 6 players')
  const wolves = n >= 9 ? 3 : 2
  const roles: WerewolfRole[] = []
  for (let i = 0; i < wolves; i++) roles.push('werewolf')
  roles.push('seer', 'witch', 'guard')
  while (roles.length < n) roles.push('villager')
  return roles
}

function validateRoles(roles: WerewolfRole[], n: number): void {
  if (roles.length !== n) throw new Error('roles length must equal players length')
  if (!roles.includes('werewolf')) throw new Error('roles must include at least one werewolf')
  if (roles.every((r) => r === 'werewolf')) throw new Error('roles must include at least one good role')
}

function makeNight(number: number, saveUsed = false, poisonUsed = false): NightState {
  return {
    number,
    wolfTarget: null,
    seerChecked: null,
    seerResult: null,
    witchSave: null,
    witchPoison: null,
    witchActed: false,
    guardProtect: null,
    saveUsed,
    poisonUsed,
  }
}

/** 创建一局狼人杀：洗角色并派发。players 至少 6 人。 */
export function createWerewolf(
  players: WerewolfPlayerInput[],
  rngOrOptions?: (() => number) | WerewolfOptions,
): WerewolfState {
  if (!Array.isArray(players) || players.length < 6) {
    throw new Error('werewolf needs at least 6 players')
  }
  const opts: WerewolfOptions = typeof rngOrOptions === 'function' ? { rng: rngOrOptions } : (rngOrOptions ?? {})
  const rng = opts.rng ?? mulberry32(opts.seed ?? 1)
  const roles = opts.roles ? [...opts.roles] : defaultWerewolfRoles(players.length)
  validateRoles(roles, players.length)

  const assigned = shuffleInPlace(roles, rng)
  const state: WerewolfState = {
    players: players.map((p, i) => ({ id: p.id, name: p.name, seat: i, role: assigned[i]!, alive: true })),
    phase: 'night',
    day: 1,
    winner: null,
    votes: [],
    night: makeNight(1),
    deaths: [],
  }
  return state
}

function playerOf(state: WerewolfState, id: string): WerewolfPlayer | undefined {
  return state.players.find((p) => p.id === id)
}

function requireAliveRole(state: WerewolfState, role: WerewolfRole, what: string): WerewolfPlayer {
  const p = state.players.find((x) => x.role === role && x.alive)
  if (!p) throw new Error(`no alive ${role} to ${what}`)
  return p
}

function requireAlivePlayer(state: WerewolfState, id: string, what: string): WerewolfPlayer {
  const p = playerOf(state, id)
  if (!p) throw new Error(`${what}: unknown player ${id}`)
  if (!p.alive) throw new Error(`${what}: target ${id} is dead`)
  return p
}

/** 判定胜负（纯函数，可随时调用）：'good' | 'werewolf' | null。 */
export function checkWin(state: WerewolfState): WerewolfWinner | null {
  const alive = state.players.filter((p) => p.alive)
  const wolves = alive.filter((p) => p.role === 'werewolf').length
  const good = alive.length - wolves
  if (wolves === 0) return 'good'
  if (good === 0) return 'werewolf'
  if (wolves >= good) return 'werewolf'
  return null
}

function applyDeaths(state: WerewolfState, deadIds: { id: string; cause: DeathRecord['cause'] }[]): WerewolfState {
  if (deadIds.length === 0) return state
  const dead = new Map(deadIds.map((d) => [d.id, d.cause]))
  const players = state.players.map((p) => (p.alive && dead.has(p.id) ? { ...p, alive: false } : p))
  const deaths = [...state.deaths]
  for (const d of deadIds) deaths.push({ day: state.day, target: d.id, cause: d.cause })
  return { ...state, players, deaths }
}

function finishIfOver(state: WerewolfState): WerewolfState {
  const winner = checkWin(state)
  if (!winner) return state
  return { ...state, winner, phase: 'ended' }
}

/** 夜晚结算：结算刀/救/守/毒，死人，推进到白天。 */
function resolveNight(state: WerewolfState): WerewolfState {
  const n = state.night
  const dead: { id: string; cause: DeathRecord['cause'] }[] = []

  if (n.wolfTarget && n.wolfTarget !== n.guardProtect && n.wolfTarget !== n.witchSave) {
    dead.push({ id: n.wolfTarget, cause: 'wolf' })
  }
  if (n.witchPoison) dead.push({ id: n.witchPoison, cause: 'poison' })

  let s = applyDeaths(state, dead)
  const winner = checkWin(s)
  if (winner) {
    s = { ...s, winner, phase: 'ended' }
  } else {
    s = { ...s, phase: 'day' }
  }
  s = { ...s, night: makeNight(n.number + 1, n.saveUsed, n.poisonUsed) }
  return s
}

function nightComplete(state: WerewolfState): boolean {
  const n = state.night
  const alive = state.players.filter((p) => p.alive)
  const hasWolf = alive.some((p) => p.role === 'werewolf')
  const hasSeer = alive.some((p) => p.role === 'seer')
  const hasWitch = alive.some((p) => p.role === 'witch')
  const hasGuard = alive.some((p) => p.role === 'guard')
  return (!hasWolf || n.wolfTarget !== null) && (!hasSeer || n.seerChecked !== null) && (!hasWitch || n.witchActed) && (!hasGuard || n.guardProtect !== null)
}

function cloneState(state: WerewolfState): WerewolfState {
  return {
    players: state.players.map((p) => ({ ...p })),
    phase: state.phase,
    day: state.day,
    winner: state.winner,
    votes: state.votes.map((v) => ({ ...v })),
    night: { ...state.night },
    deaths: state.deaths.map((d) => ({ ...d })),
  }
}

/**
 * 夜晚动作。成功后返回新状态；当所有存活角色都行动过（狼/预言家/守卫必须、女巫表态后）
 * 会自动结算夜晚并推进到白天。非法动作抛 Error，入参状态不被修改。
 */
export function nightAction(state: WerewolfState, action: WerewolfAction): WerewolfState {
  const s = cloneState(state)
  if (s.phase !== 'night') throw new Error(`nightAction requires phase 'night', got '${s.phase}'`)

  if (action.role === 'werewolf') {
    requireAliveRole(s, 'werewolf', 'act')
    requireAlivePlayer(s, action.target, 'werewolf')
    s.night.wolfTarget = action.target
  } else if (action.role === 'seer') {
    requireAliveRole(s, 'seer', 'check')
    const target = requireAlivePlayer(s, action.target, 'seer')
    s.night.seerChecked = action.target
    s.night.seerResult = target.role === 'werewolf'
  } else if (action.role === 'witch') {
    requireAliveRole(s, 'witch', 'act')
    if (s.night.witchActed) throw new Error('witch already acted this night')
    if (action.save != null) {
      if (s.night.saveUsed) throw new Error('witch save already used')
      requireAlivePlayer(s, action.save, 'witch save')
      s.night.witchSave = action.save
      s.night.saveUsed = true
    }
    if (action.poison != null) {
      if (s.night.poisonUsed) throw new Error('witch poison already used')
      requireAlivePlayer(s, action.poison, 'witch poison')
      s.night.witchPoison = action.poison
      s.night.poisonUsed = true
    }
    s.night.witchActed = true
  } else if (action.role === 'guard') {
    requireAliveRole(s, 'guard', 'protect')
    requireAlivePlayer(s, action.target, 'guard')
    s.night.guardProtect = action.target
  } else {
    throw new Error('unknown night action')
  }

  return nightComplete(s) ? resolveNight(s) : s
}

/**
 * 阶段推进：night →（结算）→ day → vote；vote 阶段要求所有存活玩家都已投票。
 * 日常推进请用本函数；投票用 vote()。
 */
export function advancePhase(state: WerewolfState): WerewolfState {
  const s = cloneState(state)
  if (s.phase === 'night') return resolveNight(s)
  if (s.phase === 'day') return { ...s, phase: 'vote', votes: [] }
  if (s.phase === 'vote') {
    if (!allAliveVoted(s)) throw new Error('not all alive players have voted')
    return resolveVote(s)
  }
  return s
}

function allAliveVoted(state: WerewolfState): boolean {
  const alive = state.players.filter((p) => p.alive).map((p) => p.id)
  const voted = new Set(state.votes.map((v) => v.voter))
  return alive.every((id) => voted.has(id))
}

/** 结算投票：最高票且唯一者出局；平票/零票不出局。 */
function resolveVote(state: WerewolfState): WerewolfState {
  const tally = new Map<string, number>()
  for (const v of state.votes) tally.set(v.target, (tally.get(v.target) ?? 0) + 1)
  let top: string | null = null
  let topN = 0
  let tie = false
  for (const [target, n] of tally) {
    if (n > topN) {
      top = target
      topN = n
      tie = false
    } else if (n === topN) {
      tie = true
    }
  }
  let s = state
  if (top && topN > 0 && !tie) {
    s = applyDeaths(s, [{ id: top, cause: 'vote' }])
  }
  s = finishIfOver(s)
  if (s.phase === 'ended') return s
  return {
    ...s,
    phase: 'night',
    day: s.day + 1,
    votes: [],
    night: makeNight(s.night.number, s.night.saveUsed, s.night.poisonUsed),
  }
}

/**
 * 白天投票。voter/target 必须都存活；重复投票抛错。
 * 所有存活玩家都投完后自动结算（出局/进入下一夜）。
 */
export function vote(state: WerewolfState, voterId: string, targetId: string): WerewolfState {
  const s = cloneState(state)
  if (s.phase !== 'vote') throw new Error(`vote requires phase 'vote', got '${s.phase}'`)
  requireAlivePlayer(s, voterId, 'voter')
  requireAlivePlayer(s, targetId, 'vote')
  if (s.votes.some((v) => v.voter === voterId)) throw new Error(`player ${voterId} already voted`)
  s.votes.push({ voter: voterId, target: targetId })
  return allAliveVoted(s) ? resolveVote(s) : s
}

/** 存活玩家里取一个角色（查询用）。 */
export function aliveByRole(state: WerewolfState, role: WerewolfRole): WerewolfPlayer[] {
  return state.players.filter((p) => p.alive && p.role === role)
}
