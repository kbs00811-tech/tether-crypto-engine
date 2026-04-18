/**
 * B2B Tenant Authentication & Seamless Wallet
 *
 * 1. API Key 인증 → 테넌트 식별
 * 2. Seamless Wallet → 업체 서버 잔액 차감/지급
 * 3. 테넌트별 설정 관리
 */
const crypto = require('crypto')

// ═══════════════════════════════════════
// 테넌트 저장소 (인메모리 — 프로덕션에서 DB로)
// ═══════════════════════════════════════
const tenants = new Map()

// 기본 테넌트 (자체 B2C — tethergame.io)
tenants.set('tether_bet_internal', {
  id: 'tether_bet_internal',
  name: 'TETHER.BET (Internal)',
  apiKey: 'tb_internal_key_2026',
  apiSecret: 'tb_internal_secret_2026',
  walletUrl: null,  // 내부는 Wallet API 불필요
  currency: 'KRW',
  allowedGames: ['crash','dice','mines','plinko','updown','hilo','spread','futures','holdem'],
  rtpConfig: {},
  riggingConfig: {},
  revenueShare: 0,
  status: 'active',
  stats: { wagered: 0, paid: 0, ggr: 0, rounds: 0 },
})

// 샌드박스 테스트 업체 (누구나 테스트 가능)
tenants.set('sandbox_demo', {
  id: 'sandbox_demo',
  name: 'Sandbox Demo',
  apiKey: 'tb_sandbox_test_key_2026',
  apiSecret: 'tb_sandbox_test_secret_2026',
  walletUrl: null,  // Mock Wallet (서버 내장)
  currency: 'USD',
  allowedGames: ['crash','dice','mines','plinko','updown','hilo','spread','futures','holdem'],
  rtpConfig: {},
  riggingConfig: {},
  revenueShare: 15,
  status: 'active',
  isSandbox: true,
  stats: { wagered: 0, paid: 0, ggr: 0, rounds: 0 },
})

// 샌드박스 Mock Wallet (가상 잔액)
const sandboxWallets = new Map()

function getSandboxBalance(playerId) {
  if (!sandboxWallets.has(playerId)) sandboxWallets.set(playerId, 10000)  // 기본 $10,000
  return sandboxWallets.get(playerId)
}

function sandboxDebit(playerId, amount) {
  const bal = getSandboxBalance(playerId)
  if (bal < amount) return { success: false, error: 'insufficient_balance', balance: bal }
  sandboxWallets.set(playerId, bal - amount)
  return { success: true, balance: bal - amount }
}

function sandboxCredit(playerId, amount) {
  const bal = getSandboxBalance(playerId)
  sandboxWallets.set(playerId, bal + amount)
  return { success: true, balance: bal + amount }
}

function sandboxRollback(playerId, amount) {
  const bal = getSandboxBalance(playerId)
  sandboxWallets.set(playerId, bal + amount)
  return { success: true, balance: bal + amount }
}

function resetSandboxWallet(playerId) {
  sandboxWallets.set(playerId, 10000)
  return { success: true, balance: 10000 }
}

// ═══════════════════════════════════════
// API Key 인증
// ═══════════════════════════════════════
function authenticateTenant(apiKey) {
  for (const [id, tenant] of tenants) {
    if (tenant.apiKey === apiKey && tenant.status === 'active') {
      return tenant
    }
  }
  return null
}

// Express 미들웨어
function b2bAuthMiddleware(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.body?.apiKey
  if (!apiKey) {
    return res.status(401).json({ success: false, error: 'API key required (X-API-Key header or apiKey body)' })
  }
  const tenant = authenticateTenant(apiKey)
  if (!tenant) {
    return res.status(403).json({ success: false, error: 'Invalid or inactive API key' })
  }
  req.tenant = tenant
  next()
}

