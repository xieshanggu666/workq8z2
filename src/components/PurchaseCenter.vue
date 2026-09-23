<template>
  <div class="po-view">
    <!-- 顶部概览 -->
    <div class="po-hero">
      <div class="hero-stats">
        <div class="hs-item">
          <span class="hs-num warn">{{ stats.pending }}</span>
          <span class="hs-lab">待审批</span>
        </div>
        <div class="hs-item">
          <span class="hs-num info">{{ stats.approved }}</span>
          <span class="hs-lab">待入库</span>
        </div>
        <div class="hs-item">
          <span class="hs-num info">{{ stats.partial }}</span>
          <span class="hs-lab">部分入库</span>
        </div>
        <div class="hs-item">
          <span class="hs-num ok">{{ stats.done }}</span>
          <span class="hs-lab">已完成</span>
        </div>
        <div class="hs-item">
          <span class="hs-num muted">{{ stats.rejected }}</span>
          <span class="hs-lab">已驳回</span>
        </div>
        <div class="hs-item">
          <span class="hs-num in">{{ stats.inboundQty }}</span>
          <span class="hs-lab">累计入库（件）</span>
        </div>
        <div class="hs-item">
          <span class="hs-num bad">{{ stats.shortReship }}</span>
          <span class="hs-lab">缺货待履约补发</span>
        </div>
      </div>
      <div class="role-box">
        <span class="role-tip">采购入库为运营端功能（发起 / 审批 / 验收职责分离）</span>
        <button v-if="!store.isOperator" class="btn-primary" @click="store.setRole('operator')">📦 切换为运营视角</button>
        <span v-else class="role-now">当前：{{ store.roleLabelOf(store.currentMember?.roleKey) }}</span>
      </div>
    </div>

    <!-- 缺货补发联动：待处理售后继续履约 -->
    <div v-if="store.isOperator && reshipWatch.length" class="card watch-card">
      <div class="card-title">🔗 缺货补发 · 待处理售后履约</div>
      <p class="op-hint">
        补发售后审核时若库存不足会保持「待审核」：采购入库补足库存后即可从此处一键继续履约（库存扣减并生成补发发货单）。
      </p>
      <div v-for="a in reshipWatch" :key="a.id" class="watch-row" :class="{ short: stockOf(a) <= 0 }">
        <span class="wr-icon">{{ a.icon }}</span>
        <div class="wr-main">
          <div class="wr-title">
            {{ a.targetName }}
            <span class="wr-status" :class="stockOf(a) > 0 ? 'ok' : 'bad'">
              {{ stockOf(a) > 0 ? `库存已补足（remain ${stockOf(a)}）` : '缺货待补（remain 0）' }}
            </span>
          </div>
          <div class="wr-sub">售后单 {{ a.id }} · 用户 {{ a.userName }} · {{ a.createdAt }} 申请 · 原因：{{ a.reason }}</div>
        </div>
        <button v-if="stockOf(a) > 0" class="btn-approve" @click="fulfill(a)">📦 继续履约（同意补发）</button>
        <button v-else-if="store.can('purchase:create')" class="btn-ghost" @click="prefillPurchase(a)">🛒 去发起采购</button>
        <span v-else class="wr-lock">🔒 待采购入库补货</span>
      </div>
    </div>

    <!-- 发起采购（purchase:create） -->
    <div v-if="store.isOperator && store.can('purchase:create')" class="card">
      <div class="card-title">🛒 发起采购（活动奖品 / 商城商品）</div>
      <div class="po-form">
        <div v-for="(line, i) in draftLines" :key="i" class="pf-row">
          <select v-model="line.key">
            <option value="">选择采购目标（奖品 / 商品）</option>
            <optgroup v-for="a in tenantActivities" :key="a.id" :label="`${a.icon} ${a.name}（活动奖品）`">
              <option v-for="p in a.prizes.filter((x) => x.rarity !== 'none')" :key="p.id"
                      :value="`prize:${a.id}:${p.id}`">
                {{ p.emoji }} {{ p.name }}（当前库存 {{ p.remain }}/{{ p.stock }}）
              </option>
            </optgroup>
            <optgroup label="🛍️ 积分商城（商品）">
              <option v-for="g in tenantGoods" :key="g.id" :value="`goods:${g.id}`">
                {{ g.icon }} {{ g.name }}（当前库存 {{ g.remain }}/{{ g.stock }}）
              </option>
            </optgroup>
          </select>
          <input v-model.number="line.qty" type="number" min="1" step="1" placeholder="数量" class="qty-input" />
          <button class="btn-ghost" :disabled="draftLines.length <= 1" @click="draftLines.splice(i, 1)">✖</button>
        </div>
        <div class="pf-row sub">
          <button class="btn-ghost" @click="draftLines.push({ key: '', qty: 10 })">＋ 添加明细</button>
          <input v-model="draftNote" placeholder="采购说明（可选）：补货原因 / 供应商 / 预算口径…" />
          <button class="btn-primary" @click="submitCreate">🛒 提交采购申请</button>
        </div>
        <p class="op-hint">提交后进入「待审批」：财务审批通过 → 物流分批验收入库；同一目标多行自动合并。</p>
      </div>
    </div>

    <!-- 采购单列表 -->
    <div class="card">
      <div class="card-title">
        📋 采购单 · {{ store.activeTenant.shortName }}
        <div class="filters">
          <button v-for="f in filters" :key="f.key"
                  :class="{ active: filter === f.key }" @click="filter = f.key">
            {{ f.label }}
            <em v-if="f.key !== 'all' && countOf(f.key)">({{ countOf(f.key) }})</em>
          </button>
        </div>
      </div>

      <div v-if="visibleOrders.length === 0" class="empty">暂无相关采购单</div>

      <div v-for="po in visibleOrders" :key="po.id" class="po-order" :class="po.status">
        <div class="o-head">
          <span class="o-icon">🛒</span>
          <div class="o-main">
            <div class="o-title">
              采购单 {{ po.id }}
              <span class="o-src">{{ po.applicant }} 发起 · {{ po.createdAt }} {{ po.createdTime }}</span>
            </div>
            <div class="o-sub">
              {{ po.note || '无采购说明' }}
              <template v-if="po.reviewer"> · {{ po.reviewedAt }} 由 {{ po.reviewer }} 审批<span v-if="po.reviewNote">：{{ po.reviewNote }}</span></template>
            </div>
          </div>
          <div class="o-progress">
            <span class="op-num">{{ receivedOf(po) }}/{{ qtyOf(po) }}</span>
            <span class="op-lab">已入库</span>
          </div>
          <span class="o-status" :class="po.status">{{ statusMeta(po.status).label }}</span>
        </div>

        <!-- 明细行 -->
        <div class="po-items">
          <div v-for="it in po.items" :key="`${it.targetType}-${it.activityId}-${it.targetId}`" class="poi-row">
            <span class="poi-icon">{{ it.icon }}</span>
            <span class="poi-name">{{ it.targetName }}</span>
            <span class="poi-type">{{ it.targetType === 'prize' ? '活动奖品' : '商城商品' }}</span>
            <span class="poi-qty">
              采购 {{ it.qty }}
              <b :class="{ done: (it.receivedQty || 0) >= it.qty }">已入库 {{ it.receivedQty || 0 }}</b>
              <em v-if="it.qty - (it.receivedQty || 0) > 0">待入库 {{ it.qty - (it.receivedQty || 0) }}</em>
            </span>
          </div>
        </div>

        <!-- 待审批：审批区（purchase:review） -->
        <div v-if="po.status === 'pending'" class="po-action">
          <template v-if="store.can('purchase:review')">
            <input v-model="reviewNoteOf(po).note" placeholder="审批意见（可选）" />
            <button class="btn-approve" @click="review(po, true)">✅ 审批通过</button>
            <button class="btn-reject" @click="review(po, false)">🚫 驳回</button>
          </template>
          <span v-else class="po-lock">🔒 等待具备「采购审批」权限的角色处理（财务对账 / 组织管理员）</span>
        </div>

        <!-- 待入库 / 部分入库：分批验收区（purchase:receive） -->
        <div v-if="po.status === 'approved' || po.status === 'partial'" class="po-action recv">
          <template v-if="store.can('purchase:receive')">
            <div class="recv-lines">
              <div v-for="it in remainingOf(po)" :key="`r-${it.targetType}-${it.activityId}-${it.targetId}`" class="recv-row">
                <span class="poi-icon">{{ it.icon }}</span>
                <span class="poi-name">{{ it.targetName }}<em>（剩余待入库 {{ it.remaining }}）</em></span>
                <input v-model.number="recvQtyOf(po, it).qty" type="number" :max="it.remaining" min="0" step="1" class="qty-input" />
              </div>
            </div>
            <div class="recv-submit">
              <input v-model="recvNoteOf(po).note" placeholder="验收备注（可选）：到货批次 / 验收情况…" />
              <button class="btn-primary" @click="receive(po)">📥 本批验收入库</button>
            </div>
          </template>
          <span v-else class="po-lock">🔒 等待具备「分批验收入库」权限的角色处理（物流客服 / 组织管理员）</span>
        </div>

        <!-- 入库批次台账 -->
        <div v-if="po.batches.length" class="batch-box">
          <div class="batch-title">📥 验收入库批次（append-only）</div>
          <div class="trace-line">
            <div v-for="b in [...po.batches].reverse()" :key="b.id" class="trace-node" :class="{ head: b.id === po.batches[po.batches.length - 1].id }">
              <i class="tn-dot"></i>
              <span class="tn-text">
                第 {{ po.batches.indexOf(b) + 1 }} 批：{{ b.lines.map((l) => `${l.targetName}×${l.qty}`).join('、') }}
                <em v-if="b.note">；{{ b.note }}</em>
              </span>
              <span class="tn-time">{{ b.operator }} · {{ b.at }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { usePlatformStore, PURCHASE_STATUS } from '@/store/platform'

const store = usePlatformStore()
const stats = computed(() => store.purchaseStats)
const statusMeta = (s) => PURCHASE_STATUS[s] || { label: s, tone: '' }

// 当前租户可采购目标
const tenantActivities = computed(() => store.activities.filter((a) => a.tenantId === store.activeTenantId))
const tenantGoods = computed(() => store.goods.filter((g) => (g.tenantId || 't-star') === store.activeTenantId))

// —— 缺货补发联动 ——
// 待审核补发售后单（缺货中的排前，便于先补货）
const reshipWatch = computed(() =>
  store.scopedAfterSales
    .filter((a) => a.status === 'pending' && a.type === 'reship')
    .sort((a, b) => (stockOf(a) <= 0 ? -1 : 0) - (stockOf(b) <= 0 ? -1 : 0)))
const stockOf = (a) => {
  const t = store._stockTargetOf(a)
  return t ? t.remain : 0
}
function fulfill(a) {
  store.reviewAfterSale(a.id, true, '采购入库补足库存，继续履约')
}
function prefillPurchase(a) {
  const key = a.targetType === 'prize' ? `prize:${a.activityId}:${a.targetId}` : `goods:${a.targetId}`
  draftLines.value = [{ key, qty: 10 }]
  draftNote.value = `售后补发缺货补货（售后单 ${a.id}）`
}

// —— 发起采购 ——
const draftLines = ref([{ key: '', qty: 10 }])
const draftNote = ref('')
function submitCreate() {
  const items = draftLines.value
    .filter((l) => l.key)
    .map((l) => {
      const [targetType, a, b] = l.key.split(':')
      return targetType === 'prize'
        ? { targetType, activityId: a, targetId: b, qty: l.qty }
        : { targetType, activityId: null, targetId: a, qty: l.qty }
    })
  if (!items.length) { store.showToast('请先选择采购目标', 'warn'); return }
  const po = store.createPurchaseOrder({ items, note: draftNote.value })
  if (po) {
    draftLines.value = [{ key: '', qty: 10 }]
    draftNote.value = ''
    filter.value = 'pending'
  }
}

// —— 列表与筛选 ——
const filters = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待审批' },
  { key: 'approved', label: '待入库' },
  { key: 'partial', label: '部分入库' },
  { key: 'done', label: '已完成' },
  { key: 'rejected', label: '已驳回' }
]
const filter = ref('all')
const orders = computed(() => store.scopedPurchaseOrders)
const visibleOrders = computed(() =>
  filter.value === 'all' ? orders.value : orders.value.filter((p) => p.status === filter.value))
