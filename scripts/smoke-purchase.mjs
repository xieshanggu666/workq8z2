// 奖品采购入库 —— 逻辑冒烟测试（esbuild 打包后在 node 运行）
// 覆盖：种子数据 / RBAC 职责分离（发起-审批-验收）/ 状态机 / 分批验收入库（库存同步）/
//      越权与跨租户拦截 / 缺货补发从待处理售后继续履约 / 对账 P5 平衡与入库展示 / 看板与审计留痕
import { setActivePinia, createPinia } from 'pinia'
import { usePlatformStore } from '@/store/platform'

setActivePinia(createPinia())
const s = usePlatformStore()
s.init()

let failed = 0
const assert = (cond, msg) => {
  if (cond) console.log('  ✅', msg)
  else { console.error('  ❌', msg); failed++ }
}
const today = s.todayDate
const g3 = () => s.goods.find((g) => g.id === 'g3')
const g4 = () => s.goods.find((g) => g.id === 'g4')

console.log('— 种子：已完成 / 部分入库 / 待审批 / 已驳回 / 云雀隔离 —')
const po1 = s.purchaseOrders.find((p) => p.id === 'seed-po1')
const po2 = s.purchaseOrders.find((p) => p.id === 'seed-po2')
const po3 = s.purchaseOrders.find((p) => p.id === 'seed-po3')
const po4 = s.purchaseOrders.find((p) => p.id === 'seed-po4')
assert(po1?.status === 'done' && po1.batches.length === 2 && po1.items[0].receivedQty === 100,
  '种子：保温杯采购单已完成（两批入库 60+40）')
assert(po2?.status === 'partial' && po2.items[0].receivedQty === 40 && po2.items[0].qty === 100,
  '种子：帆布袋采购单部分入库（40/100，待入库 60）')
assert(po3?.status === 'pending' && po3.items.length === 2 && po3.batches.length === 0,
  '种子：iPhone+福袋采购单待审批（多明细行）')
assert(po4?.status === 'rejected' && po4.reviewNote.includes('预算'), '种子：购物卡采购单已驳回（留痕审批意见）')
assert(s.purchaseOrders.some((p) => p.id === 'seed-cpo1' && p.tenantId === 't-cloud'), '种子：云雀数科独立采购单')
assert(s.scopedPurchaseOrders.length === 4 && !s.scopedPurchaseOrders.some((p) => p.tenantId === 't-cloud'),
  '当前租户（星河）仅见本租户 4 张采购单（强隔离）')
assert(s.purchaseStats.pending === 1 && s.purchaseStats.partial === 1 && s.purchaseStats.done === 1 &&
  s.purchaseStats.rejected === 1 && s.purchaseStats.inboundQty === 140,
  `采购看板：待审批1/部分入库1/已完成1/已驳回1/累计入库140（实际 ${s.purchaseStats.inboundQty}）`)
assert(s.pendingPurchaseCount === 2, '采购待办角标=2（待审批1 + 部分入库1）')
assert(s.inboundOfTarget('prize', 'act-1', 'p3') === 100 && s.inboundOfTarget('goods', null, 'g3') === 40,
  '累计入库量：保温杯 100、帆布袋 40（期初 = 总库存 − 累计入库）')
assert(s.dashboard.poPending === 1 && s.dashboard.poReceiving === 1 && s.dashboard.poDone === 1 &&
  s.dashboard.poInboundQty === 140, '运营看板：采购统计同步')

console.log('— RBAC 职责分离：发起（活动运营）/ 审批（财务）/ 验收（物流） —')
s.loginAsCustomer({ silent: true })
assert(s.createPurchaseOrder({ items: [{ targetType: 'goods', activityId: null, targetId: 'g4', qty: 5 }] }) === null,
  '消费者发起采购被拦截')
s.loginAsMember('m-star-ops', { silent: true }) // 活动运营
assert(s.can('purchase:create') && !s.can('purchase:review') && !s.can('purchase:receive'),
  '活动运营：仅采购发起权限')
assert(s.reviewPurchaseOrder('seed-po3', true) === false, '活动运营审批采购被拦截')
assert(s.receivePurchaseBatch('seed-po2', [{ targetType: 'goods', activityId: null, targetId: 'g3', qty: 1 }]) === false,
  '活动运营验收入库被拦截')
