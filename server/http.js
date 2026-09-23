// HTTP API（纯 node:http，零第三方依赖）：
// 鉴权：/api/auth/* 登录换 token；其余接口需 Authorization: Bearer <token>；
// 写接口在服务层强制 RBAC 权限位 + tenantId 归属校验；所有写操作走交易 Saga，天然幂等/可续办。
import http from 'node:http'
import { URL } from 'node:url'
import { BizError } from './util.js'
import { DEMO_USERS } from './seed.js'
import { PERMISSION_LABELS } from './mock-perms.js'

const PERMS = {
  reviewRisk: 'risk:review', ruleRisk: 'risk:rule',
  shipSend: 'ship:send', shipTrace: 'ship:trace', aftersaleReview: 'aftersale:review',
  couponRedeem: 'coupon:redeem',
  reconRun: 'recon:run', reconReview: 'recon:review', reconCompensate: 'recon:compensate',
  activityManage: 'activity:manage'
}

export function createHttpServer(app) {
  const json = (res, status, data) => {
    const body = JSON.stringify(data)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(body)
  }

  const server = http.createServer(async (req, res) => {
    try {
      await route(app, req, res, json)
    } catch (err) {
      if (err instanceof BizError) {
        json(res, err.status, { ok: false, error: { code: err.code, message: err.message } })
      } else {
        console.error('[server error]', err)
        json(res, 500, { ok: false, error: { code: 'INTERNAL', message: err.message } })
      }
    }
  })
  return server
}

async function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { resolve({}) }
    })
  })
}

function sessionOf(app, req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')
  if (!m) throw new BizError('UNAUTHORIZED', '缺少 Authorization: Bearer <token>', 401)
  return app.auth.requireSession(m[1].trim())
}

// 员工/平台接口统一 RBAC 门禁
async function requireStaffPerm(app, session, perm) {
  await app.auth.requirePerm(session, perm, 'api', PERMISSION_LABELS[perm] || perm)
}

