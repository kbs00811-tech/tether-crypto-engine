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
  crash, dice, mines, minesMultiplier, plinko, pump,
  updownSettle, hiloSettle, spreadSettle,
  futuresSettle, futuresLiquidationPrice,
  getAllRTP, setHouseEdge, getRTP,
  setUserRtp: gamesSetUserRtp, deleteUserRtp: gamesDeleteUserRtp,
  loadUserRtpFromDB, loadHouseEdgeFromDB, setHouseEdgePersister,
} = require('./games')
const {
  bootstrap: bootstrapRounds,
  recordBet, getLosingSide, overrideResult,
  getRoundSummary, setRigging, getRiggingConfig,
} = require('./roundManager')
const db = require('./db')

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
  pump:    { wagered: 0, paid: 0, rounds: 0 },
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
app.post('/api/game/play', async (req, res) => {
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

    // 🔒 usercode를 params에 주입 (game 함수가 유저 RTP 오버라이드 적용)
    const paramsWithUser = { ...params, usercode: params.usercode }

    switch (game) {
      case 'crash': {
        gameResult = crash(hash, paramsWithUser)
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
        gameResult = dice(hash, paramsWithUser)
        if (gameResult.won) {
          result = 'win'
          multiplier = gameResult.multiplier
          payout = Math.floor(betAmount * multiplier)
        }
        break
      }

      case 'plinko': {
        gameResult = plinko(hash, paramsWithUser)
        multiplier = gameResult.multiplier
        payout = Math.floor(betAmount * multiplier)
        result = payout > betAmount ? 'win' : 'lose'
        break
      }

      case 'pump': {
        // popAt 결정만 (cashout은 클라가 펌프 횟수 기준 호출)
        gameResult = pump(hash, paramsWithUser)
        multiplier = 0  // 베팅 시점에는 0 — cashout 시 betAmount 반환은 별도 처리
        payout = 0
        break
      }

      default:
        return res.json({ success: false, error: `use specific endpoint for ${game}` })
    }

    updateRTP(game, betAmount, payout)

    // 🚀 즉시 응답 — DB 저장은 비동기 (응답 지연 0ms)
    res.json({
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

    // 🗄️ 응답 후 DB 저장 (fire-and-forget)
    db.saveSeed({
      serverSeed: seedSet.serverSeed, serverSeedHash: seedSet.serverSeedHash,
      clientSeed: seedSet.clientSeed, nonce: seedSet.nonce,
      game, resultHash: hash,
    }).then(seedId => {
      db.saveRound({
        seedId, game,
        usercode: params.usercode, userId: params.userId,
        betAmount, result, payout, multiplier, gameData: gameResult,
      })
    }).catch(e => console.warn('[db] play persist', e.message))
    db.bumpRTP(game, betAmount, payout)
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message })
  }
})

// ═══════════════════════════════════════
// POST /api/game/mines/start — Mines 게임 시작
// ═══════════════════════════════════════
app.post('/api/game/mines/start', async (req, res) => {
  try {
    const { amount, params = {} } = req.body
    if (!amount || amount <= 0) return res.json({ success: false, error: 'amount required' })

    const betAmount = Math.floor(Number(amount))
    const seedSet = createSeedSet(params.clientSeed || 'default')
    seedSet.nonce = Number(params.nonce) || Math.floor(Math.random() * 1000000)
    const hash = getResultHash(seedSet)

    const gameResult = mines(hash, params)
    const sessionId = crypto.randomBytes(16).toString('hex')

    // 메모리 즉시 저장 (응답 전)
    mineSessions.set(sessionId, {
      mines: gameResult.mines,
      mineCount: gameResult.mineCount,
      revealed: [],
      betAmount,
      seedSet,
      hash,
      seedId: null,  // DB 저장 후 업데이트
      usercode: params.usercode,
      createdAt: Date.now(),
    })

    // 🚀 즉시 응답
    res.json({
      success: true,
      sessionId,
      mineCount: gameResult.mineCount,
      gridSize: 25,
      serverSeedHash: seedSet.serverSeedHash,
    })

    // 🗄️ 비동기 DB 저장 (fire-and-forget)
    db.saveSeed({
      serverSeed: seedSet.serverSeed, serverSeedHash: seedSet.serverSeedHash,
      clientSeed: seedSet.clientSeed, nonce: seedSet.nonce,
      game: 'mines', resultHash: hash,
    }).then(seedId => {
      const mem = mineSessions.get(sessionId)
      if (mem) mem.seedId = seedId
      return db.createMinesSession({
        sessionId, usercode: params.usercode,
        betAmount, mineCount: gameResult.mineCount,
        mines: gameResult.mines, seedId, ttlMinutes: 60,
      })
    }).catch(e => console.warn('[db] mines/start persist', e.message))

    // 1시간 후 메모리 정리
    setTimeout(() => mineSessions.delete(sessionId), 60 * 60 * 1000)
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message })
  }
})

