// 采购入库服务：运营按活动奖品/商城商品发起采购 → 审批 → 仓配分批验收入库 → 全部入完完结。
// 入库口径：验收批次 append-only，按实收抬升 remain/stock（P5 以 stock 账面勾稽，无需调整凭证）；
// 缺货补发联动：采购可关联 waiting_stock 售后单，入完提示从待处理售后继续履约。
import { genId, BizError } from '../util.js'

export class PurchaseService {
  constructor(k, audit, inventory) {
    this.k = k
    this.audit = audit
    this.inventory = inventory
  }

  requireOrder(poId) {
    const po = this.k.state.purchaseOrders.find((x) => x.id === poId)
    if (!po) throw new BizError('PO_NOT_FOUND', '采购单不存在', 404)
    return po
  }

  // 采购目标定位（奖品按活动维度 / 商品按 goodsId）
  targetOf(targetType, activityId, targetId) {
    if (targetType === 'prize') {
      const a = this.k.state.activities.find((x) => x.id === activityId)
      const p = a?.prizes.find((x) => x.id === targetId)
      if (!a || !p) throw new BizError('TARGET_MISSING', '采购目标（活动奖品）不存在', 404)
      return { row: p, activityName: a.name, targetName: `${a.name} / ${p.name}`, icon: p.emoji || '🎁', tenantId: a.tenantId }
    }
    const g = this.k.state.goods.find((x) => x.id === targetId)
    if (!g) throw new BizError('TARGET_MISSING', '采购目标（商城商品）不存在', 404)
    return { row: g, activityName: '', targetName: g.name, icon: g.icon || '🛍️', tenantId: g.tenantId || 't-star' }
  }

  // 发起采购申请（RBAC 在 http 层校验 purchase:apply；租户归属与目标校验在此）
  async createOrder(form, ctx) {
    const targetType = form.targetType === 'prize' ? 'prize' : 'goods'
    const t = this.targetOf(targetType, form.activityId || null, form.targetId)
    if (t.tenantId !== ctx.tenantId) throw new BizError('FORBIDDEN', '采购目标不属于当前租户', 403)
    const qty = Math.floor(Number(form.qty) || 0)
    if (qty <= 0) throw new BizError('BAD_FORM', '采购数量需为正整数')
    if (qty > 9999) throw new BizError('BAD_FORM', '单笔采购数量不超过 9999')
    const reason = (form.reason || '').trim()
    if (!reason) throw new BizError('BAD_FORM', '请填写采购事由')

    // 关联待补货售后单（缺货补发履约链路）
    let linked = null
    if (form.afterSaleId) {
      linked = this.k.state.afterSales.find((a) => a.id === form.afterSaleId)
      if (!linked || (linked.tenantId || 't-star') !== ctx.tenantId ||
          linked.status !== 'waiting_stock' || linked.type !== 'reship' ||
          linked.targetType !== targetType || linked.targetId !== form.targetId ||
          (targetType === 'prize' && linked.activityId !== form.activityId)) {
        throw new BizError('BAD_LINK', '关联售后单状态与采购目标不匹配', 409)
      }
    }

    const traceId = this.k.newTraceId()
    const po = {
      id: genId('po'),
      poNo: 'PO' + Date.now().toString(36).toUpperCase() + String(Math.floor(Math.random() * 90) + 10),
      tenantId: ctx.tenantId,
      traceId,
      targetType,
      activityId: targetType === 'prize' ? form.activityId : null,
      activityName: t.activityName,
      targetId: form.targetId,
      targetName: t.targetName,
      icon: t.icon,
      qty, inboundQty: 0, status: 'pending',
      purpose: linked ? 'aftersale' : 'normal',
      purposeLabel: linked ? '售后缺货补发履约' : '日常补货',
      afterSaleId: linked ? linked.id : '',
      reason,
      applicant: ctx.name, applicantId: ctx.memberId || ctx.userId,
      createdAt: this.k.todayDate(), time: this.k.nowTime(), ts: this.k.nowTs(),
      approvedAt: '', approver: '', approveNote: '', receivedAt: '',
      batches: []
    }
    await this.k.commit([{ type: 'insert', table: 'purchaseOrders', row: po }])
    await this.audit.log('purchase-apply', po.id,
      `发起采购【${t.targetName}】×${qty}（${targetType === 'prize' ? '活动奖品' : '商城商品'}，事由：${reason}）` +
      (linked ? `；关联待补货售后单 ${linked.id}，入库后继续补发履约` : ''),
      { tenantId: ctx.tenantId, ctx, traceId })
    return po
  }

  // 审批前撤销（仅发起人本人或组织管理员/平台方；仅 pending）
  async cancelOrder(poId, ctx) {
    const po = this.requireOrder(poId)
    if (po.status !== 'pending') throw new BizError('STATE_DENIED', '仅待审批采购单可撤销', 409)
    const isAdmin = ctx.identityKind === 'platform' || ctx.roleKey === 'org_admin'
    if (!isAdmin && po.applicantId !== (ctx.memberId || ctx.userId)) {
      throw new BizError('FORBIDDEN', '只能撤销本人发起的采购申请', 403)
    }
    const row = { ...po, status: 'canceled', approveNote: '申请人撤销' }
    await this.k.commit([{ type: 'upsert', table: 'purchaseOrders', row }])
    await this.audit.log('purchase-cancel', po.id,
      `撤销采购申请【${po.targetName}】×${po.qty}（审批前撤回，库存未变动）`,
      { tenantId: po.tenantId, ctx })
    return row
  }

