import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  advancePhase,
  aliveByRole,
  checkWin,
  createWerewolf,
  defaultWerewolfRoles,
  nightAction,
  vote,
  type WerewolfState,
} from '../src/werewolf.ts'

function players(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: '玩家' + i }))
}

function roleId(s: WerewolfState, role: string): string {
  return s.players.find((p) => p.role === role && p.alive)!.id
}

function counts(s: WerewolfState, role: string): number {
  return s.players.filter((p) => p.role === role).length
}

// 1. 最小 6 人，默认角色配比；人数不足抛错
test('createWerewolf：最小 6 人，默认 2 狼 + 神职 + 村民；5 人抛错', () => {
  const s = createWerewolf(players(6))
  assert.equal(s.players.length, 6)
  assert.equal(s.phase, 'night')
  assert.equal(s.day, 1)
  assert.equal(s.winner, null)
  assert.equal(counts(s, 'werewolf'), 2)
  assert.equal(counts(s, 'seer'), 1)
  assert.equal(counts(s, 'witch'), 1)
  assert.equal(counts(s, 'guard'), 1)
  assert.equal(counts(s, 'villager'), 1)

  assert.throws(() => createWerewolf(players(5)), /at least 6/)
})

// 2. 9 人默认 3 狼
test('createWerewolf：9 人默认 3 狼', () => {
  const s = createWerewolf(players(9))
  assert.equal(counts(s, 'werewolf'), 3)
  assert.equal(defaultWerewolfRoles(9).filter((r) => r === 'werewolf').length, 3)
})

// 3. 自定义角色表
test('createWerewolf：自定义角色表生效；长度不符抛错', () => {
  const roles = ['werewolf', 'werewolf', 'villager', 'villager', 'villager', 'villager'] as const
  const s = createWerewolf(players(6), { roles: [...roles] })
  assert.equal(counts(s, 'werewolf'), 2)
  assert.equal(counts(s, 'villager'), 4)

  assert.throws(() => createWerewolf(players(6), { roles: ['werewolf', 'villager'] }), /length/)
})

// 4. 随机可注入 / seed 可复现
test('createWerewolf：rng 与 seed 确定可复现', () => {
  const a = createWerewolf(players(6), { seed: 42 })
  const b = createWerewolf(players(6), { seed: 42 })
  assert.deepEqual(a.players.map((p) => p.role), b.players.map((p) => p.role))

  const c = createWerewolf(players(6), { rng: () => 0 })
  const d = createWerewolf(players(6), { rng: () => 0 })
  assert.deepEqual(c.players.map((p) => p.role), d.players.map((p) => p.role))
})

// 5. 夜晚：狼刀记录 + 预言家验人结果
test('nightAction：狼刀记录目标；预言家验狼=true、验民=false', () => {
  const s = createWerewolf(players(6), { seed: 7 })
  const villagerId = roleId(s, 'villager')
  const wolfId = roleId(s, 'werewolf')

  const afterWolf = nightAction(s, { role: 'werewolf', target: villagerId })
  assert.equal(afterWolf.night.wolfTarget, villagerId)
  assert.equal(afterWolf.phase, 'night') // 尚未齐活

  const seerState = createWerewolf(players(6), { seed: 7 })
  const seerCheckWolf = nightAction(seerState, { role: 'seer', target: wolfId })
  assert.equal(seerCheckWolf.night.seerChecked, wolfId)
  assert.equal(seerCheckWolf.night.seerResult, true)

  const seerCheckVillager = nightAction(seerState, { role: 'seer', target: villagerId })
  assert.equal(seerCheckVillager.night.seerResult, false)
})

