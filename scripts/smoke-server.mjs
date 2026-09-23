// 服务端履约链路冒烟测试（纯 node 运行，零依赖；不经过 HTTP，直接驱动服务装配）
// 覆盖：多用户并发不超卖/余额正确、幂等重放、扣分预占+发奖幂等、
//       交易/审核崩溃续办、跨日审核归属、P1–P6 对账与补偿幂等、租户 RBAC 越权拒绝留痕。
import { tmpdir } from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createApp } from '../server/app.js'
import { BizError } from '../server/util.js'

let failed = 0
const assert = (cond, msg) => {
  if (cond) console.log('  ✅', msg)
  else { console.error('  ❌', msg); failed++ }
}
const tmpDb = (name) => {
  const f = path.join(tmpdir(), `lottery-srv-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`)
  fs.rmSync(f, { force: true })
  return f
}
const customerCtx = (app, userId = 'u-1001', name = '运营测试用户', tenantId = 't-star') =>
  ({ identityKind: 'customer', userId, memberId: '', name, tenantId, ip: '127.0.0.1' })
const staffCtx = (app, memberId) => {
  const m = app.k.state.members.find((x) => x.id === memberId)
  return { identityKind: m.tenantId ? 'staff' : 'platform', memberId: m.id, userId: m.id, name: m.name, tenantId: m.tenantId || 't-star', ip: '10.0.0.1' }
}
const disableRisk = async (app, tid = 't-star') => {
  app.k.state.riskRules[tid] = {
    ...app.k.state.riskRules[tid], enabled: false,
    dailyDrawThreshold: 0, rapidDrawMax: 0, rapidRedeemMax: 0
  }
}
const settled = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }))

async function testConcurrency() {
  console.log('— 多用户并发：库存不超卖、积分串行扣减 —')
  const app = await createApp({ dbFile: tmpDb('conc') })
  await disableRisk(app)
  // g1 仅留 3 件，10 个并发兑换（同一用户 u-1001）：恰好 3 笔成功
  const g1 = app.k.state.goods.find((g) => g.id === 'g1')
  await app.k.commit([{ type: 'upsert', table: 'goods', row: { ...g1, remain: 3 } }])
  const ctx = customerCtx(app)
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    settled(app.trade.redeem('g1', ctx, { idempotencyKey: `c${i}` }))))
  const ok = results.filter((r) => r.ok)
  const rejected = results.filter((r) => !r.ok)
  assert(ok.length === 3, `3 件库存恰好成交 3 笔（实际 ${ok.length}）`)
  assert(rejected.length === 7 && rejected.every((r) => ['OUT_OF_STOCK', 'ALL_SOLD_OUT'].includes(r.e.code)),
    `其余 7 笔被不超卖拦截（实际 ${rejected.length}，code=${rejected[0]?.e.code}）`)
  const g1after = app.k.state.goods.find((g) => g.id === 'g1')
  assert(g1after.remain === 0 && g1after.frozen === 0, `兑完 remain=0、无脏预占（${g1after.remain}/${g1after.frozen}）`)
  const spend = app.k.state.pointFlows.filter((p) => p.note.startsWith('兑换：满50减10') && p.delta === -30)
  assert(spend.length === 3, `积分恰好扣减 3 笔（实际 ${spend.length}，无重复/漏扣）`)
  assert(app.points.balanceOf('u-1001') === 1000 - 90, `余额 1000-90=910（实际 ${app.points.balanceOf('u-1001')}）`)

  // 多用户并发抢 2 件实物 g3（3 用户、6 并发）：恰好 2 笔成功，其余库存不足或积分不足
  const g3 = app.k.state.goods.find((g) => g.id === 'g3')
  await app.k.commit([{ type: 'upsert', table: 'goods', row: { ...g3, remain: 2 } }])
  const users = [
    customerCtx(app, 'u-1001', '运营测试用户'),
    customerCtx(app, 'u-1002', '并发用户乙'),
    customerCtx(app, 'u-1003', '并发用户丙')
  ]
  const res2 = await Promise.all(Array.from({ length: 6 }, (_, i) =>
    settled(app.trade.redeem('g3', users[i % 3], { idempotencyKey: `g3-${i}` }))))
  const ok2 = res2.filter((r) => r.ok)
  assert(ok2.length === 2, `6 并发抢 2 件实物：恰好 2 笔成功（实际 ${ok2.length}）`)
  const winners = new Set(ok2.map((r) => r.v.trade.userId))
  assert(winners.size >= 1, `成交来自并发用户集合（${[...winners].join(',')}）`)
  assert(app.k.state.goods.find((g) => g.id === 'g3').remain === 0, 'g3 库存清零，未出现负库存')
  await app.k.close()
}

