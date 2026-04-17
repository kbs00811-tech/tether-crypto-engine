/**
 * Provably Fair — HMAC-SHA256 기반 게임 결과 생성
 *
 * 흐름:
 *   1. 서버가 serverSeed 생성 → SHA256 해시만 유저에게 공개
 *   2. 유저가 clientSeed 제공 (또는 기본값)
 *   3. HMAC-SHA256(serverSeed, clientSeed:nonce) → 결과 결정
 *   4. 게임 후 serverSeed 원본 공개 → 유저가 검증
 */
const crypto = require('crypto')

function generateServerSeed() {
  return crypto.randomBytes(32).toString('hex')
}

function hashSeed(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex')
}

function hmacResult(serverSeed, clientSeed, nonce) {
  return crypto.createHmac('sha256', serverSeed)
    .update(`${clientSeed}:${nonce}`)
    .digest('hex')
}

// hash hex → 0~1 float (균등분포, 52bit 정밀도)
function hashToFloat(hash, offset = 0) {
  const h = parseInt(hash.slice(offset, offset + 13), 16)
  return h / Math.pow(2, 52)
}

// hash hex → 0~max 정수
function hashToInt(hash, max, offset = 0) {
  const h = parseInt(hash.slice(offset, offset + 8), 16)
  return h % (max + 1)
}

// 전체 시드 세트 생성
function createSeedSet(clientSeed = 'default') {
  const serverSeed = generateServerSeed()
  return {
    serverSeed,
    serverSeedHash: hashSeed(serverSeed),
    clientSeed,
    nonce: 0,
  }
}

// 결과 해시 생성
function getResultHash(seedSet) {
  return hmacResult(seedSet.serverSeed, seedSet.clientSeed, seedSet.nonce)
}

module.exports = {
  generateServerSeed,
  hashSeed,
  hmacResult,
  hashToFloat,
  hashToInt,
  createSeedSet,
  getResultHash,
}
