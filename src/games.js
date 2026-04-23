/**
 * 8개 크립토 게임 — 서버 사이드 로직
 * 모든 결과는 Provably Fair 해시에서 결정
 * 환수율(RTP)은 houseEdge 설정으로 동적 조정 가능
 */
const { hashToFloat, hashToInt } = require('./provablyFair')

// ═══════════════════════════════════════
// 환수율 설정 (어드민 API로 변경 가능)
// houseEdge = 1 - RTP (예: 0.03 = 97% RTP)
// ═══════════════════════════════════════
const houseEdgeConfig = {
  crash:   0.03,   // RTP 97%
  dice:    0.03,   // RTP 97%
  mines:   0.03,   // RTP 97%
  plinko:  0.03,   // RTP 97%
  updown:  0.025,  // RTP 97.5%
  hilo:    0.03,   // RTP 97%
  spread:  0.05,   // RTP 95%
  futures: 0.06,   // RTP 94%
}

// ═══════════════════════════════════════
// 유저별 RTP 오버라이드 (P0 수정: 실제 게임 계산에 반영)
// 형식: { usercode: { game: rtp_decimal } } 예: { 'vip01': { dice: 1.02 } }
// ═══════════════════════════════════════
const userRtpOverride = {}

// DB 영구화 훅 — server.js가 bootstrap에서 주입
let _persistHouseEdge = null  // async (game, edge) => void
function setHouseEdgePersister(fn) { _persistHouseEdge = fn }

function getHouseEdge(game, usercode) {
  // 유저 RTP 우선 (VIP 조정)
  if (usercode && userRtpOverride[usercode]?.[game] != null) {
    return 1 - userRtpOverride[usercode][game]
  }
  return houseEdgeConfig[game] ?? 0.03
}

function getRTP(game, usercode) {
  return parseFloat(((1 - getHouseEdge(game, usercode)) * 100).toFixed(2))
}

function setHouseEdge(game, edge) {
  if (edge < 0.005 || edge > 0.20) return false
  houseEdgeConfig[game] = edge
  // DB 영구화 (있으면)
  if (_persistHouseEdge) _persistHouseEdge(game, edge).catch(e => console.warn('[houseEdge persist]', e.message))
  return true
}

function loadHouseEdgeFromDB(dbConfig) {
  if (!dbConfig || typeof dbConfig !== 'object') return
  for (const [game, edge] of Object.entries(dbConfig)) {
    if (typeof edge === 'number' && edge >= 0.005 && edge <= 0.20) {
      houseEdgeConfig[game] = edge
    }
  }
}

function setUserRtp(usercode, game, rtp) {
  if (!usercode || !game) return false
  // rtp 범위 제한: 0.80 (80%) ~ 1.20 (120%)
  const clamped = Math.max(0.80, Math.min(1.20, Number(rtp)))
  if (!userRtpOverride[usercode]) userRtpOverride[usercode] = {}
  userRtpOverride[usercode][game] = clamped
  return true
}

function deleteUserRtp(usercode, game) {
  if (!usercode) return false
  if (game) {
    if (userRtpOverride[usercode]) delete userRtpOverride[usercode][game]
  } else {
    delete userRtpOverride[usercode]
  }
  return true
}

function loadUserRtpFromDB(dbUserRtp) {
  if (!dbUserRtp || typeof dbUserRtp !== 'object') return
  for (const [usercode, games] of Object.entries(dbUserRtp)) {
    for (const [game, rtp] of Object.entries(games || {})) {
      setUserRtp(usercode, game, rtp)
    }
  }
}

function getAllRTP() {
  const result = {}
  for (const [game, edge] of Object.entries(houseEdgeConfig)) {
    result[game] = { houseEdge: edge, rtp: parseFloat(((1 - edge) * 100).toFixed(2)) }
  }
  return result
}

// (exports는 파일 하단 module.exports에 통합)