s.loginAsMember('m-star-fin', { silent: true }) // 财务对账
assert(!s.can('purchase:create') && s.can('purchase:review') && !s.can('purchase:receive'),
  '财务对账：仅采购审批权限')
assert(s.createPurchaseOrder({ items: [{ targetType: 'goods', activityId: null, targetId: 'g4', qty: 5 }] }) === null,
  '财务发起采购被拦截')
assert(s.receivePurchaseBatch('seed-po2', [{ targetType: 'goods', activityId: null, targetId: 'g3', qty: 1 }]) === false,
  '财务验收入库被拦截')
s.loginAsMember('m-star-ship', { silent: true }) // 物流客服
assert(!s.can('purchase:create') && !s.can('purchase:review') && s.can('purchase:receive'),
  '物流客服：仅分批验收入库权限')
assert(s.reviewPurchaseOrder('seed-po3', true) === false, '物流审批采购被拦截')

console.log('— 发起采购：校验 / 多行合并 / 跨租户拦截 —')
s.loginAsMember('m-star-ops', { silent: true })
assert(s.createPurchaseOrder({ items: [] }) === null, '空明细被拦截')
assert(s.createPurchaseOrder({ items: [{ targetType: 'goods', activityId: null, targetId: 'g4', qty: 0 }] }) === null,
  '数量为 0 被拦截')
assert(s.createPurchaseOrder({ items: [{ targetType: 'goods', activityId: null, targetId: 'g-x', qty: 5 }] }) === null,
  '目标不存在被拦截')
assert(s.createPurchaseOrder({ items: [{ targetType: 'goods', activityId: null, targetId: 'cg2', qty: 5 }] }) === null,
  '跨租户采购云雀商品被拦截（denied 留痕）')
assert(s.auditLogs.some((l) => l.action === 'cross-tenant-denied' && l.module === 'purchase' && l.result === 'denied'),
  '跨租户采购拦截写入 denied 审计')
const poNew = s.createPurchaseOrder({
  items: [
    { targetType: 'goods', activityId: null, targetId: 'g4', qty: 10 },
    { targetType: 'goods', activityId: null, targetId: 'g4', qty: 5 },
    { targetType: 'prize', activityId: 'act-2', targetId: 'p1', qty: 3 }
  ],
  note: '测试：合并行与多品类'
})
assert(poNew?.status === 'pending' && poNew.items.length === 2, '相同目标多行自动合并（3 行 → 2 行）')
assert(poNew.items.find((i) => i.targetId === 'g4').qty === 15, '合并行数量累加（10+5=15）')
assert(poNew.tenantId === 't-star' && poNew.applicant === '运营小张', '采购单落租户与申请人')

console.log('— 审批：驳回不动库存 / 重复审批拦截 / 通过后待入库 —')
const g4StockBefore = g4().stock
s.loginAsMember('m-star-fin', { silent: true })
assert(s.reviewPurchaseOrder(poNew.id, false, '测试驳回') === true, '财务驳回成功')
assert(poNew.status === 'rejected' && g4().stock === g4StockBefore, '驳回不动库存')
assert(s.reviewPurchaseOrder(poNew.id, true) === false, '已驳回单重复审批被状态机拦截')
assert(s.reviewPurchaseOrder('seed-po3', true, '预算通过') === true, '财务审批通过 → 待入库')
assert(po3.status === 'approved' && po3.reviewer === '财务小周', '采购单待入库并留痕审批人')
assert(s.reviewPurchaseOrder('seed-po3', true) === false, '重复审批被拦截')
assert(s.reviewPurchaseOrder('seed-cpo1', true) === false, '跨租户审批云雀采购单被拦截')

console.log('— 分批验收入库：状态机 / 超量拦截 / 库存同步 —')
s.loginAsMember('m-star-ship', { silent: true })
// 待审批单不可验收
s.loginAsMember('m-star-ops', { silent: true })
const poPending = s.createPurchaseOrder({ items: [{ targetType: 'goods', activityId: null, targetId: 'g1', qty: 20 }], note: '测试：未审批不可验收' })
s.loginAsMember('m-star-ship', { silent: true })
assert(s.receivePurchaseBatch(poPending.id, [{ targetType: 'goods', activityId: null, targetId: 'g1', qty: 5 }]) === false,
  '待审批采购单验收被拦截')
