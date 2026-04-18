/**
 * B2B iframe Widget — 게임별 독립 위젯 페이지
 *
 * 업체가 iframe으로 임베딩:
 *   <iframe src="https://engine.tethergame.io/widget/crash?apiKey=xxx&playerId=user1&currency=USD&theme=dark" />
 *
 * postMessage 통신:
 *   부모 → iframe: BALANCE_UPDATE, THEME_CHANGE
 *   iframe → 부모: GAME_RESULT, BALANCE_REQUEST, GAME_READY
 */

const GAME_CONFIG = {
  crash: {
    name: 'Crash',
    icon: '🚀',
    color: '#F6465D',
    description: 'Cash out before the rocket crashes!',
    minBet: 1,
    maxBet: 10000,
  },
  dice: {
    name: 'Dice',
    icon: '🎲',
    color: '#06B6D4',
    description: 'Roll over or under the target number',
    minBet: 1,
    maxBet: 10000,
  },
  mines: {
    name: 'Mines',
    icon: '💎',
    color: '#7C3AED',
    description: 'Find gems, avoid mines!',
    minBet: 1,
    maxBet: 5000,
  },
  plinko: {
    name: 'Plinko',
    icon: '🔮',
    color: '#F0B90B',
    description: 'Drop the ball and win multipliers',
    minBet: 1,
    maxBet: 10000,
  },
  updown: {
    name: 'UP/DOWN',
    icon: '📈',
    color: '#2EBD85',
    description: 'Predict if price goes up or down',
    minBet: 1,
    maxBet: 10000,
  },
  hilo: {
    name: 'HI/LO',
    icon: '🎯',
    color: '#EC4899',
    description: 'Higher or lower than target price?',
    minBet: 1,
    maxBet: 10000,
  },
  spread: {
    name: 'Spread',
    icon: '📊',
    color: '#FF6B35',
    description: 'Will price stay in range?',
    minBet: 1,
    maxBet: 5000,
  },
  futures: {
    name: 'Futures',
    icon: '⚡',
    color: '#8B5CF6',
    description: 'Leveraged position trading',
    minBet: 1,
    maxBet: 10000,
  },
}

function getCurrencySymbol(currency) {
  return { USD: '$', EUR: '€', KRW: '₩', JPY: '¥', MNT: '₮', USDT: '$', BRL: 'R$', GBP: '£' }[currency] || '$'
}

function formatAmount(amount, currency) {
  const sym = getCurrencySymbol(currency)
  const decimals = ['KRW', 'JPY', 'MNT'].includes(currency) ? 0 : 2
  return `${sym}${Number(amount).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`
}