const countOf = (key) => orders.value.filter((p) => p.status === key).length
const qtyOf = (po) => po.items.reduce((n, it) => n + it.qty, 0)
const receivedOf = (po) => po.items.reduce((n, it) => n + (it.receivedQty || 0), 0)
const remainingOf = (po) => store._purchaseRemaining(po).filter((it) => it.remaining > 0)

// —— 审批 ——
const reviewNotes = reactive({})
const reviewNoteOf = (po) => {
  if (!reviewNotes[po.id]) reviewNotes[po.id] = { note: '' }
  return reviewNotes[po.id]
}
function review(po, approve) {
  if (store.reviewPurchaseOrder(po.id, approve, reviewNoteOf(po).note)) {
    reviewNotes[po.id].note = ''
  }
}

// —— 分批验收 ——
const recvDrafts = reactive({})
const recvKey = (po, it) => `${po.id}|${it.targetType}|${it.activityId}|${it.targetId}`
const recvQtyOf = (po, it) => {
  const k = recvKey(po, it)
  if (!recvDrafts[k]) recvDrafts[k] = { qty: it.remaining }
  return recvDrafts[k]
}
const recvNotes = reactive({})
const recvNoteOf = (po) => {
  if (!recvNotes[po.id]) recvNotes[po.id] = { note: '' }
  return recvNotes[po.id]
}
function receive(po) {
  const lines = remainingOf(po).map((it) => ({
    targetType: it.targetType, activityId: it.activityId, targetId: it.targetId,
    qty: recvQtyOf(po, it).qty
  }))
  if (store.receivePurchaseBatch(po.id, lines, recvNoteOf(po).note)) {
    Object.keys(recvDrafts).forEach((k) => { if (k.startsWith(po.id + '|')) delete recvDrafts[k] })
    recvNotes[po.id].note = ''
  }
}
</script>

