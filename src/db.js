/**
 * DB Layer — Supabase 연결 + write-through 캐시
 *
 * 설계:
 *   - 리깅/RTP 설정: 서버 시작 시 DB → 메모리 로드, write 시 DB 먼저 그 후 메모리 갱신
 *   - seed/rounds: write-through (DB INSERT 성공 후 응답)
 *   - mines: DB 단일 (장애 복구 가능)
 *   - rtp_stats: 비동기 배치 (성능)
 *
 * DB 실패 시 Fail-safe:
 *   - 엔진이 DB 없이도 동작 가능 (경고 로그 + 메모리 fallback)
 *   - 기존 코드 호환성 유지
 */
const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY

let sb = null
let dbEnabled = false

if (SUPABASE_URL && SERVICE_KEY) {
  try {
    sb = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: 'public' },
    })
    dbEnabled = true
    console.log('[db] Supabase connected →', SUPABASE_URL.replace(/^https?:\/\//, '').split('.')[0])
  } catch (e) {
    console.error('[db] Supabase init failed:', e.message)
  }
} else {
  console.warn('[db] SUPABASE_URL/SERVICE_KEY 미설정 — 메모리 전용 모드')
}

// ═══════════════════════════════════════
// Seed 저장 (append-only)
// ═══════════════════════════════════════
async function saveSeed({ serverSeed, serverSeedHash, clientSeed, nonce, game, resultHash }) {
  if (!dbEnabled) return null
  try {
    const { data, error } = await sb
      .from('crypto_engine_seeds')
      .insert({
        server_seed:      serverSeed,
        server_seed_hash: serverSeedHash,
        client_seed:      clientSeed || 'default',
        nonce:            Number(nonce) || 0,
        game,
        result_hash:      resultHash,
      })
      .select('id')
      .single()
    if (error) { console.warn('[db] saveSeed', error.message); return null }
    return data?.id || null
  } catch (e) { console.warn('[db] saveSeed', e.message); return null }
}

// ═══════════════════════════════════════
// Round 결과 저장
// ═══════════════════════════════════════
async function saveRound({ seedId, game, usercode, userId, sessionId, tenantId,
                           betAmount, result, payout, multiplier, gameData, overrideInfo }) {
  if (!dbEnabled) return null
  try {
    const { error } = await sb
      .from('crypto_engine_rounds')
      .insert({
        seed_id:       seedId,
        game,
        usercode:      usercode || null,
        user_id:       userId || null,
        session_id:    sessionId || null,
        tenant_id:     tenantId || null,
        bet_amount:    Math.floor(Number(betAmount) || 0),
        result:        result || 'unknown',
        payout:        Math.floor(Number(payout) || 0),
        multiplier:    Number(multiplier) || 0,
        game_data:     gameData || null,
        override_info: overrideInfo || null,
      })
    if (error) console.warn('[db] saveRound', error.message)
  } catch (e) { console.warn('[db] saveRound', e.message) }
}

// ═══════════════════════════════════════
// RTP 집계 (UPSERT via RPC)
// ═══════════════════════════════════════
const rtpBatch = []  // 비동기 배치
async function bumpRTP(game, wagered, paid) {
  if (!dbEnabled) return
  rtpBatch.push({ game, wagered: Math.floor(wagered), paid: Math.floor(paid) })
}

async function flushRTP() {
  if (!dbEnabled || rtpBatch.length === 0) return
  const copy = rtpBatch.splice(0, rtpBatch.length)
  for (const r of copy) {
    try {
      await sb.rpc('crypto_engine_upsert_rtp', {
        p_game: r.game, p_wagered: r.wagered, p_paid: r.paid,
      })
    } catch (e) { console.warn('[db] flushRTP', e.message) }
  }
}

// 10초마다 batch flush
if (dbEnabled) setInterval(flushRTP, 10000)

// ═══════════════════════════════════════
// 리깅 설정 로드/저장
// ═══════════════════════════════════════
async function loadRigging() {
  if (!dbEnabled) return null
  try {
    const { data, error } = await sb.from('crypto_engine_rigging').select('*')
    if (error) { console.warn('[db] loadRigging', error.message); return null }
    const out = {}
    for (const r of (data || [])) {
      out[r.game] = { enabled: !!r.enabled, threshold: Number(r.threshold) || 60 }
    }
    return out
  } catch (e) { console.warn('[db] loadRigging', e.message); return null }
}

