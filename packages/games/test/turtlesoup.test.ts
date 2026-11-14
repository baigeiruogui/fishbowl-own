import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  askQuestion,
  createTurtleSoup,
  defaultSoupDeck,
  drawSoupCard,
  guess,
  type SoupCard,
} from '../src/turtlesoup.ts'

// 1. 内置题目卡结构完整
test('内置题目卡：谜面/谜底/关键词齐全', () => {
  const deck = defaultSoupDeck()
  assert.ok(deck.length >= 3)
  for (const c of deck) {
    assert.equal(typeof c.id, 'string')
    assert.ok(c.riddle.length > 0)
    assert.ok(c.answer.length > 0)
    assert.ok(Array.isArray(c.keywords) && c.keywords.length > 0)
  }
})

// 2. 建局：抽到的是 deck 里存在的卡
test('createTurtleSoup：默认抽卡来自内置牌堆', () => {
  const s = createTurtleSoup()
  const ids = defaultSoupDeck().map((c) => c.id)
  assert.ok(ids.includes(s.card.id))
  assert.equal(s.solved, false)
  assert.equal(s.asked, 0)
})

// 3. seed 可复现；rng 可注入选首/末张
test('抽卡：seed 复现一致，rng 注入决定首/末张', () => {
  const deck = defaultSoupDeck()
  const a = drawSoupCard(deck, 7)
  const b = drawSoupCard(deck, 7)
  assert.equal(a.id, b.id)

  assert.equal(createTurtleSoup({ seed: 7 }).card.id, a.id)

  assert.equal(drawSoupCard(deck, () => 0).id, deck[0]!.id)
  assert.equal(drawSoupCard(deck, () => 0.999999).id, deck[deck.length - 1]!.id)
})

// 4. 提问命中 yes 关键词
test('askQuestion：命中 yes 关键词返回 yes', () => {
  const card: SoupCard = {
    id: 'x',
    riddle: '谜面',
    answer: '谜底',
    keywords: [{ word: '打嗝', answer: 'yes' }],
  }
  const s = { card, solved: false, asked: 0 }
  assert.equal(askQuestion(s, '他是不是在打嗝？'), 'yes')
  assert.equal(askQuestion(s, '打嗝了吗'), 'yes')
})

// 5. 提问命中 no 关键词返回 no
test('askQuestion：命中 no 关键词返回 no', () => {
  const s = { card: { id: 'x', riddle: 'r', answer: 'a', keywords: [{ word: '自杀', answer: 'no' as const }] }, solved: false, asked: 0 }
  assert.equal(askQuestion(s, '他是自杀的吗'), 'no')
})

// 6. 提问无关返回 irrelevant；空问题 irrelevant
test('askQuestion：无关/空问题返回 irrelevant', () => {
  const s = createTurtleSoup({ seed: 1 })
  assert.equal(askQuestion(s, '今天天气怎么样？'), 'irrelevant')
  assert.equal(askQuestion(s, ''), 'irrelevant')
})

// 7. 提问直接说出谜底返回 correct
test('askQuestion：说出谜底原文返回 correct', () => {
  const s = { card: { id: 'x', riddle: 'r', answer: '海龟汤真好喝', keywords: [] }, solved: false, asked: 0 }
  assert.equal(askQuestion(s, '是不是因为海龟汤真好喝？'), 'correct')
})

// 8. 猜谜底：对错判定，大小写/空白不敏感
test('guess：完全匹配判对，大小写与首尾空白不敏感', () => {
  const s = { card: { id: 'x', riddle: 'r', answer: '海龟汤真好喝', keywords: [] }, solved: false, asked: 0 }
  assert.equal(guess(s, '海龟汤真好喝'), true)
  assert.equal(guess(s, '  海龟汤真好喝  '), true)
  assert.equal(guess(s, '海龟汤不好喝'), false)
  assert.equal(guess(s, ''), false)
})

// 9. 纯函数：askQuestion / guess 不修改 state
test('askQuestion/guess 纯函数：不修改原状态', () => {
  const s = createTurtleSoup({ seed: 2 })
  const snapshot = JSON.parse(JSON.stringify(s))
  askQuestion(s, '测试提问')
  guess(s, '测试答案')
  assert.deepEqual(s, snapshot)
  assert.equal(s.asked, 0)
})