async function testIdempotency() {
  console.log('— 统一幂等：重复提交不重复扣分/扣库存/发奖 —')
  const app = await createApp({ dbFile: tmpDb('idem') })
  await disableRisk(app)
  const ctx = customerCtx(app)
  const r1 = await app.trade.draw('act-1', ctx, { idempotencyKey: 'abc-001' })
  const r2 = await app.trade.draw('act-1', ctx, { idempotencyKey: 'abc-001' })
  assert(r1.trade.id === r2.trade.id && r2.idempotent === true, '相同幂等键返回同一交易，第二次为幂等重放')
  const sameIdRecords = app.k.state.records.filter((r) => r.id === r1.trade.id)
  assert(sameIdRecords.length === 1, '业务记录仅一笔')
  const costFlows = app.k.state.pointFlows.filter((p) => p.refId === `draw-cost:${r1.trade.id}`)
  assert(costFlows.length <= 1, `扣分流水至多一笔（实际 ${costFlows.length}）`)
  const ships = app.k.state.shipments.filter((o) => o.recordId === r1.trade.id)
  const cps = app.k.state.coupons.filter((c) => c.recordId === r1.trade.id)
  assert(ships.length + cps.length <= 1, `发奖（发货单/卡券）至多一份（${ships.length}/${cps.length}）`)

  // 兑券重复键
  const x1 = await app.trade.redeem('g1', ctx, { idempotencyKey: 'redeem-xyz' })
  const x2 = await app.trade.redeem('g1', ctx, { idempotencyKey: 'redeem-xyz' })
  assert(x1.trade.id === x2.trade.id, '兑换重复键同样幂等')
  const couponsForRec = app.k.state.coupons.filter((c) => c.recordId === x1.trade.id)
  assert(couponsForRec.length === 1 && couponsForRec[0].code, `券仅发一张，券码 ${couponsForRec[0]?.code}`)
  await app.k.close()
}

