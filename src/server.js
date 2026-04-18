/**
 * TETHER.BET — Crypto Game Engine Server
 * 8개 크립토 게임 Provably Fair API
 *
 * POST /api/game/play      — 베팅 + 즉시 정산 (Crash/Dice/Plinko)
 * POST /api/game/mines/start — Mines 게임 시작
 * POST /api/game/mines/reveal — Mines 타일 오픈
 * POST /api/game/mines/cashout — Mines 캐시아웃
 * POST /api/game/settle     — 가격 기반 게임 정산 (UP/DOWN/HI-LO/Spread/Futures)
 * POST /api/game/verify     — Provably Fair 검증
 * GET  /api/game/rtp        — RTP 통계
 * GET  /health              — 헬스체크
 */
const express = require('express')
const cors = require('cors')
const crypto = require('crypto')
const { createSeedSet, getResultHash, hashSeed, hmacResult } = require('./provablyFair')
const {
  crash, dice, mines, minesMultiplier, plinko,
  updownSettle, hiloSettle, spreadSettle,
  futuresSettle, futuresLiquidationPrice,
  getAllRTP, setHouseEdge, getRTP,
} = require('./games')

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 9960

// ═══════════════════════════════════════
// 인메모리 세션 (Mines 진행 중 게임)
// 프로덕션에서는 Redis로 교체 권장
// ═══════════════════════════════════════
const mineSessions = new Map()

// ═══════════════════════════════════════
// RTP 통계 (인메모리 — 프로덕션에서는 DB)
// ═══════════════════════════════════════
const rtpStats = {
  crash:   { wagered: 0, paid: 0, rounds: 0 },
  dice:    { wagered: 0, paid: 0, rounds: 0 },
  mines:   { wagered: 0, paid: 0, rounds: 0 },
  plinko:  { wagered: 0, paid: 0, rounds: 0 },
  updown:  { wagered: 0, paid: 0, rounds: 0 },
  hilo:    { wagered: 0, paid: 0, rounds: 0 },
  spread:  { wagered: 0, paid: 0, rounds: 0 },
  futures: { wagered: 0, paid: 0, rounds: 0 },
}

function updateRTP(game, wagered, paid) {
  if (!rtpStats[game]) return
  rtpStats[game].wagered += wagered
  rtpStats[game].paid += paid
  rtpStats[game].rounds += 1
}

