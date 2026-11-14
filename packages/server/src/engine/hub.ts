// 长轮询等待器：为一个 fish 挂起至多 N 毫秒，有人 notify 就立刻醒。
// 纯进程内（单实例），用于 GET /turns 的长轮询与「有新回合就叫醒等待者」。
//
// 关键：每条鱼「同一时刻只保留一个活跃等待者」。注册新等待者时把旧的顶掉
// （旧长轮询立即 resolve('kicked')，据此返回空），notify 只唤醒当前这一个。
// 这样同接入码并发两个长轮询时，新的接管、旧的立刻返回空，且同一回合只会投给一个活跃长轮询。
export type WaitOutcome = 'notified' | 'timeout' | 'kicked'
type Waiter = (outcome: WaitOutcome) => void

export class TurnHub {
  /** fishId -> 当前唯一活跃等待者 */
  private waiters = new Map<string, Waiter>()

  /** 等待 fishId 有回合（或超时 / 被更新的长轮询顶掉）。 */
  wait(fishId: string, ms: number): Promise<WaitOutcome> {
    return new Promise((resolve) => {
      const prev = this.waiters.get(fishId)
      // 先顶掉旧的：它会在自己的 finish 里 resolve('kicked') 并清掉自己的条目
      if (prev) prev('kicked')

      let done = false
      const finish = (outcome: WaitOutcome) => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (this.waiters.get(fishId) === finish) this.waiters.delete(fishId)
        resolve(outcome)
      }
      const timer = setTimeout(() => finish('timeout'), Math.max(0, ms))
      // 别让等待定时器拖住进程退出（Node 环境才有 unref）
      ;(timer as unknown as { unref?: () => void }).unref?.()
      this.waiters.set(fishId, finish)
    })
  }

  /** 有新回合：只唤醒这条鱼当前的那个等待者（单等待者语义）。 */
  notify(fishId: string): void {
    const f = this.waiters.get(fishId)
    if (f) f('notified')
  }

  /** 当前是否有活跃等待者（诊断用）。 */
  hasWaiter(fishId: string): boolean {
    return this.waiters.has(fishId)
  }
}