async function testCrashResume() {
  console.log('— 故障续办：交易在扣分后崩溃，重启自动续办且无重复副作用 —')
  const db = tmpDb('crash')
  let app = await createApp({ dbFile: db })
  await disableRisk(app)
  const ctx = customerCtx(app)
  app.k.injectFault('draw.afterCost')
  let crashed = null
  try {
    await app.trade.draw('act-2', ctx, { idempotencyKey: 'crash-1' })
  } catch (e) { crashed = e }
  assert(cashedOr(crashed), 'draw.afterCost 注入点触发中断（积分已扣、交易未完成）')
  const recId = app.k.state.records.find((r) => r.processing)?.id
  assert(!!recId, '崩溃时已留下 processing 交易锚点')
  await app.k.close()

  // 重启：WAL 重放 + 启动续办
  app = await createApp({ dbFile: db })
  const rec = app.k.state.records.find((r) => r.id === recId)
  assert(rec.status === 'normal' && !rec.processing, `重启后交易自动续办为 normal（实际 ${rec.status}）`)
  const costFlows = app.k.state.pointFlows.filter((p) => p.refId === `draw-cost:${recId}`)
  assert(costFlows.length === 1, `扣分流水恰好一笔（实际 ${costFlows.length}，重放未重复扣分）`)
  // 余额勾稽：-10 成本 + 中奖积分（崩溃后续办把发奖阶段执行完；谢谢参与/券/实物奖励为 0）
  const wonPoints = rec.prizeName.includes('积分') ? (parseInt(rec.prizeName, 10) || 0) : 0
  const expectedBalance = 1000 - 10 + wonPoints
  assert(app.points.balanceOf('u-1001') === expectedBalance,
    `续办后余额勾稽 ${app.points.balanceOf('u-1001')}==${expectedBalance}（成本-10，奖品【${rec.prizeName}】积分+${wonPoints}）`)
  const ships = app.k.state.shipments.filter((o) => o.recordId === recId)
  const cps = app.k.state.coupons.filter((c) => c.recordId === recId)
  assert(ships.length <= 1 && cps.length <= 1, `发奖至多一份（发货单 ${ships.length}/卡券 ${cps.length}，无重复）`)
  // 期望发奖份数：券类 1 张券；谢谢参与/积分奖品 0；其余实物 1 张发货单（与 ship.isPhysical 同口径）
  const expectAward = rec.couponId ? 1
    : (rec.rarity === 'none' || rec.prizeName.includes('积分')) ? 0
    : 1
  assert(ships.length + cps.length === expectAward,
    `发奖类型与奖品匹配（${rec.prizeName} → 期望 ${expectAward}，实际 发货 ${ships.length} 卡券 ${cps.length}）`)
  const again = await app.trade.resumeAll({ name: '测试' })
  assert(again.length === 0, '再次扫描无遗留 processing 单（续办幂等）')
  const resumeLogs = app.k.state.auditLogs.filter((l) => l.action === 'saga-resume')
  assert(resumeLogs.length >= 1, '故障续办写入审计留痕')
  await app.k.close()
}

function cashedOr(e) {
  return e instanceof BizError && e.code === 'CRASH_INJECTED'
}

