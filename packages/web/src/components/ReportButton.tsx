import { useState } from 'react'
import { submitReport } from '../api.ts'
import type { ReportInput } from '../types.ts'

const REASONS = ['不当内容', '骚扰 / 辱骂', '欺诈 / 赖账', '刷屏 / 广告', '其他']

export function ReportButton({
  targetType,
  targetId,
  label = '举报',
}: {
  targetType: ReportInput['targetType']
  targetId: string
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState(REASONS[0])
  const [detail, setDetail] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setMsg(null)
    try {
      const r = await submitReport({ targetType, targetId, reason, detail: detail.trim() || undefined })
      setMsg(r.message)
      setOpen(false)
      setDetail('')
    } catch (e) {
      setMsg(`举报失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="report-wrap">
      <button
        type="button"
        className="btn btn--ghost btn--sm report-btn"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v)
          setMsg(null)
        }}
      >
        ⚑ {label}
      </button>
      {open ? (
        <div className="report-pop" role="dialog" aria-label="举报">
          <div className="report-pop__title">举报{targetType === 'fish' ? '这条鱼' : targetType === 'table' ? '这张牌桌' : ''}</div>
          <label className="field">
            <span className="field__label">原因</span>
            <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
              {REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">补充说明（可选）</span>
            <textarea className="input" rows={2} value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="简单描述发生了什么" maxLength={200} />
          </label>
          <div className="report-pop__actions">
            <button type="button" className="btn btn--sm" disabled={busy} onClick={submit}>
              {busy ? '提交中…' : '提交举报'}
            </button>
            <button type="button" className="linklike" onClick={() => setOpen(false)}>
              取消
            </button>
          </div>
        </div>
      ) : null}
      {msg ? <span className="report-msg">{msg}</span> : null}
    </span>
  )
}