// ═══════════════════════════════════════
// 1. CRASH — 로켓 배수 게임
// ═══════════════════════════════════════
// Crash — 하우스 엣지 동적 적용 (유저 RTP 오버라이드 반영)
function crash(hash, params = {}) {
  const h = parseInt(hash.slice(0, 13), 16)
  const e = Math.pow(2, 52)
  const edge = getHouseEdge('crash', params.usercode)

  // 즉사 확률 = 하우스 엣지 (예: 3% → h%33===0)
  const instantCrashMod = Math.max(2, Math.round(1 / edge))
  if (h % instantCrashMod === 0) return { crashPoint: 1.00 }

  const crashPoint = Math.floor((100 * e * (1 - edge)) / (e - h)) / 100
  return { crashPoint: Math.min(Math.max(1.01, crashPoint), 100000) }
}

// ═══════════════════════════════════════
// 2. DICE — 주사위 (0~100 범위)
// ═══════════════════════════════════════
// RTP: 97% (배당에 0.97 반영)
function dice(hash, params) {
  const roll = hashToInt(hash, 10000) / 100  // 0.00 ~ 100.00
  const target = Number(params.target) || 50
  const isOver = params.direction === 'over'

  const won = isOver ? (roll > target) : (roll < target)
  const winChance = isOver ? (100 - target) : target
  const rtp = 100 - (getHouseEdge('dice', params.usercode) * 100)  // 🔒 유저 RTP 반영
  const multiplier = won ? parseFloat((rtp / winChance).toFixed(4)) : 0

  return { roll, target, direction: params.direction, won, multiplier, winChance }
}

// ═══════════════════════════════════════
// 3. MINES — 지뢰 찾기
// ═══════════════════════════════════════
// RTP: 97% (배당에 0.97 반영)
function mines(hash, params) {
  const mineCount = Math.min(24, Math.max(1, Number(params.mines) || 3))

  // Fisher-Yates 셔플로 지뢰 배치
  const positions = Array.from({ length: 25 }, (_, i) => i)
  for (let i = 24; i > 0; i--) {
    const j = hashToInt(hash, i, (24 - i) * 2 % 56)
    ;[positions[i], positions[j]] = [positions[j], positions[i]]
  }
  const minePositions = positions.slice(0, mineCount).sort((a, b) => a - b)

  return { mines: minePositions, mineCount, gridSize: 25 }
}

// Mines 배당 계산 (n번째 안전 타일 오픈 후) — usercode 선택적 전달
function minesMultiplier(mineCount, revealedCount, usercode) {
  if (revealedCount <= 0) return 1
  let mult = 1
  for (let i = 0; i < revealedCount; i++) {
    mult *= (25 - mineCount - i) > 0 ? (25 - i) / (25 - mineCount - i) : 1
  }
  return parseFloat((mult * (1 - getHouseEdge('mines', usercode))).toFixed(4))
}

// ═══════════════════════════════════════
// 4. PLINKO — 핀볼 낙하
// ═══════════════════════════════════════
// RTP: ~97% (배당 테이블로 조정)
function plinko(hash, params) {
  const rows = 16
  const risk = params.risk || 'medium'

  // 각 핀에서 좌(0)/우(1)
  const path = []
  let position = 0
  for (let i = 0; i < rows; i++) {
    const bit = hashToInt(hash, 1, (i * 2) % 56)
    path.push(bit)
    position += bit
  }

  // 배당 테이블 (17슬롯, 0~16)
  const payouts = {
    low:    [16, 9, 2, 1.4, 1.4, 1.2, 1.1, 1.0, 0.5, 1.0, 1.1, 1.2, 1.4, 1.4, 2, 9, 16],
    medium: [110, 41, 10, 5, 3, 1.5, 1, 0.5, 0.3, 0.5, 1, 1.5, 3, 5, 10, 41, 110],
    high:   [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000],
  }
  const table = payouts[risk] || payouts.medium
  const slot = Math.min(position, table.length - 1)
  const multiplier = table[slot]

  return { path, slot, multiplier, risk, rows }
}