async function testReleaseCrashAndCrossDay() {
  console.log('— 风控放行 Saga 崩溃续办 + 跨日审核按业务日补计 —')
  const db = tmpDb('crossday')
  let app = await createApp({ dbFile: db })
  const day1 = '2026-09-20'
  const day2 = '2026-09-21'
  app.k.setBusinessDay(day1)
  const ctx = customerCtx(app)
  // 仅保留高价值规则（关闭频次/连抽），制造 3 次参与：2 正常 + 1 冻结（epic 购物卡）
  app.k.state.riskRules['t-star'] = {
    ...app.k.state.riskRules['t-star'], enabled: true,
    highValueRarities: ['legendary', 'epic'], dailyDrawThreshold: 0,
    rapidDrawMax: 0, rapidDrawSeconds: 0, blacklist: []
  }
  // 提高 act-1 每日/累计上限，保证 3 连抽不被限次
  const act = app.k.state.activities.find((a) => a.id === 'act-1')
  await app.k.commit([{ type: 'upsert', table: 'activities', row: { ...act, dailyLimit: 10, totalLimit: 100 } }])
  // 让抽奖稳定命中：p2(epic) 权重拉满
  const act2 = app.k.state.activities.find((a) => a.id === 'act-1')
  const prizes = act2.prizes.map((p) => ({ ...p, weight: p.id === 'p2' ? 100 : 0 }))
  await app.k.commit([{ type: 'upsert', table: 'activities', row: { ...act2, prizes } }])

  const frozenDraw = await app.trade.draw('act-1', ctx, { idempotencyKey: 'fd' })
  assert(frozenDraw.trade.status === 'frozen' && frozenDraw.trade.riskOrderId, '命中高价值：抽奖冻结、预占库存、建立审核单')
  const orderId = frozenDraw.trade.riskOrderId
  const prize2 = app.k.state.activities.find((a) => a.id === 'act-1').prizes.find((p) => p.id === 'p2')
  assert(prize2.remain === 19 && prize2.frozen === 1, '冻结态 remain-1/frozen+1（预占不超卖）')
  // 第 2/3 次为谢谢参与（关闭风控，none 权重 0 权重设置后需恢复：直接关闭风控并把 p6 权重拉满）
  app.k.state.riskRules['t-star'].enabled = false
  const ap = app.k.state.activities.find((a) => a.id === 'act-1')
  await app.k.commit([{ type: 'upsert', table: 'activities', row: { ...ap, prizes: ap.prizes.map((p) => ({ ...p, weight: p.rarity === 'none' ? 100 : 0 })) } }])
  await app.trade.draw('act-1', ctx, { idempotencyKey: 'n1' })
  await app.trade.draw('act-1', ctx, { idempotencyKey: 'n2' })
  assert(app.tasks.validDrawCount(day1, 't-star', 'u-1001') === 2, 'day1 有效参与=2（冻结暂缓计入）')
  assert(app.k.state.taskClaims.filter((c) => c.bizDate === day1 && c.userId === 'u-1001').length === 0, 'day1 任务未达标未发奖')

  // 跨日到 day2 放行；在"核销预占库存后"注入崩溃
  app.k.setBusinessDay(day2)
  app.k.injectFault('release.afterConsume')
  const riskStaff = staffCtx(app, 'm-star-risk')
  let crashed = null
  try {
    await app.risk.review(orderId, 'release', '跨日审核放行（崩溃测试）', riskStaff)
  } catch (e) { crashed = e }
  assert(cashedOr(crashed), '放行 Saga 在核销预占后中断（processing 锚点已落库）')
  await app.k.close()

  // 重启续办到终态（先还原虚拟业务日 day2，再手工续办，保证 grantDate 为实际处理日 day2）
  app = await createApp({ dbFile: db, autoResume: false })
  app.k.setBusinessDay(day2)
  const resumedTrades = await app.trade.resumeAll({ name: '系统启动续办' })
  const resumedOrders = await app.risk.resumeProcessing()
  assert(resumedOrders.includes(orderId), `启动续办接管崩溃的放行单（实际 ${JSON.stringify(resumedOrders)}）`)
  const order = app.k.state.riskOrders.find((o) => o.id === orderId)
  assert(order.status === 'released' && !order.processing, `重启后续办完成：审核单 released（实际 ${order.status}）`)
  const rec = app.k.state.records.find((r) => r.id === order.recordId)
  assert(rec.status === 'released', '业务记录已放行')
  const prizeAfter = app.k.state.activities.find((a) => a.id === 'act-1').prizes.find((p) => p.id === 'p2')
  assert(prizeAfter.remain === 19 && prizeAfter.frozen === 0, `续办后预占核销且仅核销一次（remain=${prizeAfter.remain}, frozen=${prizeAfter.frozen}）`)
  const ship = app.k.state.shipments.find((o) => o.recordId === rec.id)
  assert(!!ship && ship.status === 'pending_address', '放行后发奖：生成唯一发货单（冻结期无发货单）')
  assert(app.k.state.shipments.filter((o) => o.recordId === rec.id).length === 1, '发货单不重复')

  // 跨日任务结算：领奖台账归属 day1、实际发放日 day2
  const claim = app.k.state.taskClaims.find((c) => c.bizDate === day1 && c.userId === 'u-1001')
  assert(!!claim && claim.grantDate === day2 && claim.reward === 15,
    `跨日审核补计：台账 bizDate=${day1}、grantDate=${day2}（实际 ${claim?.bizDate}/${claim?.grantDate}）`)
  const claimFlow = app.k.state.pointFlows.find((p) => p.refId === claim?.id)
  assert(claimFlow && claimFlow.bizDate === day1 && claimFlow.date === day2, '发奖流水 bizDate=day1、实际入账日 day2')

  // 对账：day1 平衡（含补计的任务奖励）；day2 不串入该奖励
  const d1 = app.recon.compute(day1, 't-star')
  assert(d1.openCount === 0, `day1 对账平衡（open=${d1.openCount} P1残差=${d1.points.residual} P2缺笔=${d1.tasks.length}）`)
  const d2 = app.recon.compute(day2, 't-star')
  assert(d2.points.expectedNet === 0 || !d2.points.detail.some((e) => Math.abs(e.delta) === 15),
    'day2 对账不含 day1 的任务奖励（跨日不串账）')
  await app.k.close()
}