assert(s.receivePurchaseBatch(poNew.id, [{ targetType: 'goods', activityId: null, targetId: 'g4', qty: 5 }]) === false,
  '已驳回采购单验收被拦截')
// 超量验收整体拦截（不落账）
const g3StockB = g3().stock
const g3RemainB = g3().remain
assert(s.receivePurchaseBatch('seed-po2', [{ targetType: 'goods', activityId: null, targetId: 'g3', qty: 61 }]) === false,
  '验收 61 超出剩余待入库 60 被拦截')
assert(g3().stock === g3StockB && g3().remain === g3RemainB && po2.items[0].receivedQty === 40,
  '超量拦截整体不落账（库存/已入库量不变）')
// 空批次拦截
assert(s.receivePurchaseBatch('seed-po2', [{ targetType: 'goods', activityId: null, targetId: 'g3', qty: 0 }]) === false,
  '全 0 数量空批次被拦截')
// 部分验收：stock/remain 同步 +=，状态保持 partial
const b2 = s.receivePurchaseBatch('seed-po2', [{ targetType: 'goods', activityId: null, targetId: 'g3', qty: 25 }], '第二批 25 件')
assert(!!b2 && b2.lines[0].qty === 25, '第二批验收 25 件成功')
assert(g3().stock === g3StockB + 25 && g3().remain === g3RemainB + 25 && po2.items[0].receivedQty === 65,
  '入库落账：stock/remain 同步 +25，累计 65/100')
assert(po2.status === 'partial' && po2.batches.length === 2, '仍为部分入库，批次台账 2 批（append-only）')
// 全部验收 → done
assert(!!s.receivePurchaseBatch('seed-po2', [{ targetType: 'goods', activityId: null, targetId: 'g3', qty: 35 }], '尾批'),
  '尾批验收 35 件')
assert(po2.status === 'done' && po2.items[0].receivedQty === 100 && g3().remain === g3RemainB + 60,
  '全部入库完成：累计 100/100，库存累计 +60')
assert(s.receivePurchaseBatch('seed-po2', [{ targetType: 'goods', activityId: null, targetId: 'g3', qty: 1 }]) === false,
  '已完成采购单不可再验收')
// 审批通过的多明细单：一次全量按行验收
const g4StockB2 = g4().stock
const g4RemainB2 = g4().remain
assert(!!s.receivePurchaseBatch('seed-po3', [
  { targetType: 'prize', activityId: 'act-1', targetId: 'p1', qty: 5 },
  { targetType: 'goods', activityId: null, targetId: 'g4', qty: 20 }
], '一次全量到货'), '多明细采购单一次全量验收')
assert(po3.status === 'done' && g4().stock === g4StockB2 + 20 && g4().remain === g4RemainB2 + 20,
  'iPhone+福袋全部入库：福袋库存 +20')

console.log('— 对账 P5：入库两侧同步，账实平衡且展示入库来源 —')
s.runRecon(today, true)
const bill = s.reconBillOf(today)
assert(bill.diffs.openCount === 0,
  `今日账实相符（openCount=${bill.diffs.openCount}：库存差异 ${bill.diffs.stock.filter((x) => x.diff).length} SKU）`)
const g3Row = bill.diffs.stock.find((x) => x.targetId === 'g3')
assert(g3Row && g3Row.inbound === 100 && g3Row.dayInbound === 60 && g3Row.diff === 0,
  `P5 帆布袋：累计入库 100、当日入库 60、账实相符（实际 inbound=${g3Row?.inbound} day=${g3Row?.dayInbound}）`)
const p3Row = bill.diffs.stock.find((x) => x.targetType === 'prize' && x.targetId === 'p3')
assert(!p3Row || p3Row.diff === 0, 'P5 保温杯账实相符（种子入库已含在总库存内）')