// ═══════════════════════════════════════
// POST /api/game/mines/reveal — 타일 오픈
// ═══════════════════════════════════════
app.post('/api/game/mines/reveal', async (req, res) => {
  try {
    const { sessionId, tileIndex } = req.body

    // 메모리 hit → DB fallback (엔진 재시작 후 복구)
    let session = mineSessions.get(sessionId)
    if (!session) {
      const dbSession = await db.getMinesSession(sessionId)
      if (dbSession) {
        session = {
          mines: dbSession.mines, mineCount: dbSession.mine_count,
          revealed: dbSession.revealed || [], betAmount: Number(dbSession.bet_amount),
          seedSet: null,  // 복구 시엔 seed 없이 동작 (보호)
          seedId: dbSession.seed_id, usercode: dbSession.usercode,
          createdAt: Date.now(),
        }
        mineSessions.set(sessionId, session)
      }
    }
    if (!session) return res.json({ success: false, error: 'session expired' })

    const idx = Number(tileIndex)
    if (idx < 0 || idx >= 25) return res.json({ success: false, error: 'invalid tile' })
    if (session.revealed.includes(idx)) return res.json({ success: false, error: 'already revealed' })

    const isMine = session.mines.includes(idx)
    session.revealed.push(idx)

    // DB 업데이트 (fire-and-forget)
    db.updateMinesReveal(sessionId, session.revealed)

    if (isMine) {
      const payout = 0
      updateRTP('mines', session.betAmount, payout)
      db.bumpRTP('mines', session.betAmount, payout)

      // DB 세션 종료 + round 저장
      db.closeMinesSession(sessionId, 'exploded', { revealed: session.revealed, mines: session.mines })
      db.saveRound({
        seedId: session.seedId, game: 'mines',
        usercode: session.usercode, sessionId,
        betAmount: session.betAmount, result: 'lose',
        payout: 0, multiplier: 0,
        gameData: { mines: session.mines, revealed: session.revealed, explodedAt: idx },
      })

      mineSessions.delete(sessionId)

      return res.json({
        success: true,
        result: 'lose',
        isMine: true,
        tileIndex: idx,
        mines: session.mines,
        payout: 0,
        multiplier: 0,
        seed: session.seedSet ? {
          serverSeed: session.seedSet.serverSeed,
          serverSeedHash: session.seedSet.serverSeedHash,
          clientSeed: session.seedSet.clientSeed,
          nonce: session.seedSet.nonce,
        } : null,
      })
    }

    // 안전 타일 — 유저 RTP 반영
    const currentMult = minesMultiplier(session.mineCount, session.revealed.length, session.usercode)
    const safeRemaining = 25 - session.mineCount - session.revealed.length

    return res.json({
      success: true,
      result: 'continue',
      isMine: false,
      tileIndex: idx,
      revealed: session.revealed,
      multiplier: currentMult,
      nextMultiplier: safeRemaining > 0 ? minesMultiplier(session.mineCount, session.revealed.length + 1, session.usercode) : currentMult,
      safeRemaining,
    })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ═══════════════════════════════════════
// POST /api/game/mines/cashout — 캐시아웃
// ═══════════════════════════════════════
app.post('/api/game/mines/cashout', async (req, res) => {
  try {
    const { sessionId } = req.body
    let session = mineSessions.get(sessionId)
    if (!session) {
      const dbSession = await db.getMinesSession(sessionId)
      if (dbSession) {
        session = {
          mines: dbSession.mines, mineCount: dbSession.mine_count,
          revealed: dbSession.revealed || [], betAmount: Number(dbSession.bet_amount),
          seedSet: null, seedId: dbSession.seed_id, usercode: dbSession.usercode,
        }
      }
    }
    if (!session) return res.json({ success: false, error: 'session expired' })

    const mult = minesMultiplier(session.mineCount, session.revealed.length, session.usercode)
    const payout = Math.floor(session.betAmount * mult)

    updateRTP('mines', session.betAmount, payout)
    db.bumpRTP('mines', session.betAmount, payout)

    // DB 저장
    db.closeMinesSession(sessionId, 'cashout', { revealed: session.revealed, mines: session.mines, payout, multiplier: mult })
    db.saveRound({
      seedId: session.seedId, game: 'mines',
      usercode: session.usercode, sessionId,
      betAmount: session.betAmount, result: 'cashout',
      payout, multiplier: mult,
      gameData: { mines: session.mines, revealed: session.revealed },
    })

    mineSessions.delete(sessionId)

    return res.json({
      success: true,
      result: 'cashout',
      payout,
      multiplier: mult,
      revealed: session.revealed,
      mines: session.mines,
      seed: session.seedSet ? {
        serverSeed: session.seedSet.serverSeed,
        serverSeedHash: session.seedSet.serverSeedHash,
        clientSeed: session.seedSet.clientSeed,
        nonce: session.seedSet.nonce,
      } : null,
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

    // 가격 게임용 seed 생성 (price fetch 전에 미리)
    const priceSeedSet = createSeedSet(params.clientSeed || 'default')
    priceSeedSet.nonce = Number(params.nonce) || Date.now()

    const endPrice = Number(params.endPrice) || await getBinancePrice(coin)
    if (!endPrice) return res.json({ success: false, error: 'price unavailable' })

    let gameResult, payout = 0
    const roundId = params.roundId || `${game}_${Date.now()}`
    const side = params.side

    // ★ 밸런스 리깅: 60% 이상 한쪽 베팅 시 그 쪽 패배
    const losingSide = getLosingSide(game, roundId)
    const riggingOverride = side ? overrideResult(side, losingSide) : null

    switch (game) {
      case 'updown': {
        const startPrice = Number(params.startPrice)
        gameResult = updownSettle(startPrice, endPrice, side, params.usercode)
        // 리깅 적용: 원래 결과를 오버라이드
        if (riggingOverride === 'lose' && gameResult.won) {
          gameResult.won = false; gameResult.multiplier = 0; gameResult.rigged = true
        } else if (riggingOverride === 'win' && !gameResult.won && !gameResult.tie) {
          gameResult.won = true; gameResult.multiplier = 1.95; gameResult.rigged = true
        }
        payout = gameResult.tie ? betAmount : (gameResult.won ? Math.floor(betAmount * gameResult.multiplier) : 0)
        break
      }
      case 'hilo': {
        const targetPrice = Number(params.targetPrice)
        gameResult = hiloSettle(targetPrice, endPrice, side, params.usercode)
        if (riggingOverride === 'lose' && gameResult.won) {
          gameResult.won = false; gameResult.multiplier = 0; gameResult.rigged = true
        } else if (riggingOverride === 'win' && !gameResult.won && !gameResult.tie) {
          gameResult.won = true; gameResult.multiplier = 1.97; gameResult.rigged = true
        }
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
        const leverage = Number(params.leverage) || 10
        gameResult = futuresSettle(entryPrice, endPrice, side, leverage, betAmount)
        if (riggingOverride === 'lose' && gameResult.won) {
          gameResult.won = false; gameResult.payout = 0; gameResult.rigged = true
          payout = 0
        } else {
          payout = gameResult.payout
        }
        break
      }
      default:
        return res.json({ success: false, error: `unknown price game: ${game}` })
    }

    updateRTP(game, betAmount, payout)
    const resultStr = payout > betAmount ? 'win' : payout > 0 ? 'partial' : 'lose'

    // 🚀 즉시 응답
    res.json({
      success: true,
      game,
      result: resultStr,
      payout,
      betAmount,
      endPrice,
      gameData: gameResult,
    })

    // 🗄️ 가격 게임도 seed + round 모두 영구화 (Provably Fair 전체 커버)
    db.saveSeed({
      serverSeed: priceSeedSet.serverSeed, serverSeedHash: priceSeedSet.serverSeedHash,
      clientSeed: priceSeedSet.clientSeed, nonce: priceSeedSet.nonce,
      game, resultHash: null,  // 가격 게임은 HMAC 대신 price 기반
    }).then(seedId => {
      db.saveRound({
        seedId, game,
        usercode: params.usercode, userId: params.userId,
        betAmount, result: resultStr,
        payout,
        multiplier: gameResult.multiplier || 0,
        gameData: { ...gameResult, endPrice, roundId, side, coin },
        overrideInfo: riggingOverride ? { riggingOverride, losingSide } : null,
      })
    }).catch(e => console.warn('[db] settle persist', e.message))
    db.bumpRTP(game, betAmount, payout)
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message })
  }
})

// ═══════════════════════════════════════
// POST /api/game/round/bet — 라운드 베팅 기록 (가격 게임용)
// B2C에서 유저 베팅 시 호출 → 서버에서 양쪽 금액 수집
// ═══════════════════════════════════════
app.post('/api/game/round/bet', (req, res) => {
  try {
    const { game, roundId, side, amount } = req.body
    if (!game || !roundId || !side || !amount) {
      return res.json({ success: false, error: 'game, roundId, side, amount required' })
    }
    recordBet(game, roundId, side, Number(amount))
    const summary = getRoundSummary(game, roundId)
    return res.json({ success: true, summary })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ═══════════════════════════════════════
// GET /api/game/round/:game/:roundId — 라운드 요약
// ═══════════════════════════════════════
app.get('/api/game/round/:game/:roundId', (req, res) => {
  const summary = getRoundSummary(req.params.game, req.params.roundId)
  res.json({ success: true, summary })
})

// ═══════════════════════════════════════
// POST /api/game/rigging/set — 리깅 설정 (어드민)
// ═══════════════════════════════════════
app.post('/api/game/rigging/set', async (req, res) => {
  try {
    const { game, enabled, threshold, apiKey, adminEmail } = req.body
    const ADMIN_KEY = process.env.ADMIN_API_KEY || 'tether-crypto-admin-2026'
    if (apiKey !== ADMIN_KEY) return res.status(403).json({ success: false, error: 'unauthorized' })

    if (!game) return res.json({ success: false, error: 'game required' })

    const result = await setRigging(game, enabled, threshold, adminEmail ? `admin:${adminEmail}` : null)
    console.log(`[Admin] Rigging ${game}: enabled=${result.enabled}, threshold=${result.threshold}%`)

    return res.json({ success: true, game, config: result, allConfig: getRiggingConfig() })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ═══════════════════════════════════════
// GET /api/game/rigging — 리깅 설정 조회
// ═══════════════════════════════════════
app.get('/api/game/rigging', (req, res) => {
  res.json({ success: true, config: getRiggingConfig() })
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
// v1.1: DB 집계 우선 (재시작해도 유지), 메모리는 당일 증분만
// ═══════════════════════════════════════
app.get('/api/game/rtp', async (req, res) => {
  const config = getAllRTP()
  const stats = {}

  // 기본: 메모리 (실시간 증분)
  for (const [game, s] of Object.entries(rtpStats)) {
    stats[game] = {
      wagered: s.wagered, paid: s.paid, rounds: s.rounds,
      currentRTP: s.wagered > 0 ? parseFloat((s.paid / s.wagered * 100).toFixed(2)) : 0,
      targetRTP: config[game]?.rtp || 97,
      houseEdge: config[game]?.houseEdge || 0.03,
    }
  }

  // DB 통계 병합 (오늘 누적) — 재시작해도 유지
  if (db.dbEnabled) {
    try {
      const { createClient } = require('@supabase/supabase-js')
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
      const { data } = await sb.from('v_crypto_engine_today').select('*')
      for (const r of (data || [])) {
        if (!stats[r.game]) {
          stats[r.game] = {
            wagered: 0, paid: 0, rounds: 0,
            targetRTP: 97, houseEdge: 0.03,
          }
        }
        // DB값이 더 신뢰도 높음 (재부팅 후 메모리는 0)
        if (Number(r.wagered) > stats[r.game].wagered) {
          stats[r.game].wagered = Number(r.wagered)
          stats[r.game].paid    = Number(r.paid)
          stats[r.game].rounds  = Number(r.rounds)
          stats[r.game].currentRTP = Number(r.rtp_pct).toFixed(2)
        }
      }
    } catch (e) { console.warn('[rtp] DB 집계 실패', e.message) }
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
// 유저별 RTP 조정 (메모리 캐시 + DB 영구)
// ═══════════════════════════════════════
const userRtpConfig = {}  // 서버 시작 시 DB 로드

app.get('/api/game/user-rtp', (req, res) => {
  const ADMIN_KEY = process.env.ADMIN_API_KEY || 'tether-crypto-admin-2026'
  if (req.query.apiKey !== ADMIN_KEY) return res.status(403).json({ success: false, error: 'unauthorized' })
  res.json({ success: true, config: userRtpConfig })
})

app.post('/api/game/user-rtp/set', async (req, res) => {
  const { usercode, adjustments, apiKey, adminEmail } = req.body
  const ADMIN_KEY = process.env.ADMIN_API_KEY || 'tether-crypto-admin-2026'
  if (apiKey !== ADMIN_KEY) return res.status(403).json({ success: false, error: 'unauthorized' })
  if (!usercode) return res.json({ success: false, error: 'usercode required' })

  const adj = adjustments || {}
  const updatedBy = adminEmail ? `admin:${adminEmail}` : null
  for (const [game, rtp] of Object.entries(adj)) {
    await db.saveUserRtp(usercode, game, Number(rtp), updatedBy)
    // 🔒 games.js 내부 저장소에도 즉시 반영 (게임 계산에 실제 적용)
    gamesSetUserRtp(usercode, game, Number(rtp))
  }
  userRtpConfig[usercode] = adj
  console.log(`[Admin] User RTP set: ${usercode}`, adj)
  res.json({ success: true, usercode, adjustments: userRtpConfig[usercode], allUsers: Object.keys(userRtpConfig) })
})

app.post('/api/game/user-rtp/delete', async (req, res) => {
  const { usercode, apiKey } = req.body
  const ADMIN_KEY = process.env.ADMIN_API_KEY || 'tether-crypto-admin-2026'
  if (apiKey !== ADMIN_KEY) return res.status(403).json({ success: false, error: 'unauthorized' })
  await db.deleteUserRtp(usercode)
  // 🔒 games.js에서도 제거
  gamesDeleteUserRtp(usercode)
  delete userRtpConfig[usercode]
  res.json({ success: true, deleted: usercode })
})

// ═══════════════════════════════════════
// GET /api/game/reveal-seed — 종료된 라운드의 seed 공개 (Provably Fair)
// ═══════════════════════════════════════
app.get('/api/game/reveal-seed/:hash', async (req, res) => {
  try {
    const data = await db.revealSeed(req.params.hash)
    if (!data) return res.json({ success: false, error: 'not_found' })
    res.json({ success: true, seed: data })
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

// ═══════════════════════════════════════════════════
// B2B API — 게임 공급 엔드포인트
// ═══════════════════════════════════════════════════
const {
  b2bAuthMiddleware, walletDebit, walletCredit, walletRollback,
  registerTenant, getAllTenants, updateTenantStats,
  setTenantRTP, setTenantRigging,
  getSandboxBalance, resetSandboxWallet,
} = require('./b2bAuth')
const {
  addGameLog, getDailyReport, getMonthlyReport, getAllTimeReport,
  getTopPlayers, generateCSV, getLogsForExport,
} = require('./settlement')

// ── 업체 등록 (마스터 어드민만)
app.post('/b2b/auth/register', (req, res) => {
  const MASTER_KEY = process.env.ADMIN_API_KEY || 'tether-crypto-admin-2026'
  if (req.body?.masterKey !== MASTER_KEY) return res.status(403).json({ success: false, error: 'unauthorized' })

  const tenant = registerTenant(req.body)
  console.log(`[B2B] New tenant: ${tenant.name} (${tenant.id})`)
  res.json({ success: true, tenant: { id: tenant.id, name: tenant.name, apiKey: tenant.apiKey, apiSecret: tenant.apiSecret } })
})

// ── 업체 목록 (마스터 어드민)
app.get('/b2b/tenants', (req, res) => {
  const MASTER_KEY = process.env.ADMIN_API_KEY || 'tether-crypto-admin-2026'
  if (req.query.masterKey !== MASTER_KEY && req.headers['x-master-key'] !== MASTER_KEY) {
    return res.status(403).json({ success: false, error: 'unauthorized' })
  }
  const list = getAllTenants().map(t => ({
    id: t.id, name: t.name, currency: t.currency, status: t.status,
    revenueShare: t.revenueShare, stats: t.stats, allowedGames: t.allowedGames,
    createdAt: t.createdAt,
  }))
  res.json({ success: true, tenants: list })
})

// ── B2B 게임 플레이 (Seamless Wallet 연동)
app.post('/b2b/game/play', b2bAuthMiddleware, async (req, res) => {
  try {
    const tenant = req.tenant
    const { game, playerId, amount, params = {} } = req.body

    if (!game || !playerId || !amount) {
      return res.json({ success: false, error: 'game, playerId, amount required' })
    }
    if (!tenant.allowedGames.includes(game)) {
      return res.json({ success: false, error: `game ${game} not allowed for this tenant` })
    }

    const betAmount = Math.floor(Number(amount))
    const txId = `${tenant.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    // 1. Wallet Debit (업체 잔액 차감)
    const debitRes = await walletDebit(tenant, playerId, betAmount, txId, `${game}_bet`)
    if (!debitRes.success) {
      return res.json({ success: false, error: debitRes.error || 'wallet debit failed' })
    }

    // 2. 게임 결과 계산
    const seedSet = createSeedSet(params.clientSeed || 'default')
    seedSet.nonce = Number(params.nonce) || Math.floor(Math.random() * 1000000)
    const hash = getResultHash(seedSet)

    let gameResult, result = 'lose', payout = 0, multiplier = 0

    switch (game) {
      case 'crash': {
        gameResult = crash(hash)
        const target = Number(params.cashoutAt) || 2.0
        if (gameResult.crashPoint >= target) { result = 'win'; multiplier = target; payout = Math.floor(betAmount * target) }
        else { multiplier = gameResult.crashPoint }
        break
      }
      case 'dice': {
        gameResult = dice(hash, params)
        if (gameResult.won) { result = 'win'; multiplier = gameResult.multiplier; payout = Math.floor(betAmount * multiplier) }
        break
      }
      case 'plinko': {
        gameResult = plinko(hash, params)
        multiplier = gameResult.multiplier; payout = Math.floor(betAmount * multiplier)
        result = payout > betAmount ? 'win' : 'lose'
        break
      }
      default:
        // 지원 안 하는 즉시 게임 → 롤백
        await walletRollback(tenant, playerId, txId, 'unsupported_game')
        return res.json({ success: false, error: `use /b2b/game/settle for ${game}` })
    }

    // 3. Wallet Credit (승리 시)
    if (payout > 0) {
      const creditRes = await walletCredit(tenant, playerId, payout, `${txId}_win`, `${game}_win`)
      if (!creditRes.success) {
        console.error(`[B2B] Credit failed for ${tenant.name}:`, creditRes.error)
      }
    }

    // 4. 통계 업데이트
    updateTenantStats(tenant.id, betAmount, payout)
    addGameLog(tenant.id, playerId, game, betAmount, payout, payout > betAmount ? 'win' : 'lose', txId)
    updateRTP(game, betAmount, payout)

    // 🗄️ DB 영구화 (fire-and-forget)
    db.saveSeed({
      serverSeed: seedSet.serverSeed, serverSeedHash: seedSet.serverSeedHash,
      clientSeed: seedSet.clientSeed, nonce: seedSet.nonce,
      game, resultHash: hash,
    }).then(seedId => {
      db.saveRound({
        seedId, game,
        usercode: playerId, sessionId: txId, tenantId: tenant.id,
        betAmount, result, payout, multiplier, gameData: gameResult,
      })
    }).catch(e => console.warn('[db] b2b/play persist', e.message))
    db.bumpRTP(game, betAmount, payout)

    return res.json({
      success: true, game, result, payout, multiplier, betAmount,
      transactionId: txId,
      balance: debitRes.balance != null ? (debitRes.balance - betAmount + payout) : undefined,
      gameData: gameResult,
      seed: { serverSeed: seedSet.serverSeed, serverSeedHash: seedSet.serverSeedHash, clientSeed: seedSet.clientSeed, nonce: seedSet.nonce },
    })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ── B2B 가격 게임 정산
app.post('/b2b/game/settle', b2bAuthMiddleware, async (req, res) => {
  try {
    const tenant = req.tenant
    const { game, playerId, amount, params = {} } = req.body

    if (!game || !playerId || !amount) return res.json({ success: false, error: 'game, playerId, amount required' })

    const betAmount = Math.floor(Number(amount))
    const coin = params.coin || 'BTCUSDT'
    const endPrice = Number(params.endPrice) || await getBinancePrice(coin)
    if (!endPrice) return res.json({ success: false, error: 'price unavailable' })

    const txId = `${tenant.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    let gameResult, payout = 0

    // 리깅 체크
    const roundId = params.roundId || `${game}_${Date.now()}`
    const side = params.side
    const losingSide = getLosingSide(game, roundId)
    const riggingOverride = side ? overrideResult(side, losingSide) : null

    switch (game) {
      case 'updown': {
        gameResult = updownSettle(Number(params.startPrice), endPrice, side)
        if (riggingOverride === 'lose' && gameResult.won) { gameResult.won = false; gameResult.multiplier = 0 }
        else if (riggingOverride === 'win' && !gameResult.won && !gameResult.tie) { gameResult.won = true; gameResult.multiplier = 1.95 }
        payout = gameResult.tie ? betAmount : (gameResult.won ? Math.floor(betAmount * gameResult.multiplier) : 0)
        break
      }
      case 'hilo': {
        gameResult = hiloSettle(Number(params.targetPrice), endPrice, side)
        if (riggingOverride === 'lose' && gameResult.won) { gameResult.won = false; gameResult.multiplier = 0 }
        else if (riggingOverride === 'win' && !gameResult.won && !gameResult.tie) { gameResult.won = true; gameResult.multiplier = 1.97 }
        payout = gameResult.tie ? betAmount : (gameResult.won ? Math.floor(betAmount * gameResult.multiplier) : 0)
        break
      }
      case 'spread': {
        gameResult = spreadSettle(Number(params.startPrice), endPrice, Number(params.spreadPct) || 0.01)
        payout = gameResult.won ? Math.floor(betAmount * gameResult.multiplier) : 0
        break
      }
      case 'futures': {
        gameResult = futuresSettle(Number(params.entryPrice), endPrice, side, Number(params.leverage) || 10, betAmount)
        payout = gameResult.payout
        break
      }
      default:
        return res.json({ success: false, error: `unknown game: ${game}` })
    }

    // Wallet: debit → credit
    const debitRes = await walletDebit(tenant, playerId, betAmount, txId, `${game}_bet`)
    if (!debitRes.success) return res.json({ success: false, error: debitRes.error })

    if (payout > 0) {
      await walletCredit(tenant, playerId, payout, `${txId}_win`, `${game}_win`)
    }

    updateTenantStats(tenant.id, betAmount, payout)
    addGameLog(tenant.id, playerId, game, betAmount, payout, payout > betAmount ? 'win' : 'lose', txId)
    updateRTP(game, betAmount, payout)
    const resultStr = payout > betAmount ? 'win' : payout > 0 ? 'partial' : 'lose'

    // 🗄️ DB 영구화 (B2B도 seed + round 저장)
    const b2bSeedSet = createSeedSet(params.clientSeed || 'b2b_' + tenant.id)
    b2bSeedSet.nonce = Number(params.nonce) || Date.now()
    db.saveSeed({
      serverSeed: b2bSeedSet.serverSeed, serverSeedHash: b2bSeedSet.serverSeedHash,
      clientSeed: b2bSeedSet.clientSeed, nonce: b2bSeedSet.nonce,
      game, resultHash: null,
    }).then(seedId => {
      db.saveRound({
        seedId, game,
        usercode: playerId, sessionId: txId, tenantId: tenant.id,
        betAmount, result: resultStr, payout, multiplier: gameResult.multiplier || 0,
        gameData: { ...gameResult, endPrice, roundId, side },
        overrideInfo: riggingOverride ? { riggingOverride, losingSide } : null,
      })
    }).catch(e => console.warn('[db] b2b/settle persist', e.message))
    db.bumpRTP(game, betAmount, payout)

    return res.json({
      success: true, game, result: resultStr,
      payout, betAmount, endPrice, transactionId: txId, gameData: gameResult,
    })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// ── B2B 게임 카탈로그
app.get('/b2b/games/catalog', (req, res) => {
  res.json({
    success: true,
    games: [
      { id: 'crash', name: 'Crash', type: 'instant', rtp: 97, description: 'Rocket multiplier game' },
      { id: 'dice', name: 'Dice', type: 'instant', rtp: 97, description: 'Over/Under dice roll' },
      { id: 'mines', name: 'Mines', type: 'session', rtp: 97, description: 'Minesweeper with cashout' },
      { id: 'plinko', name: 'Plinko', type: 'instant', rtp: 97, description: 'Pachinko ball drop' },
      { id: 'updown', name: 'UP/DOWN', type: 'price', rtp: 97.5, description: '60s binary price prediction' },
      { id: 'hilo', name: 'HI/LO', type: 'price', rtp: 97, description: '30s target price prediction' },
      { id: 'spread', name: 'Spread', type: 'price', rtp: 95, description: '180s price range prediction' },
      { id: 'futures', name: 'Futures', type: 'price', rtp: 94, description: 'Leveraged position trading' },
      { id: 'holdem', name: "Texas Hold'em", type: 'pvp', rtp: 'N/A (rake 2.5-5%)', description: 'Real-time poker via WebSocket' },
    ],
  })
})

// ── B2B 정산 리포트
app.get('/b2b/reports/:tenantId', b2bAuthMiddleware, (req, res) => {
  const tenant = req.tenant
  const share = tenant.revenueShare / 100
  const ggr = tenant.stats.wagered - tenant.stats.paid
  res.json({
    success: true,
    tenant: tenant.name,
    stats: tenant.stats,
    settlement: {
      ggr,
      ourShare: Math.floor(ggr * share),
      tenantShare: Math.floor(ggr * (1 - share)),
      revenueSharePct: tenant.revenueShare,
    },
  })
})

// ── B2B 테넌트별 RTP 설정
app.post('/b2b/config/rtp', b2bAuthMiddleware, (req, res) => {
  const { game, rtp } = req.body
  const result = setTenantRTP(req.tenant.id, game, Number(rtp))
  res.json({ success: true, rtpConfig: result })
})

// ── B2B 테넌트별 리깅 설정
app.post('/b2b/config/rigging', b2bAuthMiddleware, (req, res) => {
  const { game, enabled, threshold } = req.body
  const result = setTenantRigging(req.tenant.id, game, enabled, threshold)
  res.json({ success: true, riggingConfig: result })
})

// ═══════════════════════════════════════════════════
// B2B 정산 리포트
// ═══════════════════════════════════════════════════

// 일일 정산
app.get('/b2b/reports/daily', b2bAuthMiddleware, (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0]
  const report = getDailyReport(req.tenant.id, date)
  const share = req.tenant.revenueShare / 100
  res.json({
    success: true, tenant: req.tenant.name, ...report,
    settlement: { ourShare: Math.floor(report.ggr * share), tenantShare: Math.floor(report.ggr * (1 - share)), pct: req.tenant.revenueShare },
  })
})

// 월간 정산
app.get('/b2b/reports/monthly', b2bAuthMiddleware, (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7)
  const report = getMonthlyReport(req.tenant.id, month)
  const share = req.tenant.revenueShare / 100
  res.json({
    success: true, tenant: req.tenant.name, ...report,
    settlement: { ourShare: Math.floor(report.ggr * share), tenantShare: Math.floor(report.ggr * (1 - share)), pct: req.tenant.revenueShare },
  })
})

// 전체 정산
app.get('/b2b/reports/all', b2bAuthMiddleware, (req, res) => {
  const report = getAllTimeReport(req.tenant.id)
  const share = req.tenant.revenueShare / 100
  res.json({
    success: true, tenant: req.tenant.name, ...report,
    settlement: { ourShare: Math.floor(report.ggr * share), tenantShare: Math.floor(report.ggr * (1 - share)), pct: req.tenant.revenueShare },
  })
})

// 상위 플레이어
app.get('/b2b/reports/top-players', b2bAuthMiddleware, (req, res) => {
  const limit = Number(req.query.limit) || 20
  res.json({ success: true, players: getTopPlayers(req.tenant.id, limit) })
})

// CSV 다운로드
app.get('/b2b/reports/export', b2bAuthMiddleware, (req, res) => {
  const logs = getLogsForExport(req.tenant.id, req.query.from, req.query.to)
  const csv = generateCSV(logs)
  res.setHeader('Content-Type', 'text/csv')
  res.setHeader('Content-Disposition', `attachment; filename="${req.tenant.name}_${req.query.from || 'all'}_${req.query.to || 'now'}.csv"`)
  res.send(csv)
})

// ═══════════════════════════════════════════════════
// API 문서 — 자동 생성
// ═══════════════════════════════════════════════════
app.get('/b2b/docs', (req, res) => {
  res.json({
    name: 'TETHER.BET Game Engine API',
    version: '1.0.0',
    baseUrl: 'https://tether-crypto-engine-production.up.railway.app',
    authentication: {
      method: 'API Key',
      header: 'X-API-Key',
      description: 'Contact us to get your API key',
    },
    endpoints: {
      'Authentication': {
        'POST /b2b/auth/register': { body: { masterKey: 'string', name: 'string', walletUrl: 'string', currency: 'USD', revenueShare: 15 }, description: 'Register new operator (master admin only)' },
      },
      'Game Catalog': {
        'GET /b2b/games/catalog': { description: 'List all available games with RTP and type info' },
      },
      'Instant Games (Crash, Dice, Plinko)': {
        'POST /b2b/game/play': {
          headers: { 'X-API-Key': 'your_api_key' },
          body: { game: 'crash|dice|plinko', playerId: 'string', amount: 'number', params: { cashoutAt: 2.0, target: 50, direction: 'over', risk: 'medium', clientSeed: 'string' } },
          response: { success: true, result: 'win|lose', payout: 195, multiplier: 1.95, gameData: {}, seed: { serverSeed: '...', serverSeedHash: '...' } },
          description: 'Play instant game. Wallet debit/credit handled automatically via Seamless Wallet.',
        },
      },
      'Session Games (Mines)': {
        'POST /b2b/game/mines/start': { body: { playerId: 'string', amount: 'number', params: { mines: 3 } }, description: 'Start Mines game, returns sessionId' },
        'POST /b2b/game/mines/reveal': { body: { sessionId: 'string', tileIndex: 'number (0-24)' }, description: 'Reveal a tile' },
        'POST /b2b/game/mines/cashout': { body: { sessionId: 'string' }, description: 'Cash out current multiplier' },
      },
      'Price Games (UP/DOWN, HI/LO, Spread, Futures)': {
        'POST /b2b/game/settle': {
          body: { game: 'updown|hilo|spread|futures', playerId: 'string', amount: 'number', params: { side: 'UP|DOWN|HIGHER|LOWER|LONG|SHORT', startPrice: 'number', coin: 'BTCUSDT' } },
          description: 'Settle price-based game after round ends. Uses live Binance price.',
        },
      },
      'Provably Fair': {
        'POST /api/game/verify': { body: { game: 'string', serverSeed: 'string', clientSeed: 'string', nonce: 'number' }, description: 'Verify game result with seeds' },
      },
      'Reports': {
        'GET /b2b/reports/daily?date=2026-04-18': { description: 'Daily settlement report with GGR breakdown' },
        'GET /b2b/reports/monthly?month=2026-04': { description: 'Monthly settlement report' },
        'GET /b2b/reports/all': { description: 'All-time report' },
        'GET /b2b/reports/top-players?limit=20': { description: 'Top players by wagered amount' },
        'GET /b2b/reports/export?from=2026-04-01&to=2026-04-18': { description: 'CSV export of game logs' },
      },
      'Configuration': {
        'POST /b2b/config/rtp': { body: { game: 'crash', rtp: 95 }, description: 'Set RTP for specific game (per-tenant)' },
        'POST /b2b/config/rigging': { body: { game: 'updown', enabled: true, threshold: 60 }, description: 'Configure balance rigging (per-tenant)' },
      },
      'Seamless Wallet (Operator implements)': {
        'POST {your_wallet_url}/wallet/balance': { body: { playerId: 'string' }, response: { success: true, balance: 1000 }, description: 'We call this to check player balance' },
        'POST {your_wallet_url}/wallet/debit': { body: { playerId: 'string', amount: 100, transactionId: 'string', reason: 'string' }, response: { success: true, balance: 900 }, description: 'We call this to deduct bet amount' },
        'POST {your_wallet_url}/wallet/credit': { body: { playerId: 'string', amount: 195, transactionId: 'string', reason: 'string' }, response: { success: true, balance: 1095 }, description: 'We call this to pay winnings' },
        'POST {your_wallet_url}/wallet/rollback': { body: { playerId: 'string', transactionId: 'string', reason: 'string' }, response: { success: true }, description: 'We call this to reverse a failed transaction' },
      },
    },
    games: {
      crash: { rtp: '97%', type: 'instant', description: 'Rocket multiplier — cash out before crash' },
      dice: { rtp: '97%', type: 'instant', description: 'Roll over/under target number' },
      mines: { rtp: '97%', type: 'session', description: 'Minesweeper — reveal gems, avoid mines' },
      plinko: { rtp: '97%', type: 'instant', description: 'Drop ball through pins to win multiplier' },
      updown: { rtp: '97.5%', type: 'price', duration: '60s', description: 'Predict if price goes UP or DOWN' },
      hilo: { rtp: '97%', type: 'price', duration: '30s', description: 'Predict if price goes HIGHER or LOWER than target' },
      spread: { rtp: '95%', type: 'price', duration: '180s', description: 'Predict if price stays within range' },
      futures: { rtp: '94%', type: 'price', description: 'Leveraged long/short position trading' },
      holdem: { rtp: 'N/A (rake)', type: 'pvp', description: 'Texas Hold\'em Poker via WebSocket (separate engine)' },
    },
    notes: [
      'All instant games use HMAC-SHA256 Provably Fair system',
      'Price games use live Binance API for settlement',
      'Wallet operations are synchronous — respond within 5 seconds',
      'All amounts are in cents (integer) to avoid floating point issues',
      'Game results include seeds for player verification',
    ],
  })
})

// ═══════════════════════════════════════════════════
// iframe Widget — B2B 업체용 게임 임베딩
// ═══════════════════════════════════════════════════
const { generateWidgetHTML, generateWidgetLauncher } = require('./widget')

// 게임 런처 (전체 게임 선택 화면)
app.get('/widget', (req, res) => {
  res.send(generateWidgetLauncher(req.query))
})

// 개별 게임 위젯
app.get('/widget/:game', (req, res) => {
  const html = generateWidgetHTML(req.params.game, req.query)
  res.send(html)
})

// B2B 게임 런칭 URL 생성 API
app.post('/b2b/game/launch', b2bAuthMiddleware, (req, res) => {
  const { game, playerId, currency, theme, locale } = req.body
  const tenant = req.tenant
  if (!game || !playerId) return res.json({ success: false, error: 'game and playerId required' })

  const baseUrl = `https://tether-crypto-engine-production.up.railway.app`
  const params = new URLSearchParams({
    apiKey: tenant.apiKey,
    playerId,
    currency: currency || tenant.currency || 'USD',
    theme: theme || 'dark',
    locale: locale || 'en',
  })

  const url = `${baseUrl}/widget/${game}?${params}`
  const launcherUrl = `${baseUrl}/widget?${params}`

  res.json({
    success: true,
    gameUrl: url,
    launcherUrl,
    iframe: `<iframe src="${url}" width="100%" height="600" frameborder="0" allow="autoplay"></iframe>`,
  })
})

// ═══════════════════════════════════════════════════
// 샌드박스 — 테스트 환경
// ═══════════════════════════════════════════════════

// 잔액 조회/리셋
app.get('/sandbox/balance/:playerId', (req, res) => {
  res.json({ success: true, playerId: req.params.playerId, balance: getSandboxBalance(req.params.playerId) })
})
app.post('/sandbox/reset/:playerId', (req, res) => {
  const r = resetSandboxWallet(req.params.playerId)
  res.json({ success: true, playerId: req.params.playerId, balance: r.balance })
})

// 샌드박스 데모 페이지
app.get('/sandbox', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TETHER.BET Game Engine — Sandbox</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0B0E14;color:#fff;font-family:'Segoe UI',sans-serif;padding:20px}
h1{color:#2EBD85;margin-bottom:5px}
.sub{color:#666;font-size:13px;margin-bottom:30px}
.card{background:#141720;border:1px solid #1e2230;border-radius:16px;padding:20px;margin-bottom:16px}
.card h3{color:#2EBD85;font-size:14px;margin-bottom:12px}
.row{display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap}
select,input,button{background:#1a1e2e;border:1px solid #2a2e3e;border-radius:8px;color:#fff;padding:8px 14px;font-size:13px;outline:none}
select:focus,input:focus{border-color:#2EBD85}
button{background:#2EBD85;color:#000;font-weight:700;cursor:pointer;border:none}
button:hover{background:#26A17B}
button.red{background:#F6465D}
button.blue{background:#06B6D4}
.result{background:#0d1017;border:1px solid #1e2230;border-radius:8px;padding:12px;margin-top:10px;font-family:monospace;font-size:12px;white-space:pre-wrap;max-height:300px;overflow:auto}
.badge{display:inline-block;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700}
.badge.win{background:#2EBD8520;color:#2EBD85}
.badge.lose{background:#F6465D20;color:#F6465D}
.balance{font-size:24px;font-weight:800;color:#2EBD85;font-family:'Space Grotesk',monospace}
.info{color:#666;font-size:11px;margin-top:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
</style>
</head>
<body>
<h1>TETHER.BET Game Engine</h1>
<p class="sub">Sandbox Testing Environment — API Key: <code style="color:#F0B90B">tb_sandbox_test_key_2026</code></p>

<div class="card">
<h3>Player Balance</h3>
<div class="row">
<input id="pid" value="test_player_1" placeholder="Player ID" style="flex:1">
<button onclick="checkBalance()">Check</button>
<button class="red" onclick="resetBalance()">Reset $10,000</button>
</div>
<div class="balance" id="bal">$10,000.00</div>
</div>

<div class="card">
<h3>Play Game</h3>
<div class="row">
<select id="game">
<option value="crash">Crash</option>
<option value="dice">Dice</option>
<option value="plinko">Plinko</option>
</select>
<input id="amount" type="number" value="100" placeholder="Bet Amount" style="width:100px">
</div>
<div class="row">
<input id="cashoutAt" value="2.0" placeholder="Crash: cashout at" style="width:120px">
<input id="target" value="50" placeholder="Dice: target" style="width:100px">
<select id="direction"><option value="over">Over</option><option value="under">Under</option></select>
<select id="risk"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option></select>
</div>
<button onclick="playGame()">PLAY</button>
<div class="result" id="result">Result will appear here...</div>
</div>

<div class="card">
<h3>Game Catalog</h3>
<div id="catalog" class="grid"></div>
</div>

<div class="card">
<h3>API Documentation</h3>
<button class="blue" onclick="window.open('/b2b/docs','_blank')">View Full API Docs (JSON)</button>
<p class="info">Base URL: <code>${'https://tether-crypto-engine-production.up.railway.app'}</code></p>
</div>

<script>
const API='';
const KEY='tb_sandbox_test_key_2026';
const h={'Content-Type':'application/json','X-API-Key':KEY};

async function checkBalance(){
  const pid=document.getElementById('pid').value;
  const r=await fetch(API+'/sandbox/balance/'+pid).then(r=>r.json());
  document.getElementById('bal').textContent='$'+r.balance.toLocaleString('en-US',{minimumFractionDigits:2});
}

async function resetBalance(){
  const pid=document.getElementById('pid').value;
  await fetch(API+'/sandbox/reset/'+pid,{method:'POST'});
  checkBalance();
}

async function playGame(){
  const game=document.getElementById('game').value;
  const pid=document.getElementById('pid').value;
  const amount=Number(document.getElementById('amount').value);
  const params={};
  if(game==='crash')params.cashoutAt=Number(document.getElementById('cashoutAt').value);
  if(game==='dice'){params.target=Number(document.getElementById('target').value);params.direction=document.getElementById('direction').value}
  if(game==='plinko')params.risk=document.getElementById('risk').value;

  const r=await fetch(API+'/b2b/game/play',{method:'POST',headers:h,body:JSON.stringify({game,playerId:pid,amount,params})}).then(r=>r.json());

  const el=document.getElementById('result');
  el.innerHTML='<span class="badge '+(r.result==='win'?'win':'lose')+'">'+r.result?.toUpperCase()+'</span>\\n\\n'+JSON.stringify(r,null,2);
  checkBalance();
}

// Load catalog
fetch(API+'/b2b/games/catalog').then(r=>r.json()).then(d=>{
  const el=document.getElementById('catalog');
  el.innerHTML=d.games.map(g=>'<div style="background:#0d1017;border:1px solid #1e2230;border-radius:8px;padding:10px"><div style="font-weight:700;color:#2EBD85">'+g.name+'</div><div style="font-size:11px;color:#888;margin-top:4px">'+g.description+'</div><div style="font-size:11px;color:#F0B90B;margin-top:4px">RTP: '+g.rtp+' | Type: '+g.type+'</div></div>').join('');
});

checkBalance();
</script>
</body>
</html>`)
})

// ═══════════════════════════════════════
// 서버 시작 — DB 설정 로드 후 listen
// ═══════════════════════════════════════
async function start() {
  // 1. 리깅 설정 DB 로드
  try { await bootstrapRounds() } catch (e) { console.warn('[bootstrap] rigging', e.message) }

  // 2. 🔒 기본 houseEdge DB 로드 + 저장 훅 등록
  try {
    const loadedEdge = await db.loadHouseEdge()
    if (loadedEdge && Object.keys(loadedEdge).length > 0) {
      loadHouseEdgeFromDB(loadedEdge)
      console.log(`[bootstrap] 기본 houseEdge 로드: ${Object.keys(loadedEdge).length}개 게임`)
    }
    // setHouseEdge 호출 시 DB에도 저장되도록 훅 연결
    setHouseEdgePersister(db.saveHouseEdge)
  } catch (e) { console.warn('[bootstrap] houseEdge', e.message) }

  // 3. 🔒 유저 RTP DB 로드 + games.js에 주입 (실제 게임 계산 반영)
  try {
    const loaded = await db.loadUserRtp()
    if (loaded) {
      Object.assign(userRtpConfig, loaded)
      loadUserRtpFromDB(loaded)  // games.js의 userRtpOverride로 주입
      console.log(`[bootstrap] 유저 RTP 로드: ${Object.keys(loaded).length}명 (games.js 반영 완료)`)
    }
  } catch (e) { console.warn('[bootstrap] userRtp', e.message) }

  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════╗
║  TETHER.BET Crypto Game Engine v1.1     ║
║  Port: ${PORT}                              ║
║  Games: 8 (Provably Fair) + Holdem      ║
║  Mode: B2C + B2B API                    ║
║  DB: ${db.dbEnabled ? 'Supabase (영구화 ON)' : '메모리 전용 (fallback)'}  ║
║  Status: READY                           ║
╚══════════════════════════════════════════╝
    `)
  })
}

start().catch(err => {
  console.error('[fatal] 서버 시작 실패:', err)
  process.exit(1)
})