function generateWidgetHTML(game, query) {
  const cfg = GAME_CONFIG[game]
  if (!cfg) return '<h1>Unknown Game</h1>'

  const apiKey = query.apiKey || ''
  const playerId = query.playerId || 'anonymous'
  const currency = query.currency || 'USD'
  const theme = query.theme || 'dark'
  const locale = query.locale || 'en'
  const sym = getCurrencySymbol(currency)

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${cfg.name} — TETHER.BET</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:${theme === 'dark' ? '#0B0E14' : '#f5f5f5'};color:${theme === 'dark' ? '#fff' : '#111'};font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:16px}
.header{width:100%;max-width:480px;display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.game-title{display:flex;align-items:center;gap:8px}
.game-title span{font-size:24px}
.game-title h2{font-size:18px;font-weight:800}
.balance{font-size:14px;font-weight:700;color:${cfg.color};background:${cfg.color}15;padding:6px 14px;border-radius:10px}
.card{width:100%;max-width:480px;background:${theme === 'dark' ? '#141720' : '#fff'};border:1px solid ${theme === 'dark' ? '#1e2230' : '#e5e5e5'};border-radius:16px;padding:20px;margin-bottom:12px}
.bet-row{display:flex;gap:8px;margin-bottom:12px}
input,select{flex:1;background:${theme === 'dark' ? '#1a1e2e' : '#f0f0f0'};border:1px solid ${theme === 'dark' ? '#2a2e3e' : '#ddd'};border-radius:10px;color:${theme === 'dark' ? '#fff' : '#111'};padding:10px 14px;font-size:14px;outline:none}
input:focus{border-color:${cfg.color}}
.btn{width:100%;padding:14px;border:none;border-radius:12px;font-size:16px;font-weight:800;cursor:pointer;color:#fff;background:${cfg.color};transition:all 0.2s}
.btn:hover{filter:brightness(1.1)}
.btn:active{transform:scale(0.98)}
.btn:disabled{opacity:0.4;cursor:not-allowed}
.quick-btns{display:flex;gap:6px;margin-bottom:12px}
.quick-btns button{flex:1;padding:8px;background:${theme === 'dark' ? '#1a1e2e' : '#f0f0f0'};border:1px solid ${theme === 'dark' ? '#2a2e3e' : '#ddd'};border-radius:8px;color:${theme === 'dark' ? '#aaa' : '#666'};font-size:12px;font-weight:700;cursor:pointer}
.quick-btns button:hover{border-color:${cfg.color};color:${cfg.color}}
.result{text-align:center;padding:20px;border-radius:12px;margin-top:12px;font-weight:800;font-size:20px}
.result.win{background:#2EBD8520;color:#2EBD85}
.result.lose{background:#F6465D20;color:#F6465D}
.history{margin-top:8px;font-size:11px;color:#666}
.history div{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid ${theme === 'dark' ? '#1a1e2e' : '#f0f0f0'}}
.seed{font-size:10px;color:#555;word-break:break-all;margin-top:8px;font-family:monospace}
.powered{text-align:center;font-size:10px;color:#444;margin-top:16px}
.powered a{color:${cfg.color};text-decoration:none}
</style>
</head>
<body>
<div class="header">
  <div class="game-title"><span>${cfg.icon}</span><h2>${cfg.name}</h2></div>
  <div class="balance" id="bal">${sym}10,000</div>
</div>

<div class="card">
  <div class="bet-row">
    <input id="amount" type="number" value="10" min="${cfg.minBet}" max="${cfg.maxBet}" placeholder="Bet Amount">
  </div>
  <div class="quick-btns">
    <button onclick="setAmount(5)">5</button>
    <button onclick="setAmount(10)">10</button>
    <button onclick="setAmount(50)">50</button>
    <button onclick="setAmount(100)">100</button>
    <button onclick="setAmount(500)">500</button>
    <button onclick="document.getElementById('amount').value=''">Clear</button>
  </div>

  ${game === 'crash' ? `
  <div class="bet-row"><input id="cashoutAt" type="number" value="2.0" step="0.1" min="1.1" placeholder="Auto Cashout (x)"></div>
  ` : ''}

  ${game === 'dice' ? `
  <div class="bet-row">
    <input id="target" type="number" value="50" min="1" max="99" placeholder="Target">
    <select id="direction"><option value="over">Over</option><option value="under">Under</option></select>
  </div>
  ` : ''}

  ${game === 'plinko' ? `
  <div class="bet-row">
    <select id="risk"><option value="low">Low Risk</option><option value="medium" selected>Medium</option><option value="high">High Risk</option></select>
  </div>
  ` : ''}

  <button class="btn" id="playBtn" onclick="play()">PLAY ${cfg.name.toUpperCase()}</button>

  <div id="resultBox"></div>
  <div id="seedBox" class="seed"></div>
</div>

<div class="card">
  <div style="font-size:12px;font-weight:700;margin-bottom:8px;color:#888">History</div>
  <div class="history" id="history"></div>
</div>

<div class="powered">Powered by <a href="https://tethergame.io" target="_blank">TETHER.BET</a> Game Engine</div>

<script>
const API='';
const KEY='${apiKey}';
const PID='${playerId}';
const CUR='${currency}';
const SYM='${sym}';
const GAME='${game}';
const h={'Content-Type':'application/json','X-API-Key':KEY};
let balance=10000;
const history=[];

function fmt(n){
  const dec=${['KRW','JPY','MNT'].includes(currency) ? 0 : 2};
  return SYM+Number(n).toLocaleString('en-US',{minimumFractionDigits:dec,maximumFractionDigits:dec});
}

function setAmount(v){document.getElementById('amount').value=v}

function updateBal(){
  document.getElementById('bal').textContent=fmt(balance);
  // postMessage to parent
  window.parent.postMessage({type:'BALANCE_UPDATE',playerId:PID,balance,currency:CUR},'*');
}

async function play(){
  const btn=document.getElementById('playBtn');
  btn.disabled=true;
  const amount=Number(document.getElementById('amount').value);
  if(!amount||amount<1){btn.disabled=false;return}

  const params={};
  if(GAME==='crash')params.cashoutAt=Number(document.getElementById('cashoutAt')?.value||2);
  if(GAME==='dice'){params.target=Number(document.getElementById('target')?.value||50);params.direction=document.getElementById('direction')?.value||'over'}
  if(GAME==='plinko')params.risk=document.getElementById('risk')?.value||'medium';

  try{
    const r=await fetch(API+'/b2b/game/play',{method:'POST',headers:h,body:JSON.stringify({game:GAME,playerId:PID,amount,params})}).then(r=>r.json());

    if(!r.success){document.getElementById('resultBox').innerHTML='<div class="result lose">'+r.error+'</div>';btn.disabled=false;return}

    balance=r.balance!=null?r.balance:balance-amount+(r.payout||0);
    updateBal();

    const isWin=r.result==='win';
    document.getElementById('resultBox').innerHTML='<div class="result '+(isWin?'win':'lose')+'">'+(isWin?'WIN '+fmt(r.payout)+'<br><span style="font-size:14px">'+r.multiplier+'x</span>':'LOSE<br><span style="font-size:14px">'+(r.gameData?.crashPoint||r.gameData?.roll||r.multiplier||'-')+'</span>')+'</div>';

    if(r.seed){document.getElementById('seedBox').textContent='Seed: '+r.seed.serverSeedHash?.slice(0,16)+'... | Nonce: '+r.seed.nonce}

    history.unshift({game:GAME,amount,result:r.result,payout:r.payout||0,mult:r.multiplier});
    renderHistory();

    // postMessage to parent
    window.parent.postMessage({type:'GAME_RESULT',playerId:PID,game:GAME,result:r.result,payout:r.payout,multiplier:r.multiplier,balance},'*');
  }catch(e){
    document.getElementById('resultBox').innerHTML='<div class="result lose">Error: '+e.message+'</div>';
  }
  btn.disabled=false;
}

function renderHistory(){
  const el=document.getElementById('history');
  el.innerHTML=history.slice(0,10).map(h=>'<div><span style="color:'+(h.result==='win'?'#2EBD85':'#F6465D')+'">'+h.result.toUpperCase()+'</span><span>'+fmt(h.amount)+'</span><span>'+(h.mult||0)+'x</span><span style="color:'+(h.result==='win'?'#2EBD85':'#F6465D')+'">'+(h.result==='win'?'+':'-')+fmt(h.result==='win'?h.payout:h.amount)+'</span></div>').join('');
}

// Listen for parent messages
window.addEventListener('message',e=>{
  const d=e.data||{};
  if(d.type==='BALANCE_UPDATE'){balance=d.balance;updateBal()}
  if(d.type==='SET_AMOUNT'){document.getElementById('amount').value=d.amount}
});

// Notify parent that widget is ready
window.parent.postMessage({type:'GAME_READY',game:GAME,playerId:PID},'*');

// Initial balance check
if(KEY.includes('sandbox')){
  fetch(API+'/sandbox/balance/'+PID).then(r=>r.json()).then(d=>{if(d.success){balance=d.balance;updateBal()}});
}
</script>
</body>
</html>`
}

function generateWidgetLauncher(query) {
  const apiKey = query.apiKey || ''
  const playerId = query.playerId || 'player1'
  const currency = query.currency || 'USD'
  const theme = query.theme || 'dark'
  const baseUrl = query.baseUrl || ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TETHER.BET — Game Launcher</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0B0E14;color:#fff;font-family:'Segoe UI',sans-serif;padding:20px}
h1{color:#2EBD85;font-size:22px;margin-bottom:4px}
.sub{color:#666;font-size:12px;margin-bottom:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.game-card{background:#141720;border:1px solid #1e2230;border-radius:14px;padding:16px;text-align:center;cursor:pointer;transition:all 0.2s}
.game-card:hover{border-color:#2EBD85;transform:translateY(-2px)}
.game-card .icon{font-size:32px;margin-bottom:8px}
.game-card .name{font-size:14px;font-weight:700}
.game-card .rtp{font-size:10px;color:#888;margin-top:4px}
</style>
</head>
<body>
<h1>TETHER.BET Games</h1>
<p class="sub">Select a game to play</p>
<div class="grid">
${Object.entries(GAME_CONFIG).map(([id, g]) => `
  <div class="game-card" onclick="window.location.href='${baseUrl}/widget/${id}?apiKey=${apiKey}&playerId=${playerId}&currency=${currency}&theme=${theme}'">
    <div class="icon">${g.icon}</div>
    <div class="name">${g.name}</div>
    <div class="rtp" style="color:${g.color}">RTP ${id === 'futures' ? '94%' : id === 'spread' ? '95%' : id === 'updown' ? '97.5%' : '97%'}</div>
  </div>
`).join('')}
</div>
</body>
</html>`
}

module.exports = { generateWidgetHTML, generateWidgetLauncher, GAME_CONFIG }