async function testRecon() {
  console.log('— P1–P6 对账：检出、复核、补偿、幂等再对账 —')
  const app = await createApp({ dbFile: tmpDb('recon') })
  await disableRisk(app)
  const today = app.k.todayDate()

  // 初始今日平衡
  const d0 = app.recon.compute(today, 't-star')
  assert(d0.openCount === 0, `种子初始今日零差异（open=${d0.openCount}）`)

  // 注入 P1+P2：领奖台账在、积分漏发（+30）
  await app.k.commit([{ type: 'insert', table: 'taskClaims', row: {
    id: 'gap-30', taskId: 't-checkin', taskLabel: '每日签到（漏记）', reward: 30,
    userId: 'u-1001', tenantId: 't-star', bizDate: today, grantDate: today,
    time: app.k.nowTime(), ts: app.k.nowTs(), source: 'manual-gap', flowId: ''
  } }])
  // 注入 P5：g1 实物盘亏 1 件（业务记录不变，实物少 1）
  const g1 = app.k.state.goods.find((g) => g.id === 'g1')
  const g1OrigRemain = g1.remain
  await app.k.commit([{ type: 'upsert', table: 'goods', row: { ...g1, remain: g1.remain - 1 } }])
  // 注入 P6：构造一笔"有效券业务记录"但券账户无实例（含对应扣分流水与库存消耗，保证 P1/P5 不被污染）
  const recId = 'gap-rec-coupon'
  await app.points.post({
    userId: 'u-1001', delta: -30, note: '兑换：满50减10优惠券（历史漏券）', kind: 'normal',
    tenantId: 't-star', refId: `redeem-cost:${recId}`, refType: 'trade'
  })
  await app.k.commit([{ type: 'inv.mut', key: 'goods:g1', dRemain: -1, dFrozen: 0, effectId: `redeem-stock:${recId}` }])
  const gapRec = {
    id: recId, type: 'redeem', status: 'normal', tenantId: 't-star',
    userId: 'u-1001', userName: '运营测试用户', traceId: '',
    date: today, time: app.k.nowTime(), ts: app.k.nowTs(),
    goodsId: 'g1', goodsName: '满50减10优惠券', couponId: 'c-discount-10', icon: '🎟️', cost: 30
  }
  await app.k.commit([{ type: 'insert', table: 'records', row: gapRec }])

  const d1 = app.recon.compute(today, 't-star')
  assert(d1.points.residual === 30, `P1 检出积分净额残差 +30（实际 ${d1.points.residual}）`)
  assert(d1.tasks.some((t) => t.claimId === 'gap-30'), 'P2 检出台账缺笔')
  assert(d1.stock.some((x) => x.targetId === 'g1' && x.diff === 1), 'P5 检出 g1 盘亏（账面比应有少 1）')
  assert(d1.coupons.some((x) => x.kind === 'missing' && x.recordId === recId), 'P6 检出券漏发')

  // 复核 + 补偿
  const admin = staffCtx(app, 'm-star-fin')
  let bill = await app.recon.run(today, 't-star', admin)
  await app.recon.review(today, 't-star', '差异属实', admin)
  const balBefore = app.points.balanceOf('u-1001')
  const res = await app.recon.compensate(today, 't-star', '', admin)
  assert(res.actions.some((a) => a.type === 'task' && a.delta === 30), '补偿：任务奖励 +30 补记')
  assert(res.actions.some((a) => a.type === 'stock' && a.delta === -1 && a.label.includes('满50减10')), '补偿：库存校正凭证 -1（盘亏核销）')
  assert(res.actions.some((a) => a.type === 'coupon'), '补偿：补发新券')
  assert(app.points.balanceOf('u-1001') === balBefore + 30, '余额随补偿同步 +30')
  const newCoupon = app.k.state.coupons.find((c) => c.recordId === recId)
  assert(!!newCoupon && newCoupon.comp && newCoupon.compensateBillId, '漏发券以新券码补发且带对账补券标记')
  // g1 变化：初始 200 → 注入盘亏 -1 = 199 → gapRec 真实兑换再扣 1 = 198；
  // P5 diff = 应有(200-1) - 账面(198) = 1，补偿登记 -1 调整凭证后应有=198=账面，平账且实物账保持 198 不变。
  const g1After = app.k.state.goods.find((g) => g.id === 'g1')
  assert(g1After.remain === 198, `盘亏实物账补偿前后均为 198（实际 ${g1After.remain}，调整凭证只改应有公式）`)
  const adj = app.k.state.stockAdjustments.find((a) => a.targetKey === 'goods:g1')
  assert(adj && adj.delta === -1, '库存调整凭证 -1（append-only）')

  const d2 = app.recon.compute(today, 't-star')
  assert(d2.openCount === 0, `补偿后重新对账平账（open=${d2.openCount}）`)
  assert(d2.chain === null, 'P3 余额链连续')

  // 幂等补偿
  let dupErr = null
  try {
    await app.recon.compensate(today, 't-star', '', admin)
  } catch (e) { dupErr = e }
  assert(dupErr instanceof BizError && dupErr.code === 'ALREADY_BALANCED', '已平账单重复补偿被拒绝')
  const taskCompCount = app.k.state.pointFlows.filter((p) => p.kind === 'task-comp' && p.refId === 'gap-30').length
  assert(taskCompCount === 1, `task-comp 补偿流水仅一笔（实际 ${taskCompCount}）`)
  assert(app.k.state.coupons.filter((c) => c.recordId === 'gap-rec-coupon').length === 1, '补券仅一张')
  assert(app.k.state.stockAdjustments.filter((a) => a.targetKey === 'goods:g1').length === 1, '库存校正仅一条')
  await app.k.close()
}