// ═══════════════════════════════════════
// Binance 가격 조회
// ═══════════════════════════════════════
async function getBinancePrice(symbol = 'BTCUSDT') {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`)
    const d = await r.json()
    return parseFloat(d.price)
  } catch { return null }
}

// ═══════════════════════════════════════
// 헬스체크
// ═══════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'tether-crypto-engine', uptime: process.uptime() })
})

// ═══════════════════════════════════════
// POST /api/game/play — 즉시 정산 게임
// ═══════════════════════════════════════
app.post('/api/game/play', (req, res) => {
  try {
    const { game, amount, params = {} } = req.body
    if (!game || !amount || amount <= 0) {
      return res.json({ success: false, error: 'game and amount required' })
    }

    const betAmount = Math.floor(Number(amount))
    const seedSet = createSeedSet(params.clientSeed || 'default')
    seedSet.nonce = Number(params.nonce) || Math.floor(Math.random() * 1000000)
    const hash = getResultHash(seedSet)

    let gameResult, result = 'lose', payout = 0, multiplier = 0

    switch (game) {
      case 'crash': {
        gameResult = crash(hash)
        const target = Number(params.cashoutAt) || 2.0
        if (gameResult.crashPoint >= target) {
          result = 'win'
          multiplier = target
          payout = Math.floor(betAmount * target)
        } else {
          multiplier = gameResult.crashPoint
        }
        gameResult.cashoutAt = target
        break
      }

      case 'dice': {
        gameResult = dice(hash, params)
        if (gameResult.won) {
          result = 'win'
          multiplier = gameResult.multiplier
          payout = Math.floor(betAmount * multiplier)
        }
        break
      }

      case 'plinko': {
        gameResult = plinko(hash, params)
        multiplier = gameResult.multiplier
        payout = Math.floor(betAmount * multiplier)
        result = payout > betAmount ? 'win' : 'lose'
        break
      }

      default:
        return res.json({ success: false, error: `use specific endpoint for ${game}` })
    }

    updateRTP(game, betAmount, payout)

    return res.json({
      success: true,
      game,
      result,
      payout,
      multiplier,
      betAmount,
      gameData: gameResult,
      seed: {
        serverSeed: seedSet.serverSeed,
        serverSeedHash: seedSet.serverSeedHash,
        clientSeed: seedSet.clientSeed,
        nonce: seedSet.nonce,
      },
    })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ═══════════════════════════════════════
// POST /api/game/mines/start — Mines 게임 시작
// ═══════════════════════════════════════
app.post('/api/game/mines/start', (req, res) => {
  try {
    const { amount, params = {} } = req.body
    if (!amount || amount <= 0) return res.json({ success: false, error: 'amount required' })

    const betAmount = Math.floor(Number(amount))
    const seedSet = createSeedSet(params.clientSeed || 'default')
    seedSet.nonce = Number(params.nonce) || Math.floor(Math.random() * 1000000)
    const hash = getResultHash(seedSet)

    const gameResult = mines(hash, params)
    const sessionId = crypto.randomBytes(16).toString('hex')

    mineSessions.set(sessionId, {
      mines: gameResult.mines,
      mineCount: gameResult.mineCount,
      revealed: [],
      betAmount,
      seedSet,
      hash,
      createdAt: Date.now(),
    })

    // 5분 후 자동 만료
    setTimeout(() => mineSessions.delete(sessionId), 5 * 60 * 1000)

    return res.json({
      success: true,
      sessionId,
      mineCount: gameResult.mineCount,
      gridSize: 25,
      serverSeedHash: seedSet.serverSeedHash,
    })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ═══════════════════════════════════════
// POST /api/game/mines/reveal — 타일 오픈
// ═══════════════════════════════════════
app.post('/api/game/mines/reveal', (req, res) => {
  try {
    const { sessionId, tileIndex } = req.body
    const session = mineSessions.get(sessionId)
    if (!session) return res.json({ success: false, error: 'session expired' })

    const idx = Number(tileIndex)
    if (idx < 0 || idx >= 25) return res.json({ success: false, error: 'invalid tile' })
    if (session.revealed.includes(idx)) return res.json({ success: false, error: 'already revealed' })

    const isMine = session.mines.includes(idx)
    session.revealed.push(idx)

    if (isMine) {
      // 지뢰 밟음 → 게임 종료
      const payout = 0
      updateRTP('mines', session.betAmount, payout)
      mineSessions.delete(sessionId)

      return res.json({
        success: true,
        result: 'lose',
        isMine: true,
        tileIndex: idx,
        mines: session.mines,
        payout: 0,
        multiplier: 0,
        seed: {
          serverSeed: session.seedSet.serverSeed,
          serverSeedHash: session.seedSet.serverSeedHash,
          clientSeed: session.seedSet.clientSeed,
          nonce: session.seedSet.nonce,
        },
      })
    }

    // 안전 타일
    const currentMult = minesMultiplier(session.mineCount, session.revealed.length)
    const safeRemaining = 25 - session.mineCount - session.revealed.length

    return res.json({
      success: true,
      result: 'continue',
      isMine: false,
      tileIndex: idx,
      revealed: session.revealed,
      multiplier: currentMult,
      nextMultiplier: safeRemaining > 0 ? minesMultiplier(session.mineCount, session.revealed.length + 1) : currentMult,
      safeRemaining,
    })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ═══════════════════════════════════════
// POST /api/game/mines/cashout — 캐시아웃
// ═══════════════════════════════════════
app.post('/api/game/mines/cashout', (req, res) => {
  try {
    const { sessionId } = req.body
    const session = mineSessions.get(sessionId)
    if (!session) return res.json({ success: false, error: 'session expired' })

    const mult = minesMultiplier(session.mineCount, session.revealed.length)
    const payout = Math.floor(session.betAmount * mult)

    updateRTP('mines', session.betAmount, payout)
    mineSessions.delete(sessionId)

    return res.json({
      success: true,
      result: 'cashout',
      payout,
      multiplier: mult,
      revealed: session.revealed,
      mines: session.mines,
      seed: {
        serverSeed: session.seedSet.serverSeed,
        serverSeedHash: session.seedSet.serverSeedHash,
        clientSeed: session.seedSet.clientSeed,
        nonce: session.seedSet.nonce,
      },
    })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ═══════════════════════════════════════
// POST /api/game/settle — 가격 기반 게임 정산
// ═══════════════════════════════════════
app.post('/api/game/settle', async (req, res) => {
  try {
    const { game, amount, params = {} } = req.body
    if (!game || !amount) return res.json({ success: false, error: 'game and amount required' })

    const betAmount = Math.floor(Number(amount))
    const coin = params.coin || 'BTCUSDT'
    const endPrice = Number(params.endPrice) || await getBinancePrice(coin)
    if (!endPrice) return res.json({ success: false, error: 'price unavailable' })

    let gameResult, payout = 0

    switch (game) {
      case 'updown': {
        const startPrice = Number(params.startPrice)
        gameResult = updownSettle(startPrice, endPrice, params.side)
        payout = gameResult.tie ? betAmount : (gameResult.won ? Math.floor(betAmount * gameResult.multiplier) : 0)
        break
      }
      case 'hilo': {
        const targetPrice = Number(params.targetPrice)
        gameResult = hiloSettle(targetPrice, endPrice, params.side)
        payout = gameResult.tie ? betAmount : (gameResult.won ? Math.floor(betAmount * gameResult.multiplier) : 0)
        break
      }
      case 'spread': {
        const startPrice = Number(params.startPrice)
        const spreadPct = Number(params.spreadPct) || 0.01
        gameResult = spreadSettle(startPrice, endPrice, spreadPct)
        payout = gameResult.won ? Math.floor(betAmount * gameResult.multiplier) : 0
        break
      }
      case 'futures': {
        const entryPrice = Number(params.entryPrice)
        const side = params.side
        const leverage = Number(params.leverage) || 10
        gameResult = futuresSettle(entryPrice, endPrice, side, leverage, betAmount)
        payout = gameResult.payout
        break
      }
      default:
        return res.json({ success: false, error: `unknown price game: ${game}` })
    }

    updateRTP(game, betAmount, payout)

    return res.json({
      success: true,
      game,
      result: payout > betAmount ? 'win' : payout > 0 ? 'partial' : 'lose',
      payout,
      betAmount,
      endPrice,
      gameData: gameResult,
    })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ═══════════════════════════════════════
// POST /api/game/verify — Provably Fair 검증
// ═══════════════════════════════════════
app.post('/api/game/verify', (req, res) => {
  try {
    const { game, serverSeed, clientSeed, nonce } = req.body
    if (!game || !serverSeed) return res.json({ success: false, error: 'missing params' })

    const serverSeedHash = hashSeed(serverSeed)
    const hash = hmacResult(serverSeed, clientSeed || 'default', Number(nonce) || 0)

    let gameResult
    switch (game) {
      case 'crash': gameResult = crash(hash); break
      case 'dice': gameResult = dice(hash, req.body.params || {}); break
      case 'plinko': gameResult = plinko(hash, req.body.params || {}); break
      default: gameResult = { hash }
    }

    return res.json({
      success: true,
      verified: true,
      serverSeedHash,
      hash,
      gameResult,
    })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ═══════════════════════════════════════
// GET /api/game/rtp — RTP 통계 + 현재 설정
// ═══════════════════════════════════════
app.get('/api/game/rtp', (req, res) => {
  const config = getAllRTP()
  const stats = {}
  for (const [game, s] of Object.entries(rtpStats)) {
    stats[game] = {
      ...s,
      currentRTP: s.wagered > 0 ? parseFloat((s.paid / s.wagered * 100).toFixed(2)) : 0,
      targetRTP: config[game]?.rtp || 97,
      houseEdge: config[game]?.houseEdge || 0.03,
    }
  }
  res.json({ success: true, stats, config })
})

// ═══════════════════════════════════════
// POST /api/game/rtp/set — 환수율 설정 (어드민)
// ═══════════════════════════════════════
app.post('/api/game/rtp/set', (req, res) => {
  try {
    const { game, rtp, apiKey } = req.body

    // 간단 인증 (프로덕션에서는 JWT로 교체)
    const ADMIN_KEY = process.env.ADMIN_API_KEY || 'tether-crypto-admin-2026'
    if (apiKey !== ADMIN_KEY) {
      return res.status(403).json({ success: false, error: 'unauthorized' })
    }

    if (!game) {
      return res.json({ success: false, error: 'game required' })
    }

    const rtpValue = Number(rtp)
    if (rtpValue < 80 || rtpValue > 99.5) {
      return res.json({ success: false, error: 'RTP must be 80~99.5%' })
    }

    const houseEdge = parseFloat(((100 - rtpValue) / 100).toFixed(4))
    const ok = setHouseEdge(game, houseEdge)

    if (!ok) return res.json({ success: false, error: 'invalid value' })

    console.log(`[Admin] RTP changed: ${game} → ${rtpValue}% (edge: ${houseEdge})`)

    return res.json({
      success: true,
      game,
      newRTP: rtpValue,
      houseEdge,
      allConfig: getAllRTP(),
    })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ═══════════════════════════════════════
// POST /api/game/rtp/batch — 전체 환수율 일괄 설정
// ═══════════════════════════════════════
app.post('/api/game/rtp/batch', (req, res) => {
  try {
    const { settings, apiKey } = req.body

    const ADMIN_KEY = process.env.ADMIN_API_KEY || 'tether-crypto-admin-2026'
    if (apiKey !== ADMIN_KEY) {
      return res.status(403).json({ success: false, error: 'unauthorized' })
    }

    if (!settings || typeof settings !== 'object') {
      return res.json({ success: false, error: 'settings object required' })
    }

    const results = {}
    for (const [game, rtpValue] of Object.entries(settings)) {
      const rtp = Number(rtpValue)
      if (rtp >= 80 && rtp <= 99.5) {
        const edge = parseFloat(((100 - rtp) / 100).toFixed(4))
        setHouseEdge(game, edge)
        results[game] = { rtp, houseEdge: edge, status: 'ok' }
      } else {
        results[game] = { rtp, status: 'invalid (80~99.5)' }
      }
    }

    console.log('[Admin] Batch RTP update:', results)
    return res.json({ success: true, results, allConfig: getAllRTP() })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ═══════════════════════════════════════
// Binance 가격 조회 (프론트용)
// ═══════════════════════════════════════
app.get('/api/price/:symbol', async (req, res) => {
  const price = await getBinancePrice(req.params.symbol)
  if (!price) return res.json({ success: false, error: 'unavailable' })
  res.json({ success: true, symbol: req.params.symbol, price })
})

// ═══════════════════════════════════════
// 서버 시작
// ═══════════════════════════════════════
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║  TETHER.BET Crypto Game Engine          ║
║  Port: ${PORT}                              ║
║  Games: 8 (Provably Fair)               ║
║  Status: READY                           ║
╚══════════════════════════════════════════╝
  `)
})