// ═══════════════════════════════════════
// Seamless Wallet — 업체 서버 호출
// ═══════════════════════════════════════
async function walletBalance(tenant, playerId) {
  if (!tenant.walletUrl) return { success: true, balance: Infinity }  // 내부용
  try {
    const r = await fetch(`${tenant.walletUrl}/wallet/balance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Secret': tenant.apiSecret },
      body: JSON.stringify({ playerId }),
    })
    return await r.json()
  } catch (e) {
    return { success: false, error: `Wallet unreachable: ${e.message}` }
  }
}

async function walletDebit(tenant, playerId, amount, transactionId, reason) {
  if (tenant.isSandbox) return sandboxDebit(playerId, amount)
  if (!tenant.walletUrl) return { success: true, balance: 0 }  // 내부용 — B2C가 자체 처리
  try {
    const r = await fetch(`${tenant.walletUrl}/wallet/debit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Secret': tenant.apiSecret },
      body: JSON.stringify({ playerId, amount, transactionId, reason }),
    })
    return await r.json()
  } catch (e) {
    return { success: false, error: `Wallet debit failed: ${e.message}` }
  }
}

async function walletCredit(tenant, playerId, amount, transactionId, reason) {
  if (tenant.isSandbox) return sandboxCredit(playerId, amount)
  if (!tenant.walletUrl) return { success: true, balance: 0 }
  try {
    const r = await fetch(`${tenant.walletUrl}/wallet/credit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Secret': tenant.apiSecret },
      body: JSON.stringify({ playerId, amount, transactionId, reason }),
    })
    return await r.json()
  } catch (e) {
    return { success: false, error: `Wallet credit failed: ${e.message}` }
  }
}

async function walletRollback(tenant, playerId, transactionId, reason) {
  if (tenant.isSandbox) return { success: true }
  if (!tenant.walletUrl) return { success: true }
  try {
    const r = await fetch(`${tenant.walletUrl}/wallet/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Secret': tenant.apiSecret },
      body: JSON.stringify({ playerId, transactionId, reason }),
    })
    return await r.json()
  } catch (e) {
    return { success: false, error: `Wallet rollback failed: ${e.message}` }
  }
}

// ═══════════════════════════════════════
// 테넌트 관리 (어드민)
// ═══════════════════════════════════════
function registerTenant({ name, walletUrl, currency, revenueShare, allowedGames }) {
  const id = crypto.randomUUID()
  const apiKey = 'tb_' + crypto.randomBytes(24).toString('hex')
  const apiSecret = crypto.randomBytes(32).toString('hex')

  const tenant = {
    id, name, apiKey, apiSecret, walletUrl,
    currency: currency || 'USD',
    allowedGames: allowedGames || ['crash','dice','mines','plinko','updown','hilo','spread','futures'],
    rtpConfig: {},
    riggingConfig: {},
    revenueShare: revenueShare || 15,
    status: 'active',
    stats: { wagered: 0, paid: 0, ggr: 0, rounds: 0 },
    createdAt: new Date().toISOString(),
  }
  tenants.set(id, tenant)
  return tenant
}

function getTenant(id) { return tenants.get(id) || null }
function getAllTenants() { return Array.from(tenants.values()) }

function updateTenantStats(tenantId, wagered, paid) {
  const t = tenants.get(tenantId)
  if (!t) return
  t.stats.wagered += wagered
  t.stats.paid += paid
  t.stats.ggr += (wagered - paid)
  t.stats.rounds += 1
}

function setTenantRTP(tenantId, game, rtp) {
  const t = tenants.get(tenantId)
  if (!t) return null
  if (!t.rtpConfig) t.rtpConfig = {}
  t.rtpConfig[game] = rtp
  return t.rtpConfig
}

function setTenantRigging(tenantId, game, enabled, threshold) {
  const t = tenants.get(tenantId)
  if (!t) return null
  if (!t.riggingConfig) t.riggingConfig = {}
  t.riggingConfig[game] = { enabled, threshold: threshold || 60 }
  return t.riggingConfig
}

module.exports = {
  authenticateTenant,
  b2bAuthMiddleware,
  walletBalance, walletDebit, walletCredit, walletRollback,
  registerTenant, getTenant, getAllTenants,
  updateTenantStats, setTenantRTP, setTenantRigging,
  getSandboxBalance, resetSandboxWallet,
}
