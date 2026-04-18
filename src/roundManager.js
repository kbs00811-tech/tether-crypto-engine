/**
 * Round Manager — 라운드별 베팅 수집 + 밸런스 리깅
 *
 * 가격 기반 게임 (UP/DOWN, HI/LO, Spread, Futures)에서:
 *   1. 라운드 시작 시 베팅 수집
 *   2. 양쪽 금액 합산
 *   3. 한쪽이 threshold(기본 60%) 이상이면 그 쪽 패배
 *   4. 어드민 ON/OFF 가능
 */

// ═══════════════════════════════════════
// 리깅 설정 (어드민 API로 변경 가능)
// ═══════════════════════════════════════
const riggingConfig = {
  updown:  { enabled: true, threshold: 60 },
  hilo:    { enabled: true, threshold: 60 },
  spread:  { enabled: false, threshold: 60 },  // Spread는 양방 아니라 기본 OFF
  futures: { enabled: true, threshold: 60 },
}

// ═══════════════════════════════════════
// 라운드 베팅 저장소 (인메모리)
// key: "game:roundId" → { sideA: { count, total }, sideB: { count, total } }
// ═══════════════════════════════════════
const rounds = new Map()

// 라운드 자동 만료 (5분)
function cleanupOldRounds() {
  const now = Date.now()
  for (const [key, data] of rounds) {
    if (now - data.createdAt > 5 * 60 * 1000) rounds.delete(key)
  }
}
setInterval(cleanupOldRounds, 60 * 1000)

// ═══════════════════════════════════════
// 베팅 기록
// ═══════════════════════════════════════
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

// ═══════════════════════════════════════
// 밸런스 체크 — 어느 쪽이 패배해야 하는지
// returns: side 문자열 (패배해야 할 쪽) 또는 null (리깅 안 함)
// ═══════════════════════════════════════
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
    if (ratio >= threshold) {
      return side  // 이 쪽이 60% 이상 → 이 쪽이 패배
    }
  }

  return null  // 비슷하면 리깅 안 함
}

// ═══════════════════════════════════════
// 결과 오버라이드
// betSide: 유저가 건 쪽
// losingSide: 패배해야 할 쪽 (getLosingSide 결과)
// returns: 'win' | 'lose' | null
// ═══════════════════════════════════════
function overrideResult(betSide, losingSide) {
  if (!losingSide) return null
  if (betSide === losingSide) return 'lose'
  return 'win'
}

// ═══════════════════════════════════════
// 라운드 요약 조회
// ═══════════════════════════════════════
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
// 어드민 설정
// ═══════════════════════════════════════
function setRigging(game, enabled, threshold) {
  if (!riggingConfig[game]) riggingConfig[game] = { enabled: false, threshold: 60 }
  if (typeof enabled === 'boolean') riggingConfig[game].enabled = enabled
  if (typeof threshold === 'number' && threshold >= 50 && threshold <= 90) {
    riggingConfig[game].threshold = threshold
  }
  return riggingConfig[game]
}

function getRiggingConfig() {
  return { ...riggingConfig }
}

module.exports = {
  recordBet,
  getLosingSide,
  overrideResult,
  getRoundSummary,
  setRigging,
  getRiggingConfig,
}
