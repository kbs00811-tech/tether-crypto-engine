/**
 * Round Manager — 라운드별 베팅 수집 + 밸런스 리깅
 *
 * v1.1:
 *   - 리깅 설정 DB 영구화 (setRigging 시 DB UPDATE)
 *   - 서버 시작 시 DB에서 로드 (bootstrap)
 *   - 베팅 기록은 메모리 유지 (초당 호출 많음, write-heavy)
 */
const db = require('./db')

// ═══════════════════════════════════════
// 리깅 설정 (메모리 캐시 — 진실 소스는 DB)
// 서버 시작 시 bootstrap()에서 DB 로드
// ═══════════════════════════════════════
let riggingConfig = {
  updown:  { enabled: true, threshold: 60 },
  hilo:    { enabled: true, threshold: 60 },
  spread:  { enabled: false, threshold: 60 },
  futures: { enabled: true, threshold: 60 },
}

async function bootstrap() {
  const loaded = await db.loadRigging()
  if (loaded && Object.keys(loaded).length > 0) {
    riggingConfig = { ...riggingConfig, ...loaded }
    console.log('[roundManager] 리깅 설정 DB 로드됨:', Object.keys(loaded).length, '개 게임')
  }
}

// ═══════════════════════════════════════
// 라운드 베팅 저장소 (인메모리 — 초단기 집계용)
// ═══════════════════════════════════════
const rounds = new Map()

function cleanupOldRounds() {
  const now = Date.now()
  for (const [key, data] of rounds) {
    if (now - data.createdAt > 5 * 60 * 1000) rounds.delete(key)
  }
}
setInterval(cleanupOldRounds, 60 * 1000)

function recordBet(game, roundId, side, amount) {
  const key = `${game}:${roundId}`
  if (!rounds.has(key)) {
    rounds.set(key, { sides: {}, createdAt: Date.now() })
  }
  const round = rounds.get(key)
  if (!round.sides[side]) round.sides[side] = { count: 0, total: 0 }
  round.sides[side].count += 1
  round.sides[side].total += Number(amount)
}

function getLosingSide(game, roundId) {
  const cfg = riggingConfig[game]
  if (!cfg || !cfg.enabled) return null
  const key = `${game}:${roundId}`
  const round = rounds.get(key)
  if (!round) return null

  const sideNames = Object.keys(round.sides)
  if (sideNames.length < 2) return null

  const totalAll = sideNames.reduce((sum, s) => sum + round.sides[s].total, 0)
  if (totalAll <= 0) return null

  const threshold = (cfg.threshold || 60) / 100
  for (const side of sideNames) {
    const ratio = round.sides[side].total / totalAll
    if (ratio >= threshold) return side
  }
  return null
}

function overrideResult(betSide, losingSide) {
  if (!losingSide) return null
  if (betSide === losingSide) return 'lose'
  return 'win'
}

function getRoundSummary(game, roundId) {
  const key = `${game}:${roundId}`
  const round = rounds.get(key)
  if (!round) return null

  const sides = {}
  let totalAll = 0
  for (const [side, data] of Object.entries(round.sides)) {
    sides[side] = { ...data }
    totalAll += data.total
  }
  for (const side of Object.keys(sides)) {
    sides[side].ratio = totalAll > 0 ? parseFloat((sides[side].total / totalAll * 100).toFixed(1)) : 0
  }
  return { game, roundId, sides, totalAll, losingSide: getLosingSide(game, roundId) }
}

// ═══════════════════════════════════════
// 어드민 설정 (write-through: DB 먼저, 그 후 메모리)
// ═══════════════════════════════════════
async function setRigging(game, enabled, threshold, updatedBy = null) {
  if (!riggingConfig[game]) riggingConfig[game] = { enabled: false, threshold: 60 }
  const nextEnabled = typeof enabled === 'boolean' ? enabled : riggingConfig[game].enabled
  const nextThreshold = (typeof threshold === 'number' && threshold >= 50 && threshold <= 90)
    ? threshold : riggingConfig[game].threshold

  // DB write-through
  const ok = await db.saveRigging(game, nextEnabled, nextThreshold, updatedBy)
  if (!ok && db.dbEnabled) {
    console.warn('[roundManager] DB save 실패 — 메모리만 업데이트')
  }

  // 메모리 갱신
  riggingConfig[game].enabled = nextEnabled
  riggingConfig[game].threshold = nextThreshold
  return riggingConfig[game]
}

function getRiggingConfig() {
  return { ...riggingConfig }
}

module.exports = {
  bootstrap,
  recordBet,
  getLosingSide,
  overrideResult,
  getRoundSummary,
  setRigging,
  getRiggingConfig,
}