// 6. 夜晚齐活自动天亮，狼刀生效
test('nightAction：狼/预言家/女巫/守卫齐活后自动结算，狼刀生效进白天', () => {
  let s = createWerewolf(players(6), { seed: 3 })
  const wolfId = roleId(s, 'werewolf')
  const villagerId = roleId(s, 'villager')

  s = nightAction(s, { role: 'werewolf', target: villagerId })
  s = nightAction(s, { role: 'seer', target: wolfId })
  s = nightAction(s, { role: 'witch', save: null, poison: null })
  s = nightAction(s, { role: 'guard', target: wolfId }) // 守狼，不守村民

  assert.equal(s.phase, 'day')
  assert.equal(s.deaths.length, 1)
  assert.equal(s.deaths[0].target, villagerId)
  assert.equal(s.deaths[0].cause, 'wolf')
  assert.equal(s.players.find((p) => p.id === villagerId)!.alive, false)
  assert.equal(checkWin(s), null) // 2 狼 vs 3 好人，继续
})

// 7. 女巫救人：狼刀目标被救回
test('nightAction：女巫救回狼刀目标', () => {
  let s = createWerewolf(players(6), { seed: 4 })
  const villagerId = roleId(s, 'villager')
  const wolfId = roleId(s, 'werewolf')
  s = nightAction(s, { role: 'werewolf', target: villagerId })
  s = nightAction(s, { role: 'seer', target: wolfId })
  s = nightAction(s, { role: 'witch', save: villagerId, poison: null })
  s = nightAction(s, { role: 'guard', target: wolfId })
  assert.equal(s.phase, 'day')
  assert.equal(s.deaths.length, 0)
  assert.equal(s.players.find((p) => p.id === villagerId)!.alive, true)
})

// 8. 女巫毒人：毒药独立致死
test('nightAction：女巫毒人与狼刀同时生效', () => {
  let s = createWerewolf(players(6), { seed: 5 })
  const villagerId = roleId(s, 'villager')
  const wolfId = roleId(s, 'werewolf')
  const guardId = roleId(s, 'guard')
  s = nightAction(s, { role: 'werewolf', target: villagerId })
  s = nightAction(s, { role: 'seer', target: wolfId })
  s = nightAction(s, { role: 'witch', save: null, poison: guardId })
  s = nightAction(s, { role: 'guard', target: wolfId })

  assert.equal(s.deaths.length, 2)
  const causes = s.deaths.map((d) => d.cause).sort()
  assert.deepEqual(causes, ['poison', 'wolf'])
  assert.equal(s.players.find((p) => p.id === villagerId)!.alive, false)
  assert.equal(s.players.find((p) => p.id === guardId)!.alive, false)
  // 双死之后：存活 2 狼 vs 2 好人，判狼胜
  assert.equal(s.winner, 'werewolf')
  assert.equal(s.phase, 'ended')
})

// 9. 守卫守人：挡下狼刀
test('nightAction：守卫守人挡刀', () => {
  let s = createWerewolf(players(6), { seed: 6 })
  const villagerId = roleId(s, 'villager')
  const wolfId = roleId(s, 'werewolf')
  s = nightAction(s, { role: 'werewolf', target: villagerId })
  s = nightAction(s, { role: 'seer', target: wolfId })
  s = nightAction(s, { role: 'witch', save: null, poison: null })
  s = nightAction(s, { role: 'guard', target: villagerId }) // 守的是村民
  assert.equal(s.phase, 'day')
  assert.equal(s.deaths.length, 0)
  assert.equal(s.players.find((p) => p.id === villagerId)!.alive, true)
})