<style scoped>
.po-view { display: flex; flex-direction: column; gap: 16px; max-width: 1000px; margin: 0 auto; }

.po-hero {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  background: linear-gradient(135deg, #3a2a12, #162b55);
  border: 1px solid rgba(255,183,77,0.3); border-radius: 14px; padding: 18px 22px; flex-wrap: wrap;
}
.hero-stats { display: flex; gap: 26px; flex-wrap: wrap; }
.hs-item { display: flex; flex-direction: column; }
.hs-num { font-size: 26px; font-weight: 800; line-height: 1; }
.hs-num.warn { color: #ffb74d; }
.hs-num.info { color: #82b1ff; }
.hs-num.ok { color: #7ef0c9; }
.hs-num.muted { color: #b0bec5; }
.hs-num.bad { color: #ef9a9a; }
.hs-num.in { color: #ffd54f; }
.hs-lab { font-size: 11px; color: #9db0d0; margin-top: 5px; }
.role-box { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.role-tip { font-size: 11px; color: #9db0d0; }
.role-now { font-size: 12px; color: #82b1ff; font-weight: 600; }

.card {
  background: #0f1b38; border: 1px solid rgba(120,160,220,0.16);
  border-radius: 14px; padding: 16px;
}
.card-title {
  font-size: 15px; font-weight: 700; color: #fff; margin-bottom: 14px;
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
}
.filters { display: flex; gap: 5px; margin-left: auto; flex-wrap: wrap; }
.filters button {
  background: #13233f; border: 1px solid rgba(120,160,220,0.18); color: #8ba2c8;
  font-size: 11px; padding: 5px 10px; border-radius: 7px; cursor: pointer;
}
.filters button.active { background: #ef6c00; color: #fff; border-color: transparent; }
.filters em { font-style: normal; opacity: 0.8; }
.empty { color: #5b6f94; text-align: center; padding: 24px; font-size: 12px; }
.op-hint { font-size: 11px; color: #6f84ab; margin: 0 0 12px; }

/* 缺货补发联动 */
.watch-card { border-color: rgba(255,183,77,0.35); }
.watch-row {
  display: flex; align-items: center; gap: 10px;
  background: rgba(20,34,66,0.5); border: 1px solid rgba(120,160,220,0.14);
  border-left: 3px solid #7ef0c9; border-radius: 10px; padding: 11px 14px; margin-bottom: 8px;
}
.watch-row.short { border-left-color: #ef9a9a; }
.wr-icon { font-size: 22px; }
.wr-main { flex: 1; min-width: 0; }
.wr-title { font-size: 13px; color: #eef3fc; font-weight: 700; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wr-status { font-size: 10px; padding: 2px 8px; border-radius: 5px; font-weight: 600; }
.wr-status.ok { background: rgba(76,175,80,0.18); color: #7ef0c9; }
.wr-status.bad { background: rgba(229,115,115,0.18); color: #ef9a9a; }
.wr-sub { font-size: 10px; color: #6f84ab; margin-top: 2px; }
.wr-lock { font-size: 11px; color: #6f84ab; white-space: nowrap; }

/* 发起采购表单 */
.po-form { display: flex; flex-direction: column; gap: 8px; }
.pf-row { display: flex; gap: 8px; align-items: center; }
.pf-row select, .pf-row input {
  flex: 1; background: #0c1730; border: 1px solid rgba(120,160,220,0.2); color: #dbe4f3;
  border-radius: 8px; padding: 8px 11px; font-size: 12px; font-family: inherit;
}
.pf-row .qty-input { flex: 0 0 90px; }
.pf-row.sub .btn-primary { flex: 0 0 auto; }
.btn-primary {
  background: linear-gradient(135deg,#fb8c00,#ef6c00); color: #fff; border: none;
  border-radius: 8px; padding: 8px 18px; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap;
}
.btn-primary:hover { filter: brightness(1.08); }
.btn-ghost {
  background: transparent; border: 1px solid rgba(120,160,220,0.35); color: #aebadd;
  border-radius: 8px; padding: 7px 14px; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.btn-ghost:disabled { opacity: 0.4; cursor: not-allowed; }

/* 采购单 */
.po-order {
  background: rgba(20,34,66,0.5); border: 1px solid rgba(120,160,220,0.14);
  border-left-width: 3px; border-radius: 10px; padding: 13px 14px; margin-bottom: 10px;
}
.po-order.pending { border-left-color: #ffb74d; }
.po-order.approved { border-left-color: #42a5f5; }
.po-order.partial { border-left-color: #4db6ac; }
.po-order.done { border-left-color: #7ef0c9; }
.po-order.rejected { border-left-color: #78909c; }
.o-head { display: flex; align-items: center; gap: 10px; }
.o-icon { font-size: 24px; }
.o-main { flex: 1; min-width: 0; }
.o-title { font-size: 13px; color: #eef3fc; font-weight: 700; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.o-src { font-size: 10px; color: #8ba2c8; font-weight: 400; }
.o-sub { font-size: 10px; color: #6f84ab; margin-top: 2px; }
.o-progress { display: flex; flex-direction: column; align-items: center; flex-shrink: 0; }
.op-num { font-size: 15px; font-weight: 800; color: #ffd54f; }
.op-lab { font-size: 9px; color: #6f84ab; }
.o-status { font-size: 11px; padding: 3px 10px; border-radius: 6px; font-weight: 600; flex-shrink: 0; }
.o-status.pending { background: rgba(255,152,0,0.18); color: #ffb74d; }
.o-status.approved { background: rgba(66,165,245,0.18); color: #82b1ff; }
.o-status.partial { background: rgba(77,182,172,0.18); color: #4db6ac; }
.o-status.done { background: rgba(76,175,80,0.18); color: #7ef0c9; }
.o-status.rejected { background: rgba(144,164,174,0.18); color: #b0bec5; }

.po-items { margin-top: 10px; display: flex; flex-direction: column; gap: 5px; }
.poi-row {
  display: flex; align-items: center; gap: 8px; font-size: 12px;
  background: rgba(120,160,220,0.05); border-radius: 8px; padding: 7px 10px;
}
.poi-icon { font-size: 15px; }
.poi-name { flex: 1; color: #dbe4f3; min-width: 0; }
.poi-type { font-size: 10px; color: #6f84ab; flex-shrink: 0; }
.poi-qty { font-size: 11px; color: #8ba2c8; flex-shrink: 0; }
.poi-qty b { color: #ffd54f; margin-left: 6px; }
.poi-qty b.done { color: #7ef0c9; }
.poi-qty em { font-style: normal; color: #ffb74d; margin-left: 6px; }

.po-action { margin-top: 10px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.po-action input {
  flex: 1; min-width: 180px; background: #0c1730; border: 1px solid rgba(120,160,220,0.2); color: #dbe4f3;
  border-radius: 8px; padding: 8px 11px; font-size: 12px;
}
.po-action.recv { flex-direction: column; align-items: stretch; }
.recv-lines { display: flex; flex-direction: column; gap: 6px; }
.recv-row {
  display: flex; align-items: center; gap: 8px;
  background: rgba(77,182,172,0.06); border: 1px solid rgba(77,182,172,0.22);
  border-radius: 8px; padding: 7px 10px; font-size: 12px;
}
.recv-row .poi-name { color: #dbe4f3; }
.recv-row .poi-name em { font-style: normal; color: #ffb74d; font-size: 10px; }
.recv-row .qty-input {
  flex: 0 0 90px; background: #0c1730; border: 1px solid rgba(120,160,220,0.2); color: #dbe4f3;
  border-radius: 8px; padding: 6px 10px; font-size: 12px;
}
.recv-submit { display: flex; gap: 8px; }
.recv-submit input {
  flex: 1; background: #0c1730; border: 1px solid rgba(120,160,220,0.2); color: #dbe4f3;
  border-radius: 8px; padding: 8px 11px; font-size: 12px;
}
.po-lock { font-size: 11px; color: #6f84ab; }
.btn-approve {
  background: linear-gradient(135deg,#66bb6a,#43a047); color: #fff; border: none;
  border-radius: 8px; padding: 8px 16px; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap;
}
.btn-reject {
  background: transparent; border: 1px solid rgba(229,115,115,0.5); color: #ef9a9a;
  border-radius: 8px; padding: 8px 16px; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.btn-reject:hover { background: rgba(229,115,115,0.12); }

/* 入库批次台账 */
.batch-box {
  margin-top: 10px; background: rgba(77,182,172,0.05);
  border: 1px dashed rgba(77,182,172,0.25); border-radius: 9px; padding: 10px 12px;
}
.batch-title { font-size: 11px; font-weight: 700; color: #4db6ac; margin-bottom: 8px; }
.trace-line { display: flex; flex-direction: column; }
.trace-node {
  display: flex; align-items: baseline; gap: 8px; font-size: 11px; color: #aebadd;
  padding: 3px 0 3px 2px; position: relative;
}
.trace-node .tn-dot {
  width: 7px; height: 7px; border-radius: 50%; background: #40547e; flex-shrink: 0;
  transform: translateY(-1px);
}
.trace-node.head .tn-dot { background: #4db6ac; box-shadow: 0 0 6px rgba(77,182,172,0.7); }
.trace-node.head .tn-text { color: #eef3fc; font-weight: 600; }
.trace-node:not(:last-child) .tn-dot::after {
  content: ''; position: absolute; left: 5px; top: 14px; bottom: -6px;
  width: 1px; background: rgba(120,160,220,0.25);
}
.tn-text { flex: 1; }
.tn-text em { font-style: normal; color: #7e97c2; }
.tn-time { font-size: 10px; color: #6f84ab; white-space: nowrap; }
</style>