async function route(app, req, res, json) {
  const u = new URL(req.url, 'http://localhost')
  const p = u.pathname
  const method = req.method
  const body = method === 'POST' || method === 'PATCH' ? await readBody(req) : {}

  // —— 健康检查 / 目录 ——
  if (method === 'GET' && p === '/health') return json(res, 200, { ok: true, service: 'lottery-server', ts: Date.now() })
  if (method === 'GET' && p === '/api/catalog/users') return json(res, 200, { users: DEMO_USERS })

  // —— 鉴权 ——
  if (method === 'POST' && p === '/api/auth/customer-login') {
    const user = DEMO_USERS.find((x) => x.id === body.userId) || DEMO_USERS[0]
    const { token, session } = await app.auth.loginCustomer(user.id, user.name, {
      tenantId: body.tenantId || 't-star', ip: req.socket.remoteAddress
    })
    return json(res, 200, { token, session: publicSession(session) })
  }
  if (method === 'POST' && p === '/api/auth/member-login') {
    const { token, session } = await app.auth.loginMember(body.memberId, { ip: req.socket.remoteAddress })
    return json(res, 200, { token, session: publicSession(session) })
  }
  if (method === 'POST' && p === '/api/auth/switch-tenant') {
    const session = sessionOf(app, req)
    await app.auth.switchTenant(session, body.tenantId)
    return json(res, 200, { session: publicSession(session) })
  }
  if (method === 'POST' && p === '/api/auth/logout') {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')
    if (m) app.auth.logout(m[1].trim())
    return json(res, 200, { ok: true })
  }

  const session = sessionOf(app, req)
  const tid = () => session.tenantId

  // —— 查询类 ——
  if (method === 'GET' && p === '/api/me') return json(res, 200, { session: publicSession(session) })
  if (method === 'GET' && p === '/api/dashboard') {
    return json(res, 200, dashboard(app, tid()))
  }
  if (method === 'GET' && p === '/api/activities') {
    const list = app.k.state.activities.filter((a) => a.tenantId === tid())
    return json(res, 200, { activities: list })
  }
  if (method === 'GET' && p === '/api/goods') {
    const list = app.k.state.goods.filter((g) => (g.tenantId || 't-star') === tid())
    return json(res, 200, { goods: list })
  }
  if (method === 'GET' && p === '/api/points') {
    return json(res, 200, {
      balance: app.points.balanceOf(session.userId),
      flows: app.points.flowsOf(session.userId).filter((f) => (f.tenantId || 't-star') === tid()).slice(0, 200)
    })
  }
  if (method === 'GET' && p === '/api/records') {
    const mine = body.mine !== false && session.identityKind === 'customer'
    const list = app.k.state.records
      .filter((r) => (r.tenantId || 't-star') === tid())
      .filter((r) => !mine || r.userId === session.userId)
      .sort((a, b) => b.ts - a.ts).slice(0, 200)
    return json(res, 200, { records: list })
  }
  if (method === 'GET' && p === '/api/coupons/my') {
    return json(res, 200, {
      coupons: app.k.state.coupons
        .filter((c) => (c.tenantId || 't-star') === tid() && c.userId === session.userId)
        .sort((a, b) => b.ts - a.ts)
    })
  }
  if (method === 'GET' && p === '/api/shipments') {
    const mine = session.identityKind === 'customer'
    const list = app.k.state.shipments
      .filter((o) => (o.tenantId || 't-star') === tid())
      .filter((o) => !mine || o.userId === session.userId)
      .sort((a, b) => b.ts - a.ts)
    return json(res, 200, { shipments: list })
  }
  if (method === 'GET' && p === '/api/aftersales') {
    const mine = session.identityKind === 'customer'
    const list = app.k.state.afterSales
      .filter((a) => (a.tenantId || 't-star') === tid())
      .filter((a) => !mine || a.userId === session.userId)
      .sort((a, b) => b.ts - a.ts)
    return json(res, 200, { afterSales: list })
  }
  if (method === 'GET' && p === '/api/risk/orders') {
    const list = app.k.state.riskOrders
      .filter((o) => (o.tenantId || 't-star') === tid())
      .filter((o) => session.identityKind === 'customer' ? o.userId === session.userId : true)
      .sort((a, b) => b.ts - a.ts)
    return json(res, 200, { orders: list })
  }
  if (method === 'GET' && p === '/api/risk/rules') {
    return json(res, 200, { rules: app.risk.rulesOf(tid()) })
  }
  if (method === 'GET' && p.startsWith('/api/audit')) {
    await requireStaffPerm(app, session, 'audit:view')
    const q = {
      tenantId: u.searchParams.get('tenantId') || tid(),
      module: u.searchParams.get('module') || '',
      result: u.searchParams.get('result') || '',
      traceId: u.searchParams.get('traceId') || '',
      keyword: u.searchParams.get('keyword') || ''
    }
    if (u.searchParams.get('traceId')) {
      return json(res, 200, { timeline: app.audit.timeline(q.traceId) })
    }
    return json(res, 200, { logs: app.audit.query(q).slice(0, 200) })
  }
  if (method === 'GET' && p === '/api/recon/dates') {
    const dates = new Set()
    app.k.state.records.forEach((r) => { if ((r.tenantId || 't-star') === tid()) dates.add(r.date) })
    app.k.state.taskClaims.forEach((c) => { if ((c.tenantId || 't-star') === tid()) dates.add(c.bizDate) })
    dates.add(app.k.todayDate())
    return json(res, 200, { dates: [...dates].sort().reverse() })
  }
  if (method === 'GET' && p === '/api/recon/bill') {
    const date = u.searchParams.get('date') || app.k.todayDate()
    return json(res, 200, { bill: app.recon.billOf(date, tid()) })
  }

  // —— 写：交易链路（客户）——
  if (method === 'POST' && p === '/api/draw') {
    const r = await app.trade.draw(body.activityId, session, { idempotencyKey: body.idempotencyKey })
    return json(res, 200, { ok: true, ...stripTrade(r.trade), idempotent: !!r.idempotent })
  }
  if (method === 'POST' && p === '/api/redeem') {
    const r = await app.trade.redeem(body.goodsId, session, { idempotencyKey: body.idempotencyKey })
    return json(res, 200, { ok: true, ...stripTrade(r.trade), idempotent: !!r.idempotent })
  }
  if (method === 'POST' && p === '/api/risk/appeal') {
    const row = await app.risk.appeal(body.orderId, body.reason, session)
    return json(res, 200, { ok: true, order: row })
  }
  if (method === 'POST' && p === '/api/shipments/address') {
    const row = await app.ship.submitAddress(body.shipmentId, body, session)
    return json(res, 200, { ok: true, shipment: row })
  }
  if (method === 'POST' && p === '/api/shipments/receive') {
    const row = await app.ship.receive(body.shipmentId, session)
    return json(res, 200, { ok: true, shipment: row })
  }
  if (method === 'POST' && p === '/api/shipments/trace') {
    // 客户与有权限员工均可同步本人/本租户订单
    const o = app.ship.requireShipment(body.shipmentId)
    if (session.identityKind === 'customer') {
      if (o.userId !== session.userId || (o.tenantId || 't-star') !== tid()) throw new BizError('FORBIDDEN', '只能查询自己的物流', 403)
    } else {
      await requireStaffPerm(app, session, PERMS.shipTrace)
      await app.auth.requireSameTenant(session, o.tenantId, 'ship')
    }
    const row = await app.ship.syncTrace(body.shipmentId, session)
    return json(res, 200, { ok: true, shipment: row })
  }
  if (method === 'POST' && p === '/api/aftersales/apply') {
    const row = await app.ship.applyAfterSale(body.shipmentId, body.type, body.reason, session)
    return json(res, 200, { ok: true, afterSale: row })
  }

  // —— 写：运营 ——
  if (method === 'POST' && p === '/api/risk/review') {
    await requireStaffPerm(app, session, PERMS.reviewRisk)
    const o = app.k.state.riskOrders.find((x) => x.id === body.orderId)
    if (!o) throw new BizError('ORDER_NOT_FOUND', '审核单不存在', 404)
    await app.auth.requireSameTenant(session, o.tenantId, 'risk')
    const row = await app.risk.review(body.orderId, body.action, body.note, session)
    return json(res, 200, { ok: true, order: row })
  }
  if (method === 'POST' && p === '/api/risk/rules') {
    await requireStaffPerm(app, session, PERMS.ruleRisk)
    const rules = await app.risk.updateRules(tid(), body, session)
    return json(res, 200, { ok: true, rules })
  }
  if (method === 'POST' && p === '/api/shipments/send') {
    await requireStaffPerm(app, session, PERMS.shipSend)
    const o = app.ship.requireShipment(body.shipmentId)
    await app.auth.requireSameTenant(session, o.tenantId, 'ship')
    const row = await app.ship.ship(body.shipmentId, body, session)
    return json(res, 200, { ok: true, shipment: row })
  }
  if (method === 'POST' && p === '/api/aftersales/review') {
    await requireStaffPerm(app, session, PERMS.aftersaleReview)
    const as = app.k.state.afterSales.find((x) => x.id === body.afterSaleId)
    if (!as) throw new BizError('AS_NOT_FOUND', '售后单不存在', 404)
    await app.auth.requireSameTenant(session, as.tenantId, 'aftersale')
    const row = await app.ship.reviewAfterSale(body.afterSaleId, !!body.approve, body.note || '', session)
    return json(res, 200, { ok: true, afterSale: row })
  }
  if (method === 'POST' && p === '/api/coupons/redeem') {
    await requireStaffPerm(app, session, PERMS.couponRedeem)
    const r = await app.coupons.redeem(body.code, session, body)
    return json(res, 200, { ok: true, ...r })
  }
  if (method === 'POST' && p === '/api/recon/run') {
    await requireStaffPerm(app, session, PERMS.reconRun)
    const bill = await app.recon.run(body.date || app.k.todayDate(), tid(), session)
    return json(res, 200, { ok: true, bill })
  }
  if (method === 'POST' && p === '/api/recon/diffs') {
    await requireStaffPerm(app, session, PERMS.reconRun)
    const diffs = app.recon.compute(body.date || app.k.todayDate(), tid())
    return json(res, 200, { ok: true, diffs })
  }
  if (method === 'POST' && p === '/api/recon/review') {
    await requireStaffPerm(app, session, PERMS.reconReview)
    const bill = await app.recon.review(body.date, tid(), body.note || '', session)
    return json(res, 200, { ok: true, bill })
  }
  if (method === 'POST' && p === '/api/recon/compensate') {
    await requireStaffPerm(app, session, PERMS.reconCompensate)
    const r = await app.recon.compensate(body.date, tid(), body.note || '', session)
    return json(res, 200, { ok: true, ...r, bill: undefined })
  }
  if (method === 'POST' && p === '/api/activities') {
    await requireStaffPerm(app, session, PERMS.activityManage)
    const row = await createActivity(app, body, session)
    return json(res, 200, { ok: true, activity: row })
  }

  // —— 运维：故障注入/续办/跨日（仅平台超管或本地演示令牌）——
  if (method === 'POST' && p === '/api/admin/fault') {
    if (session.identityKind !== 'platform') throw new BizError('FORBIDDEN', '仅平台方可注入故障', 403)
    app.k.injectFault(body.name)
    return json(res, 200, { ok: true, injected: body.name })
  }
  if (method === 'POST' && p === '/api/admin/resume') {
    if (session.identityKind !== 'platform') throw new BizError('FORBIDDEN', '仅平台方可执行续办', 403)
    const trades = await app.trade.resumeAll(session)
    const orders = await app.risk.resumeProcessing()
    return json(res, 200, { ok: true, resumedTrades: trades, resumedOrders: orders })
  }
  if (method === 'POST' && p === '/api/admin/day') {
    if (session.identityKind !== 'platform') throw new BizError('FORBIDDEN', '仅平台方可切换业务日', 403)
    if (body.day) app.k.setBusinessDay(body.day)
    else app.k.advanceDay(body.n || 1)
    const r = await app.trade.rollover(session)
    return json(res, 200, { ok: true, today: app.k.todayDate(), ...r })
  }

  json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `${method} ${p} 不存在` } })
}