console.log('— 缺货补发联动：采购入库后从待处理售后继续履约 —')
// 造一笔已收货的补发售后单（兑换福袋 → 发货 → 收货 → 申请补发）
s.loginAsCustomer({ silent: true })
s.riskRules.enabled = false
const rec = s.redeem('g4')
const sp = s.shipmentOfRecord(rec.id)
s.submitShipAddress(sp.id, { receiver: '张三', phone: '13812345678', region: '北京市海淀区', address: '中关村大街1号' })
s.loginAsMember('m-star-ship', { silent: true })
s.shipShipment(sp.id, { carrier: '顺丰速运', trackingNo: 'SF999' })
s.loginAsCustomer({ silent: true })
s.receiveShipment(sp.id)
const asReship = s.applyAfterSale(sp.id, 'reship', '福袋少发一件，申请补发')
assert(asReship?.status === 'pending', '补发售后申请已提交')
// 模拟缺货（实物盘亏注入）：remain 清零后审核补发被拦截，售后单保持待审核
const g4Zero = g4().remain
g4().remain = 0
s.loginAsMember('m-star-ship', { silent: true })
assert(s.reviewAfterSale(asReship.id, true, '尝试同意') === false, '缺货：补发审核被拦截')
assert(asReship.status === 'pending', '售后单保持待审核（等待补货后继续履约）')
assert(s.shortReshipAfterSales.some((a) => a.id === asReship.id), '缺货待履约清单包含该补发单')
assert(s.purchaseStats.shortReship >= 1 && s.dashboard.poShortReship >= 1, '看板：缺货待履约补发计数同步')
// 采购补货：发起 → 审批 → 验收入库
s.loginAsMember('m-star-ops', { silent: true })
const poFix = s.createPurchaseOrder({ items: [{ targetType: 'goods', activityId: null, targetId: 'g4', qty: 10 }], note: '售后补发缺货补货' })
assert(poFix?.status === 'pending', '缺货补货采购单已发起')
s.loginAsMember('m-star-fin', { silent: true })
assert(s.reviewPurchaseOrder(poFix.id, true, '紧急补货，同意') === true, '补货采购审批通过')
s.loginAsMember('m-star-ship', { silent: true })
const stockB4 = g4().stock
assert(!!s.receivePurchaseBatch(poFix.id, [{ targetType: 'goods', activityId: null, targetId: 'g4', qty: 10 }], '加急到货'),
  '补货采购验收入库 10 件')
assert(g4().remain === 10 && g4().stock === stockB4 + 10, '库存补足：remain 0→10')
assert(s.fulfillableReshipAfterSales.some((a) => a.id === asReship.id), '库存已补足：补发单可继续履约')
assert(s.shortReshipAfterSales.length === 0, '缺货待履约清单清空')
// 从待处理售后继续履约：审核通过 → 扣库存 + 生成补发发货单
assert(s.reviewAfterSale(asReship.id, true, '采购入库补足库存，继续履约') === true, '待处理售后继续履约成功')
assert(asReship.status === 'done' && !!asReship.reshipmentId && g4().remain === 9,
  '履约落账：库存 -1，生成补发发货单')
const reship = s.shipments.find((o) => o.id === asReship.reshipmentId)
assert(reship?.status === 'to_ship' && reship.source === '售后补发' && reship.receiver === '张三',
  '补发单进入待发货队列（沿用原收货信息）')
// 盘点找回实物（模拟盘亏复原），对账仍平衡；且 P5 行展示采购入库来源
g4().remain += g4Zero // 找回清零前实物（补发消耗的 1 件由售后勾稽口径承担）
s.runRecon(today, true)
const bill2 = s.reconBillOf(today)
assert(bill2.diffs.openCount === 0, `履约+找回后对账平衡（openCount=${bill2.diffs.openCount}）`)
const g4Row = bill2.diffs.stock.find((x) => x.targetId === 'g4')
assert(g4Row && g4Row.inbound === 30 && g4Row.diff === 0,
  `P5 福袋：累计入库 30（审批单 20 + 补货 10）、账实相符（实际 inbound=${g4Row?.inbound}）`)

console.log('— 审计留痕 —')
;['purchase-create', 'purchase-approve', 'purchase-reject', 'purchase-receive'].forEach((a) => {
  assert(s.auditLogs.some((l) => l.action === a && l.module === 'purchase'), `操作记录包含「${a}」（采购入库模块）`)
})
assert(s.auditLogs.some((l) => l.action === 'purchase-receive' && l.detail.includes('累计入库')),
  '验收入库留痕含累计入库进度')
assert(s.auditLogs.some((l) => l.action === 'perm-denied' && l.module === 'purchase' && l.result === 'denied'),
  '无权限采购操作写入 perm-denied 审计')

console.log(failed ? `\n共 ${failed} 项失败` : '\n全部通过 🎉')
process.exit(failed ? 1 : 0)
