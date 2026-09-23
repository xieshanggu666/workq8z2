// 服务端原生种子：多租户活动/商品/卡券/组织成员，以及多用户积分账户。
import { ACTIVITIES } from './mock-activities.js'
import { CLOUD_ACTIVITIES, CLOUD_GOODS, CLOUD_COUPONS } from './mock-cloud.js'
import { SHOP_GOODS } from './mock-shop.js'
import { COUPONS, TASKS } from './mock-activities.js'
import { TENANTS, MEMBERS, PLATFORM_MEMBERS } from './mock-org.js'

export function buildSeed() {
  const activities = [
    ...ACTIVITIES.map((a) => ({ ...JSON.parse(JSON.stringify(a)), tenantId: 't-star', prizes: a.prizes.map((p) => ({ ...p, frozen: p.frozen || 0 })) })),
    ...CLOUD_ACTIVITIES.map((a) => ({ ...JSON.parse(JSON.stringify(a)), tenantId: 't-cloud', prizes: a.prizes.map((p) => ({ ...p, frozen: p.frozen || 0 })) }))
  ]
  const goods = [
    ...SHOP_GOODS.map((g) => ({ ...g, frozen: 0, tenantId: 't-star' })),
    ...CLOUD_GOODS.map((g) => ({ ...g, frozen: 0, tenantId: 't-cloud' }))
  ]
  return {
    tenants: TENANTS.map((t) => ({ ...t })),
    members: [...PLATFORM_MEMBERS, ...MEMBERS].map((m) => ({ ...m })),
    customRoles: [],
    activities,
    goods,
    tasks: TASKS.map((t) => ({ ...t })),
    couponTpls: [...COUPONS, ...CLOUD_COUPONS].map((c) => ({ ...c })),
    // 多用户积分账户：演示用户 + 两个并发压测用户
    balances: { 'u-1001': 1000, 'u-1002': 500, 'u-1003': 500 }
  }
}

export const DEMO_USERS = [
  { id: 'u-1001', name: '运营测试用户', avatar: '🦊' },
  { id: 'u-1002', name: '并发用户乙', avatar: '🐼' },
  { id: 'u-1003', name: '并发用户丙', avatar: '🐨' }
]
