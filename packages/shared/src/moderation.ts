// 小镇「发言检查」：纯规则过滤，不调用模型。
// 服务端在小镇公开她的发言前调用，依次经过 长度 → 链接 → 长串数字 → 联系方式 → 公开发言底线。
// 被拦截时统一把 text 替换成占位语，避免把原句透传出去。

export interface ModerationResult {
  ok: boolean
  text: string
  rule?: 'length' | 'link' | 'digits' | 'contact' | 'guard'
}

/** 被拦截时替换成的占位语（对外只说“没能传过来”，不泄露原句） */
export const BLOCKED_TEXT = '（她说了句话，没能传过来）'

export const DEFAULT_MAX_CHARS = 200

// 常见短链/短网址域名（另加 http(s):// 与 www. 前缀）
const SHORT_LINK_RE =
  /\b(?:bit\.ly|t\.cn|dwz\.cn|tinyurl\.com|goo\.gl|is\.gd|ow\.ly|buff\.ly|rebrand\.ly|cutt\.ly|suo\.im|url\.cn|shorturl\.at|rb\.gy)\b/i

// 手机号：1 开头、第二位 3-9、共 11 位（前后不能再接数字）
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/

// 邮箱
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/

// QQ 号：5-11 位数字，且附近带 qq / 扣扣 上下文
const QQ_RE = /(?:qq|扣扣|q\s*q)\s*[:：号]?\s*\d{5,11}/i

// 微信号：weixin / wechat / wx / vx / 微信 + 分隔符 + 账号
const WECHAT_RE = /(?:weixin|wechat|wx|vx|微信)\s*(?:号|id)?\s*[:：]?\s*[A-Za-z0-9_-]{5,}/i

// 公开发言底线：明显露骨词（中英文小词表，命中即拦）
export const GUARD_WORDS: string[] = [
  // 中文
  '傻逼', '操你', '妈的', '婊子', '贱人', '约炮', '裸聊', '色情', '做爱', '卖淫', '嫖娼',
  // 英文
  'fuck', 'shit', 'bitch', 'porn', 'nude', 'nsfw', 'sex', 'dick', 'pussy',
]

// 拉联系方式 / 要钱话术
const GUARD_PHRASES: string[] = [
  '加我', '加个微信', '加微信', '加微', '私聊', '私信我', '私我', '发红包', '红包', '转账', '打钱', '扫码加',
]

function block(rule: ModerationResult['rule']): ModerationResult {
  return { ok: false, text: BLOCKED_TEXT, rule }
}

/**
 * 检查一行发言。
 * 规则顺序：长度截断（ok 仍 true，仅截断时记 rule=length）→ 链接 → 长串数字 → 联系方式 → 底线。
 */
export function checkLine(text: string, opts?: { maxChars?: number }): ModerationResult {
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS

  let body = text
  let truncated = false
  if (body.length > maxChars) {
    body = body.slice(0, maxChars)
    truncated = true
  }

  // 2) 链接：http(s)://、www.、常见短链
  if (/https?:\/\//i.test(body) || /www\./i.test(body) || SHORT_LINK_RE.test(body)) {
    return block('link')
  }

  // 3) 长串数字：连续 >= 7 位数字。手机号形态交给下一步按 contact 归类。
  for (const m of body.matchAll(/\d{7,}/g)) {
    if (!/^1[3-9]\d{9}$/.test(m[0])) return block('digits')
  }

  // 4) 联系方式：手机号 / 邮箱 / QQ 上下文 / 微信号
  if (PHONE_RE.test(body)) return block('contact')
  if (EMAIL_RE.test(body)) return block('contact')
  if (QQ_RE.test(body)) return block('contact')
  if (WECHAT_RE.test(body)) return block('contact')

  // 5) 公开发言底线：露骨词 + 拉联系方式/要钱话术
  const lower = body.toLowerCase()
  for (const w of GUARD_WORDS) {
    if (lower.includes(w.toLowerCase())) return block('guard')
  }
  for (const p of GUARD_PHRASES) {
    if (body.includes(p)) return block('guard')
  }

  // 长度截断是唯一“ok 仍为 true”的规则
  if (truncated) return { ok: true, text: body, rule: 'length' }

  return { ok: true, text: body }
}