// 10. 白天发言 → 投票：多数票出局并进入下一夜
test('vote：白天推进到投票，多数票出局，进入下一夜', () => {
  let s = createWerewolf(players(6), { seed: 8 })
  const villagerId = roleId(s, 'villager')
  const wolfId = roleId(s, 'werewolf')
  s = nightAction(s, { role: 'werewolf', target: wolfId }) // 狼自刀（规则允许，仅测试轮转）
  s = nightAction(s, { role: 'seer', target: wolfId })
  s = nightAction(s, { role: 'witch', save: null, poison: null })
  s = nightAction(s, { role: 'guard', target: wolfId })
  assert.equal(s.phase, 'day')

  s = advancePhase(s)
  assert.equal(s.phase, 'vote')
  assert.equal(s.votes.length, 0)

  // 所有存活玩家都把票投给 villager（若 villager 已被狼刀死则换目标）
  const target = s.players.find((p) => p.id === villagerId)!.alive
    ? villagerId
    : roleId(s, 'witch')
  for (const p of s.players.filter((x) => x.alive)) {
    s = vote(s, p.id, target)
  }
  assert.ok(s.phase === 'night' || s.phase === 'ended')
  assert.equal(s.players.find((p) => p.id === target)!.alive, false)
  assert.equal(s.deaths.some((d) => d.target === target && d.cause === 'vote'), true)
  assert.equal(s.votes.length, 0)
})

// 11. 胜负判定：狼全灭=好人赢；狼>=好人=狼赢
test('checkWin：狼全灭=好人赢；狼数>=存活好人=狼赢', () => {
  const base = createWerewolf(players(6), { seed: 9 })
  const goodState = { ...base, players: base.players.map((p) => ({ ...p, alive: p.role !== 'werewolf' })) }
  assert.equal(checkWin(goodState), 'good')

  const wolvesWin = { ...base, players: base.players.map((p) => ({ ...p, alive: p.role === 'werewolf' || p.role === 'villager' })) }
  // 2 狼 vs 1 村民 → 狼赢
  assert.equal(checkWin(wolvesWin), 'werewolf')
})

// 12. 非法动作抛错且不修改入参
test('nightAction/vote：非法动作抛错且原状态不被修改', () => {
  let s = createWerewolf(players(6), { seed: 11 })
  const snapshot = JSON.parse(JSON.stringify(s))

  assert.throws(() => nightAction(s, { role: 'werewolf', target: 'p_nope' }), /unknown player/)
  assert.deepEqual(s, snapshot)

  // 白天不能夜行
  const wolfId = roleId(s, 'werewolf')
  const villagerId = roleId(s, 'villager')
  s = nightAction(s, { role: 'werewolf', target: villagerId })
  s = nightAction(s, { role: 'seer', target: wolfId })
  s = nightAction(s, { role: 'witch', save: null, poison: null })
  s = nightAction(s, { role: 'guard', target: wolfId })
  assert.equal(s.phase, 'day')
  assert.throws(() => nightAction(s, { role: 'werewolf', target: wolfId }), /requires phase 'night'/)

  // 女巫本夜重复表态（仍在夜晚，守卫未行动）
  let w = createWerewolf(players(6), { seed: 12 })
  const wWolf = roleId(w, 'werewolf')
  const wVillager = roleId(w, 'villager')
  w = nightAction(w, { role: 'werewolf', target: wVillager })
  w = nightAction(w, { role: 'seer', target: wWolf })
  w = nightAction(w, { role: 'witch', save: null, poison: null })
  assert.equal(w.phase, 'night')
  assert.throws(() => nightAction(w, { role: 'witch', save: wVillager, poison: null }), /already acted/)

  // 非投票阶段不能投；死者不能投
  assert.throws(() => vote(w, wWolf, wVillager), /requires phase 'vote'/)
})

// 13. 纯函数：投票/夜行返回新状态，不修改原状态引用
test('nightAction/vote 纯函数：返回新对象且不修改原状态', () => {
  const s = createWerewolf(players(6), { seed: 13 })
  const before = JSON.parse(JSON.stringify(s))
  const wolfId = roleId(s, 'werewolf')
  const villagerId = roleId(s, 'villager')

  const s2 = nightAction(s, { role: 'werewolf', target: villagerId })
  assert.notEqual(s2, s)
  assert.equal(s.night.wolfTarget, null) // 原状态未变
  assert.deepEqual(s, before)

  const alive = s2.players.filter((p) => p.alive).map((p) => p.id)
  assert.ok(alive.includes(wolfId))
  assert.ok(aliveByRole(s2, 'werewolf').length >= 1)
})