function publicSession(s) {
  return {
    identityKind: s.identityKind, memberId: s.memberId, userId: s.userId,
    name: s.name, tenantId: s.tenantId
  }
}

function stripTrade(r) {
  if (!r) return {}
  const { processing, stages, ...rest } = r
  return { trade: rest }
}

async function createActivity(app, body, session) {
  const id = 'act-' + Date.now().toString(36)
  const prizes = (body.prizes || []).map((p, i) => ({
    id: `p${i}-${id}`,
    name: p.name,
    rarity: p.rarity || 'common',
    stock: p.stock || 10, remain: p.stock || 10, frozen: 0,
    weight: p.weight || 10,
    physical: p.physical !== undefined ? !!p.physical : !p.name.includes('积分'),
    emoji: p.emoji || '🎁',
    couponId: p.couponId || ''
  }))
  if (!prizes.some((p) => p.rarity === 'none')) {
    prizes.push({ id: `p-none-${id}`, name: '谢谢参与', rarity: 'none', stock: 99999, remain: 99999, frozen: 0, weight: 100, emoji: '🤝', physical: false })
  }
  const act = {
    id, tenantId: session.tenantId, name: body.name, type: body.type || 'wheel',
    status: 'running', cost: body.cost || 0, costType: body.costType || 'free',
    dailyLimit: body.dailyLimit || 3, totalLimit: body.totalLimit || 50,
    icon: '🎪', desc: body.desc || '新活动', prizes
  }
  await app.k.commit([{ type: 'upsert', table: 'activities', row: act }])
  await app.audit.log('activity-create', act.id, `新建活动【${act.name}】（${prizes.length} 个奖品）`, { tenantId: act.tenantId, ctx: session })
  return act
}