// ═══════════════════════════════════════
// 5. UP/DOWN — 60초 가격 예측
// ═══════════════════════════════════════
// RTP: 97.5% (배당 1.95x × 50%)
function updownSettle(startPrice, endPrice, side, usercode) {
  let won = false
  if (side === 'UP' && endPrice > startPrice) won = true
  if (side === 'DOWN' && endPrice < startPrice) won = true
  if (endPrice === startPrice) return { won: false, tie: true, multiplier: 1.0 }

  const payout = parseFloat((2 * (1 - getHouseEdge('updown', usercode))).toFixed(4))
  return { won, tie: false, multiplier: won ? payout : 0 }
}

// ═══════════════════════════════════════
// 6. HI/LO — 목표가 예측
// ═══════════════════════════════════════
// RTP: 97% (배당 1.97x)
function hiloSettle(targetPrice, endPrice, side, usercode) {
  let won = false
  if (side === 'HIGHER' && endPrice > targetPrice) won = true
  if (side === 'LOWER' && endPrice < targetPrice) won = true
  if (endPrice === targetPrice) return { won: false, tie: true, multiplier: 1.0 }

  const payout = parseFloat((2 * (1 - getHouseEdge('hilo', usercode))).toFixed(4))
  return { won, tie: false, multiplier: won ? payout : 0 }
}

// ═══════════════════════════════════════
// 7. SPREAD — 가격 범위 예측 (180초)
// ═══════════════════════════════════════
// RTP: 95%
function spreadSettle(startPrice, endPrice, spreadPct) {
  const high = startPrice * (1 + spreadPct)
  const low = startPrice * (1 - spreadPct)
  const inRange = endPrice >= low && endPrice <= high

  // 스프레드별 배당
  let payout = 1.2
  if (spreadPct <= 0.005) payout = 3.5
  else if (spreadPct <= 0.01) payout = 2.2
  else if (spreadPct <= 0.02) payout = 1.6

  return { won: inRange, multiplier: inRange ? payout : 0, rangeHigh: high, rangeLow: low }
}

// ═══════════════════════════════════════
// 8. FUTURES — 레버리지 포지션
// ═══════════════════════════════════════
// RTP: ~94% (수수료 + 스프레드)
function futuresSettle(entryPrice, exitPrice, side, leverage, amount) {
  const fee = 0.00025  // 0.025% 수수료 (바이낸스 동일)
  const diff = exitPrice - entryPrice
  const pctChange = diff / entryPrice
  const leveragedPct = side === 'LONG' ? pctChange * leverage : -pctChange * leverage

  // 청산 체크 (100% 손실 — 바이낸스 동일)
  const isLiquidated = leveragedPct <= -1.0

  const grossPnl = isLiquidated ? -amount : amount * leveragedPct
  const feeAmount = amount * fee * 2  // 진입 + 청산
  const netPnl = grossPnl - feeAmount

  const payout = Math.max(0, amount + netPnl)
  const multiplier = payout / amount

  return {
    won: netPnl > 0,
    isLiquidated,
    pctChange: parseFloat((pctChange * 100).toFixed(4)),
    leveragedPct: parseFloat((leveragedPct * 100).toFixed(2)),
    grossPnl: Math.floor(grossPnl),
    feeAmount: Math.floor(feeAmount),
    netPnl: Math.floor(netPnl),
    payout: Math.floor(payout),
    multiplier: parseFloat(multiplier.toFixed(4)),
  }
}

// 청산가 계산
function futuresLiquidationPrice(entryPrice, side, leverage) {
  const pct = 1.0 / leverage
  return side === 'LONG'
    ? parseFloat((entryPrice * (1 - pct)).toFixed(2))
    : parseFloat((entryPrice * (1 + pct)).toFixed(2))
}

module.exports = {
  crash, dice, mines, minesMultiplier, plinko,
  updownSettle, hiloSettle, spreadSettle,
  futuresSettle, futuresLiquidationPrice,
  houseEdgeConfig, getHouseEdge, getRTP, setHouseEdge, getAllRTP,
  // 🆕 유저 RTP + DB 영구화 훅
  setUserRtp, deleteUserRtp, loadUserRtpFromDB,
  loadHouseEdgeFromDB, setHouseEdgePersister,
}