async function testRbac() {
  console.log('— 租户鉴权 / RBAC：越权与停用账号拒绝并留痕 —')
  const app = await createApp({ dbFile: tmpDb('rbac') })
  await disableRisk(app)
  // 物流员工无风控审核权
  const shipStaff = staffCtx(app, 'm-star-ship')
  assert(!app.auth.can(shipStaff, 'risk:review'), '仓配小李无 risk:review')
  let denied = null
  try {
    await app.auth.requirePerm(shipStaff, 'risk:review', 'risk', '风控审核')
  } catch (e) { denied = e }
  assert(denied instanceof BizError && denied.status === 403, '权限校验抛出 403')
  const deniedLog = app.k.state.auditLogs.find((l) => l.result === 'denied' && l.module === 'risk')
  assert(!!deniedLog && deniedLog.detail.includes('风控审核'), '拒绝事件写 result=denied 审计')

  // 停用员工登录被拒
  let loginErr = null
  try { await app.auth.loginMember('m-star-cs') } catch (e) { loginErr = e }
  assert(loginErr instanceof BizError && loginErr.code === 'LOGIN_DENIED', '离职停用账号登录被拒绝')
  assert(app.k.state.auditLogs.some((l) => l.action === 'login-denied'), '登录拒绝留痕')

  // 星河员工不能处理云雀单据（跨租户）
  const cloudOrder = await makeCloudFrozenOrder(app)
  const riskStaff = staffCtx(app, 'm-star-risk')
  let crossErr = null
  try {
    await app.auth.requireSameTenant(riskStaff, 't-cloud', 'risk')
  } catch (e) { crossErr = e }
  assert(crossErr instanceof BizError && crossErr.code === 'CROSS_TENANT', '星河风控不能访问云雀租户')
  // 直接调用审核：服务层 requireSameTenant 由 HTTP 层执行；内核层面校验云雀单的归属不通过
  assert(cloudOrder.tenantId === 't-cloud' && riskStaff.tenantId === 't-star', '审核单与员工分属不同租户')

  // 平台超管可跨租户审核
  const platform = staffCtx(app, 'm-platform')
  assert(app.auth.can(platform, 'risk:review') && app.auth.can(platform, 'tenant:manage'), '平台超管拥有全部权限')

  // 云雀风控专员可放行本租户单
  const cloudRisk = staffCtx(app, 'm-cloud-admin')
  const before = app.points.balanceOf('u-1001')
  const released = await app.risk.review(cloudOrder.id, 'release', '本租户管理员放行', cloudRisk)
  assert(released.status === 'released', '云雀管理员放行云雀冻结单成功')
  // cg1 是 0 积分券，放行后券应交付
  const cp = app.k.state.coupons.find((c) => c.recordId === cloudOrder.recordId)
  assert(!!cp && cp.status === 'available', `券放行交付至卡券账户（${cp?.code}）`)
  void before
  await app.k.close()
}