  // 审批（通过/驳回；仅 pending；通过不动库存，入库以验收批次为准）
  async reviewOrder(poId, approve, note, ctx) {
    const po = this.requireOrder(poId)
    if (po.status !== 'pending') throw new BizError('IDEMPOTENT', '该采购单已审批，请勿重复操作', 409)
    const remark = (note || '').trim()
    const row = {
      ...po,
      status: approve ? 'approved' : 'rejected',
      approvedAt: `${this.k.todayDate()} ${this.k.nowTime()}`,
      approver: ctx.name, approveNote: remark
    }
    await this.k.commit([{ type: 'upsert', table: 'purchaseOrders', row }])
    await this.audit.log(approve ? 'purchase-approve' : 'purchase-reject', po.id,
      approve
        ? `审批通过采购【${po.targetName}】×${po.qty}（申请人 ${po.applicant}），等待仓配分批验收入库${remark ? '；备注：' + remark : ''}`
        : `驳回采购【${po.targetName}】×${po.qty}（申请人 ${po.applicant}）${remark ? '；备注：' + remark : ''}；库存未变动`,
      { tenantId: po.tenantId, ctx })
    return row
  }

  // 分批验收入库（approved/receiving；实收 >0 且累计不超审批数量；幂等 effectId 防重复入账）
  async inbound(poId, form, ctx) {
    const po = this.requireOrder(poId)
    if (!['approved', 'receiving'].includes(po.status)) {
      throw new BizError('STATE_DENIED', '仅已审批 / 验收中的采购单可验收入库', 409)
    }
    const qty = Math.floor(Number(form.qty) || 0)
    if (qty <= 0) throw new BizError('BAD_FORM', '本次验收数量需为正整数')
    const remain = po.qty - po.inboundQty
    if (qty > remain) {
      throw new BizError('OVER_INBOUND', `本次验收 ${qty} 超过待收数量 ${remain}（审批 ${po.qty}，已收 ${po.inboundQty}）`, 409)
    }
    const t = this.targetOf(po.targetType, po.activityId, po.targetId)
    const target = this.inventory.targetOf(po.targetType, po.activityId, po.targetId)
    const traceId = this.k.newTraceId()
    const batchId = genId('pb')
    const before = t.row.remain
    // 幂等：同一批次 id 的库存抬升只生效一次（崩溃重放/重复提交安全）
    await this.inventory.receive(target, qty, `po-inbound:${batchId}`)
    const after = this.k.state.purchaseOrders.find((x) => x.id === po.id)
    const done = after.inboundQty + qty >= po.qty
    const batch = {
      id: batchId, poId: po.id, poNo: po.poNo,
      tenantId: po.tenantId, traceId,
      targetType: po.targetType, activityId: po.activityId, targetId: po.targetId,
      targetName: po.targetName, icon: po.icon,
      qty, remainBefore: before, remainAfter: before + qty,
      stockBefore: t.row.stock - qty, stockAfter: t.row.stock,
      carrier: (form.carrier || '').trim(),
      inspector: ctx.name, acceptedInbound: true,
      date: this.k.todayDate(), time: this.k.nowTime(), ts: this.k.nowTs(),
      note: (form.note || '').trim()
    }
    const row = {
      ...after,
      inboundQty: after.inboundQty + qty,
      status: done ? 'received' : 'receiving',
      receivedAt: done ? `${this.k.todayDate()} ${this.k.nowTime()}` : after.receivedAt,
      batches: [...(after.batches || []), batchId]
    }
    await this.k.commit([
      { type: 'insert', table: 'inboundBatches', row: batch },
      { type: 'upsert', table: 'purchaseOrders', row }
    ])
    await this.audit.log('purchase-inbound', po.id,
      `采购验收入库【${po.targetName}】本批 +${qty}（待收余 ${po.qty - row.inboundQty}），库存 ${before}→${before + qty}` +
      (done ? '；采购单已全部入库完成' : '，剩余批次待验收') +
      (batch.carrier ? `；供应商/承运：${batch.carrier}` : ''),
      { tenantId: po.tenantId, ctx, traceId })

    // 缺货补发联动：全部入完且关联待补货售后时，提示从待处理售后继续履约
    let resumeReady = null
    if (done && po.afterSaleId) {
      resumeReady = this.k.state.afterSales.find((a) => a.id === po.afterSaleId && a.status === 'waiting_stock') || null
      if (resumeReady) {
        await this.audit.log('aftersale-resume-ready', resumeReady.id,
          `采购 ${po.poNo} 验收入库完成，待补货售后单【${resumeReady.targetName}】库存已就绪，可从待处理售后继续补发履约`,
          { tenantId: po.tenantId, ctx, traceId })
      }
    }
    return { batch, order: row, resumeReady }
  }
}