function dashboard(app, tid) {
  const inT = (x) => (x.tenantId || 't-star') === tid
  const records = app.k.state.records.filter(inT)
  const draws = records.filter((r) => r.type === 'draw' && r.status !== 'revoked')
  return {
    tenantId: tid,
    totalDraws: draws.length,
    participants: new Set(draws.map((r) => r.userId)).size,
    goodsSold: records.filter((r) => r.type === 'redeem' && r.status !== 'revoked').length,
    pendingRisk: app.k.state.riskOrders.filter((o) => inT(o) && ['pending', 'appealed'].includes(o.status)).length,
    frozenPoints: app.k.state.riskOrders.filter((o) => inT(o) && ['pending', 'appealed'].includes(o.status)).reduce((s, o) => s + (o.frozenPoints || 0), 0),
    stock: [...app.k.state.activities.filter((a) => a.tenantId === tid).flatMap((a) => a.prizes.map((p) => ({ key: `prize:${a.id}:${p.id}`, name: `${a.name}/${p.name}`, remain: p.remain, frozen: p.frozen || 0 }))),
      ...app.k.state.goods.filter((g) => inT(g)).map((g) => ({ key: `goods:${g.id}`, name: g.name, remain: g.remain, frozen: g.frozen || 0 }))],
    couponIssued: app.k.state.coupons.filter(inT).length,
    couponAvailable: app.k.state.coupons.filter((c) => inT(c) && c.status === 'available').length,
    couponRedeemed: app.k.state.coupons.filter((c) => inT(c) && c.status === 'redeemed').length,
    shipments: {
      pendingAddress: app.k.state.shipments.filter((o) => inT(o) && o.status === 'pending_address').length,
      toShip: app.k.state.shipments.filter((o) => inT(o) && o.status === 'to_ship').length,
      shipped: app.k.state.shipments.filter((o) => inT(o) && o.status === 'shipped').length,
      received: app.k.state.shipments.filter((o) => inT(o) && o.status === 'received').length,
      returned: app.k.state.shipments.filter((o) => inT(o) && o.status === 'returned').length
    },
    afterSalePending: app.k.state.afterSales.filter((a) => inT(a) && a.status === 'pending').length,
    reconBills: app.k.state.reconBills.filter((b) => inT(b)).length,
    reconOpen: app.k.state.reconBills.filter((b) => inT(b) && ['pending', 'reviewed'].includes(b.status)).length
  }
}
