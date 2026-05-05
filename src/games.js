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
// randomFloat: hash[16..28]에서 추출한 0~1 균등분포 — Cases/Pump 등 변환 게임이 사용
function crash(hash, params = {}) {
  const h = parseInt(hash.slice(0, 13), 16)
  const e = Math.pow(2, 52)
  const edge = getHouseEdge('crash', params.usercode)
  // 별도 영역 (16~28)에서 추출 → crashPoint 결정 영역(0~13)과 독립적
  const randomFloat = hashToFloat(hash, 16)

  // 즉사 확률 = 하우스 엣지 (예: 3% → h%33===0)
  const instantCrashMod = Math.max(2, Math.round(1 / edge))
  if (h % instantCrashMod === 0) return { crashPoint: 1.00, randomFloat }

  const crashPoint = Math.floor((100 * e * (1 - edge)) / (e - h)) / 100
  return { crashPoint: Math.min(Math.max(1.01, crashPoint), 100000), randomFloat }
}

// ═══════════════════════════════════════
// 2. DICE — 주사위 2개 합 OVER/UNDER (2~12)
// ═══════════════════════════════════════
// RTP: 97% (배당에 0.97 반영)
// hash[0..7] → d1 (1~6), hash[8..15] → d2 (1~6), sum = d1 + d2 (2~12)
// target 범위: OVER 2~11, UNDER 3~12 (sum == target이면 LOSE)
const DICE_SUM_COUNTS = { 2:1, 3:2, 4:3, 5:4, 6:5, 7:6, 8:5, 9:4, 10:3, 11:2, 12:1 }
function diceWinChance(target, isOver) {
  let count = 0
  for (let s = 2; s <= 12; s++) {
    if (isOver ? s > target : s < target) count += DICE_SUM_COUNTS[s]
  }
  return (count / 36) * 100
}

function dice(hash, params) {
  const d1 = (parseInt(hash.slice(0, 8), 16) % 6) + 1   // 1~6
  const d2 = (parseInt(hash.slice(8, 16), 16) % 6) + 1  // 1~6
  const sum = d1 + d2                                   // 2~12

  const target = Math.max(2, Math.min(12, Number(params.target) || 7))
  const isOver = params.direction === 'over'

  const won = isOver ? (sum > target) : (sum < target)
  const winChance = diceWinChance(target, isOver)
  const rtp = 100 - (getHouseEdge('dice', params.usercode) * 100)  // 🔒 유저 RTP 반영
  const multiplier = won && winChance > 0 ? parseFloat((rtp / winChance).toFixed(4)) : 0

  // roll 필드는 호환성을 위해 sum 값으로 (기존 클라가 roll 참조해도 안 깨짐)
  return { roll: sum, sum, dice1: d1, dice2: d2, target, direction: params.direction, won, multiplier, winChance: parseFloat(winChance.toFixed(4)) }
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
// 3-2. PUMP — 풍선 펌프 (geometric distribution)
// ═══════════════════════════════════════
// hash → randomFloat → popAt (geometric inverse CDF) → multiplier
// P(popAt = k) = (1-p)^(k-1) × p (정확)
// RTP = 1 - houseEdge (모든 cashout 전략에서 동일)
// houseEdge: 게임 설정 (기본 0.02 = RTP 98%)
function pump(hash, params = {}) {
  const popProb = Math.max(0.001, Math.min(0.999, Number(params.popProb) || 0.10))
  const r = hashToFloat(hash, 16)  // 0~1 균등 (crashPoint 영역과 독립)
  // inverse CDF — 정확한 geometric 분포
  const popAt = Math.max(1, Math.floor(Math.log(1 - r) / Math.log(1 - popProb)) + 1)
  const houseEdge = getHouseEdge('pump', params.usercode) || 0.02
  // popAt-1까지 cashout 가능 → 최대 multiplier = (1-h) / (1-p)^(popAt-1)
  const maxMultiplier = parseFloat(((1 - houseEdge) / Math.pow(1 - popProb, popAt - 1)).toFixed(6))
  return { popAt, popProb, randomFloat: r, maxMultiplier, houseEdge }
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
// RTP: ~70% (절충안 적용 — 클라이언트와 동기화)
// 보안: spreadPct 상한 0.05 (5%) — 변조 방어
function spreadSettle(startPrice, endPrice, spreadPct) {
  // P0 보안: spreadPct 클램프 (0.0001 ~ 0.05) — 사용자 변조 방어
  const safePct = Math.max(0.0001, Math.min(0.05, Number(spreadPct) || 0.01))

  const high = startPrice * (1 + safePct)
  const low = startPrice * (1 - safePct)
  const inRange = endPrice >= low && endPrice <= high

  // 스프레드별 배당 — 클라이언트 SpreadPage.jsx DEFAULT_SPREADS 와 동기화
  // 변동성 1% (BTC 평균) 기준: tight=0.9% (mult 0.9), medium=1.5%, wide=2.2%, vwide=3.5%
  // safePct 임계값으로 매핑 (변동성 변동 흡수)
  let payout = 2.6  // VWide 기본 (가장 넓은 범위)
  if (safePct <= 0.012) payout = 7.8       // Tight (~0.9% 이하)
  else if (safePct <= 0.018) payout = 4.8  // Medium (~1.5%)
  else if (safePct <= 0.028) payout = 3.5  // Wide (~2.2%)
  // else VWide payout 2.6

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
  crash, dice, mines, minesMultiplier, plinko, pump,
  updownSettle, hiloSettle, spreadSettle,
  futuresSettle, futuresLiquidationPrice,
  houseEdgeConfig, getHouseEdge, getRTP, setHouseEdge, getAllRTP,
  // 🆕 유저 RTP + DB 영구화 훅
  setUserRtp, deleteUserRtp, loadUserRtpFromDB,
  loadHouseEdgeFromDB, setHouseEdgePersister,
}
