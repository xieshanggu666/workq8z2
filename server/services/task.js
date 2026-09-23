// 抽奖任务自动结算服务：进度唯一来源于真实参与记录（normal/released 计入，frozen 暂缓，revoked 不计）；
// 同一（任务 × 用户 × 归属业务日）以 taskClaims 台账幂等判重，只发一次奖；跨日放行按 bizDate 补计、grantDate 留痕。
// 多用户：进度/领奖台账按 userId 隔离，支持多用户并发结算互不串账。
import { genId } from '../util.js'

export class TaskService {
  constructor(k, audit, points) {
    this.k = k
    this.audit = audit
    this.points = points
  }

  validDrawCount(bizDate, tenantId, userId) {
    return this.k.state.records.filter(
      (r) => r.type === 'draw' && r.date === bizDate && (r.tenantId || 't-star') === tenantId &&
        r.userId === userId && ['normal', 'released'].includes(r.status)
    ).length
  }

  pendingDrawCount(bizDate, tenantId, userId) {
    return this.k.state.records.filter(
      (r) => r.type === 'draw' && r.date === bizDate && r.status === 'frozen' &&
        (r.tenantId || 't-star') === tenantId && r.userId === userId
    ).length
  }

  // 结算指定用户在指定业务日的全部抽奖任务（幂等）。返回新结算的台账。
  async settle(bizDate, tenantId, userId, traceId = '') {
    const date = bizDate || this.k.todayDate()
    const drawTasks = this.k.state.tasks.filter((t) => t.metric === 'draw' && t.type === 'daily')
    if (!drawTasks.length) return []
    const valid = this.validDrawCount(date, tenantId, userId)
    const settled = []
    for (const t of drawTasks) {
      if (valid < t.goal) continue
      if (this.k.state.taskClaims.some(
        (c) => c.taskId === t.id && c.bizDate === date && (c.tenantId || 't-star') === tenantId && c.userId === userId
      )) continue
      const crossDay = date !== this.k.todayDate()
      const claimId = genId('tc')
      const { flow } = await this.points.post({
        userId,
        delta: t.reward,
        note: `任务结算：${t.label}${crossDay ? `（${date} 业务日补计）` : ''}`,
        kind: 'reward', tenantId, bizDate: date,
        refId: claimId, refType: 'task-claim', traceId
      })
      const claim = {
        id: claimId,
        taskId: t.id, taskLabel: t.label, reward: t.reward,
        userId,
        tenantId,
        bizDate: date,
        grantDate: this.k.todayDate(),
        time: this.k.nowTime(), ts: this.k.nowTs(),
        source: 'auto', flowId: flow.id
      }
      await this.k.commit([{ type: 'insert', table: 'taskClaims', row: claim }])
      await this.audit.log('task-settle', '',
        `【${this.k.state.tenants.find((x) => x.id === tenantId)?.shortName || tenantId}】用户【${userId}】抽奖任务【${t.label}】达成（${date} 有效参与 ${valid}/${t.goal}），自动发放 ${t.reward} 积分${crossDay ? '（跨日审核补计）' : ''}`,
        { tenantId, traceId })
      settled.push(claim)
    }
    return settled
  }
}