async function makeCloudFrozenOrder(app) {
  // 云雀租户：0 积分抽 SVIP（legendary 命中风控）—— 直接走 trade.draw
  const ctx = customerCtx(app, 'u-1001', '运营测试用户', 't-cloud')
  app.k.state.riskRules['t-cloud'] = {
    ...app.k.state.riskRules['t-cloud'], enabled: true,
    highValueRarities: ['legendary', 'epic'], dailyDrawThreshold: 0,
    rapidDrawMax: 0, rapidDrawSeconds: 0, blacklist: []
  }
  // SVIP 权重拉满
  const a = app.k.state.activities.find((x) => x.tenantId === 't-cloud')
  await app.k.commit([{ type: 'upsert', table: 'activities', row: { ...a, prizes: a.prizes.map((p) => ({ ...p, weight: p.id === 'cp1' ? 100 : 0 })) } }])
  const r = await app.trade.draw('cact-1', ctx, { idempotencyKey: 'cloud-frozen' })
  return app.k.state.riskOrders.find((o) => o.id === r.trade.riskOrderId)
}

async function testWALRecovery() {
  console.log('— WAL 持久化：重启后库存/积分/单据/审计全部恢复 —')
  const db = tmpDb('wal')
  let app = await createApp({ dbFile: db })
  await disableRisk(app)
  const ctx = customerCtx(app)
  await app.trade.redeem('g2', ctx, { idempotencyKey: 'persist-1' })
  const snapshot = {
    balance: app.points.balanceOf('u-1001'),
    records: app.k.state.records.length,
    coupons: app.k.state.coupons.length,
    g2remain: app.k.state.goods.find((g) => g.id === 'g2').remain,
    audit: app.k.state.auditLogs.length
  }
  await app.k.close()

  app = await createApp({ dbFile: db })
  assert(app.points.balanceOf('u-1001') === snapshot.balance, `余额恢复一致（${app.points.balanceOf('u-1001')}）`)
  assert(app.k.state.records.length === snapshot.records, '业务记录恢复')
  assert(app.k.state.coupons.length === snapshot.coupons, '卡券恢复')
  assert(app.k.state.goods.find((g) => g.id === 'g2').remain === snapshot.g2remain, '库存恢复')
  assert(app.k.state.auditLogs.length >= snapshot.audit, '审计日志恢复')
  // 重启后用相同幂等键仍是同一笔
  const again = await app.trade.redeem('g2', customerCtx(app), { idempotencyKey: 'persist-1' })
  assert(again.idempotent === true, '跨重启幂等键依旧生效（不重复兑换）')
  await app.k.close()
}

async function main() {
  await testConcurrency()
  await testIdempotency()
  await testCrashResume()
  await testReleaseCrashAndCrossDay()
  await testRecon()
  await testRbac()
  await testWALRecovery()
  if (failed) {
    console.error(`\n共 ${failed} 项失败 ❌`)
    process.exit(1)
  }
  console.log('\n全部通过 🎉')
  process.exit(0)
}
main()