async function saveRigging(game, enabled, threshold, updatedBy) {
  if (!dbEnabled) return false
  try {
    const { error } = await sb.from('crypto_engine_rigging').upsert({
      game,
      enabled: !!enabled,
      threshold: Number(threshold) || 60,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy || null,
    }, { onConflict: 'game' })
    if (error) { console.warn('[db] saveRigging', error.message); return false }
    return true
  } catch (e) { console.warn('[db] saveRigging', e.message); return false }
}

// ═══════════════════════════════════════
// 유저 RTP 로드/저장
// ═══════════════════════════════════════
async function loadUserRtp() {
  if (!dbEnabled) return null
  try {
    const { data } = await sb.from('crypto_engine_user_rtp').select('*')
    const out = {}
    for (const r of (data || [])) {
      out[r.usercode] = out[r.usercode] || {}
      out[r.usercode][r.game] = Number(r.rtp)
    }
    return out
  } catch (e) { console.warn('[db] loadUserRtp', e.message); return null }
}

async function saveUserRtp(usercode, game, rtp, updatedBy) {
  if (!dbEnabled) return false
  try {
    const { error } = await sb.from('crypto_engine_user_rtp').upsert({
      usercode, game, rtp: Number(rtp),
      updated_at: new Date().toISOString(),
      updated_by: updatedBy || null,
    }, { onConflict: 'usercode,game' })
    if (error) { console.warn('[db] saveUserRtp', error.message); return false }
    return true
  } catch (e) { console.warn('[db] saveUserRtp', e.message); return false }
}

async function deleteUserRtp(usercode, game) {
  if (!dbEnabled) return false
  try {
    if (game) {
      await sb.from('crypto_engine_user_rtp').delete().eq('usercode', usercode).eq('game', game)
    } else {
      await sb.from('crypto_engine_user_rtp').delete().eq('usercode', usercode)
    }
    return true
  } catch (e) { console.warn('[db] deleteUserRtp', e.message); return false }
}

// ═══════════════════════════════════════
// Mines 세션 (DB 단일 소스)
// ═══════════════════════════════════════
async function createMinesSession({ sessionId, usercode, betAmount, mineCount, mines, seedId, ttlMinutes = 60 }) {
  if (!dbEnabled) return null
  try {
    const { error } = await sb.from('crypto_engine_mines_sessions').insert({
      session_id:  sessionId,
      usercode:    usercode || null,
      bet_amount:  Math.floor(betAmount),
      mine_count:  mineCount,
      mines:       mines,
      seed_id:     seedId,
      status:      'active',
      expires_at:  new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString(),
    })
    if (error) { console.warn('[db] createMinesSession', error.message); return false }
    return true
  } catch (e) { console.warn('[db] createMinesSession', e.message); return false }
}

async function getMinesSession(sessionId) {
  if (!dbEnabled) return null
  try {
    const { data } = await sb.from('crypto_engine_mines_sessions')
      .select('*').eq('session_id', sessionId).single()
    if (!data) return null
    if (data.status !== 'active' || new Date(data.expires_at) < new Date()) return null
    return data
  } catch (e) { return null }
}

async function updateMinesReveal(sessionId, revealed) {
  if (!dbEnabled) return false
  try {
    await sb.from('crypto_engine_mines_sessions').update({ revealed }).eq('session_id', sessionId)
    return true
  } catch (e) { return false }
}

async function closeMinesSession(sessionId, status, result) {
  if (!dbEnabled) return false
  try {
    await sb.from('crypto_engine_mines_sessions').update({
      status, result: result || null,
    }).eq('session_id', sessionId)
    return true
  } catch (e) { return false }
}

// ═══════════════════════════════════════
// seed raw 조회 (유저 검증용 — 종료된 라운드만)
// ═══════════════════════════════════════
async function revealSeed(serverSeedHash) {
  if (!dbEnabled) return null
  try {
    const { data } = await sb.from('crypto_engine_seeds')
      .select('server_seed, client_seed, nonce, game, result_hash, created_at')
      .eq('server_seed_hash', serverSeedHash)
      .order('created_at', { ascending: false })
      .limit(1).single()
    return data || null
  } catch (e) { return null }
}

// ═══════════════════════════════════════
// 만료 Mines 세션 정리 (5분 간격)
// ═══════════════════════════════════════
if (dbEnabled) setInterval(async () => {
  try { await sb.rpc('crypto_engine_expire_mines') } catch {}
}, 5 * 60 * 1000)

module.exports = {
  dbEnabled,
  saveSeed, saveRound, bumpRTP, flushRTP,
  loadRigging, saveRigging,
  loadUserRtp, saveUserRtp, deleteUserRtp,
  createMinesSession, getMinesSession, updateMinesReveal, closeMinesSession,
  revealSeed,
}
