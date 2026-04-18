/**
 * B2B Settlement — 정산 엔진
 *
 * 일일/월간/게임별 GGR 계산 + revenue share 정산
 */

// 게임 로그 저장소 (인메모리 — 프로덕션에서 DB)
const gameLogs = []

function addGameLog(tenantId, playerId, game, betAmount, payout, result, txId) {
  gameLogs.push({
    tenantId, playerId, game, betAmount, payout, result, txId,
    ggr: betAmount - payout,
    createdAt: new Date().toISOString(),
    date: new Date().toISOString().split('T')[0],
  })
}

// 일일 정산
function getDailyReport(tenantId, date) {
  const dayLogs = gameLogs.filter(l => l.tenantId === tenantId && l.date === date)
  return buildReport(dayLogs, date)
}

// 월간 정산
function getMonthlyReport(tenantId, yearMonth) {
  const monthLogs = gameLogs.filter(l => l.tenantId === tenantId && l.date.startsWith(yearMonth))
  return buildReport(monthLogs, yearMonth)
}

// 전체 기간
function getAllTimeReport(tenantId) {
  const logs = gameLogs.filter(l => l.tenantId === tenantId)
  return buildReport(logs, 'all-time')
}

function buildReport(logs, period) {
  const totalWagered = logs.reduce((s, l) => s + l.betAmount, 0)
  const totalPaid = logs.reduce((s, l) => s + l.payout, 0)
  const ggr = totalWagered - totalPaid
  const totalRounds = logs.length
  const wins = logs.filter(l => l.result === 'win').length
  const losses = logs.filter(l => l.result === 'lose').length

  // 게임별 분석
  const byGame = {}
  logs.forEach(l => {
    if (!byGame[l.game]) byGame[l.game] = { wagered: 0, paid: 0, ggr: 0, rounds: 0, wins: 0 }
    byGame[l.game].wagered += l.betAmount
    byGame[l.game].paid += l.payout
    byGame[l.game].ggr += l.ggr
    byGame[l.game].rounds += 1
    if (l.result === 'win') byGame[l.game].wins += 1
  })

  // 게임별 RTP 계산
  for (const g of Object.values(byGame)) {
    g.rtp = g.wagered > 0 ? parseFloat((g.paid / g.wagered * 100).toFixed(2)) : 0
  }

  // 유니크 플레이어
  const uniquePlayers = new Set(logs.map(l => l.playerId)).size

  return {
    period,
    totalWagered,
    totalPaid,
    ggr,
    rtp: totalWagered > 0 ? parseFloat((totalPaid / totalWagered * 100).toFixed(2)) : 0,
    totalRounds,
    wins,
    losses,
    uniquePlayers,
    byGame,
  }
}

// 상위 플레이어
function getTopPlayers(tenantId, limit = 20) {
  const logs = gameLogs.filter(l => l.tenantId === tenantId)
  const playerMap = {}
  logs.forEach(l => {
    if (!playerMap[l.playerId]) playerMap[l.playerId] = { wagered: 0, paid: 0, ggr: 0, rounds: 0 }
    playerMap[l.playerId].wagered += l.betAmount
    playerMap[l.playerId].paid += l.payout
    playerMap[l.playerId].ggr += l.ggr
    playerMap[l.playerId].rounds += 1
  })
  return Object.entries(playerMap)
    .map(([id, s]) => ({ playerId: id, ...s, rtp: s.wagered > 0 ? parseFloat((s.paid / s.wagered * 100).toFixed(2)) : 0 }))
    .sort((a, b) => b.wagered - a.wagered)
    .slice(0, limit)
}

// CSV 생성
function generateCSV(logs) {
  const header = 'date,game,playerId,betAmount,payout,result,ggr,transactionId\n'
  const rows = logs.map(l =>
    `${l.date},${l.game},${l.playerId},${l.betAmount},${l.payout},${l.result},${l.ggr},${l.txId || ''}`
  ).join('\n')
  return header + rows
}

function getLogsForExport(tenantId, dateFrom, dateTo) {
  return gameLogs.filter(l =>
    l.tenantId === tenantId &&
    (!dateFrom || l.date >= dateFrom) &&
    (!dateTo || l.date <= dateTo)
  )
}

module.exports = {
  addGameLog, getDailyReport, getMonthlyReport, getAllTimeReport,
  getTopPlayers, generateCSV, getLogsForExport,
}
