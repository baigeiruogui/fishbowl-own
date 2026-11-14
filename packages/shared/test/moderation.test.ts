import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkLine, GUARD_WORDS, BLOCKED_TEXT } from '../src/moderation.ts'

test('正常话通过', () => {
  const r = checkLine('今天天气不错，一起去码头看看？')
  assert.equal(r.ok, true)
  assert.equal(r.text, '今天天气不错，一起去码头看看？')
  assert.equal(r.rule, undefined)
})

test('空串通过', () => {
  const r = checkLine('')
  assert.equal(r.ok, true)
  assert.equal(r.text, '')
  assert.equal(r.rule, undefined)
})

test('超长截断（ok 仍 true，rule=length）', () => {
  const long = 'a'.repeat(250)
  const r = checkLine(long)
  assert.equal(r.ok, true)
  assert.equal(r.text.length, 200)
  assert.equal(r.rule, 'length')
})

test('自定义 maxChars 截断', () => {
  const r = checkLine('一二三四五六七八九十', { maxChars: 5 })
  assert.equal(r.ok, true)
  assert.equal(r.text, '一二三四五')
  assert.equal(r.rule, 'length')
})

test('http 链接拦', () => {
  const r = checkLine('看这个 https://example.com/a 很好玩')
  assert.equal(r.ok, false)
  assert.equal(r.rule, 'link')
  assert.equal(r.text, BLOCKED_TEXT)
})

test('www 链接拦', () => {
  const r = checkLine('去 www.baidu.com 看看')
  assert.equal(r.ok, false)
  assert.equal(r.rule, 'link')
})

test('常见短链拦', () => {
  const r = checkLine('点 bit.ly/abc123 领取')
  assert.equal(r.ok, false)
  assert.equal(r.rule, 'link')
})

test('7 位以上连续数字拦', () => {
  const r = checkLine('我的编号是 123456789 记一下')
  assert.equal(r.ok, false)
  assert.equal(r.rule, 'digits')
})

test('手机号拦（归为 contact）', () => {
  const r = checkLine('有事打我电话 13812345678')
  assert.equal(r.ok, false)
  assert.equal(r.rule, 'contact')
})

test('邮箱拦', () => {
  const r = checkLine('发邮件到 abc@example.com 找我')
  assert.equal(r.ok, false)
  assert.equal(r.rule, 'contact')
})

test('QQ 上下文拦', () => {
  const r = checkLine('加我QQ：123456 聊')
  assert.equal(r.ok, false)
  assert.equal(r.rule, 'contact')
})

test('微信拦', () => {
  const r = checkLine('微信号：wxid88888 加一下')
  assert.equal(r.ok, false)
  assert.equal(r.rule, 'contact')
})

test('露骨词拦（词表命中）', () => {
  assert.ok(GUARD_WORDS.length > 0)
  const r = checkLine('你真是个傻逼')
  assert.equal(r.ok, false)
  assert.equal(r.rule, 'guard')
  assert.equal(r.text, BLOCKED_TEXT)
})

test('「加我微信」拉联系方式拦', () => {
  const r = checkLine('加我微信聊吧')
  assert.equal(r.ok, false)
  assert.equal(r.rule, 'guard')
})

test('要钱话术拦', () => {
  const r = checkLine('先给我发红包再说')
  assert.equal(r.ok, false)
  assert.equal(r.rule, 'guard')
})
