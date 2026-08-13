const express = require('express');
const http = require('http');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 10000;
const MONGODB_URI = process.env.MONGODB_URI || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '123456';
const REFRESH_MS = Math.max(15000, Number(process.env.REFRESH_MS || 30000));
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/,'');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json({limit:'256kb'}));
app.use(express.static(path.join(__dirname, '..', 'public')));

const games = {
  mega: { name:'Mega 6/45', color:'#e53935', urls:['https://www.minhchinh.com/xo-so-dien-toan-mega-645.html'] },
  power:{ name:'Power 6/55', color:'#f6a800', urls:['https://www.minhchinh.com/xo-so-dien-toan-power-655.html'] },
  lotto:{ name:'Lotto 5/35', color:'#18a957', urls:['https://www.minhchinh.com/xo-so-dien-toan.html'] },
  max3dpro:{ name:'Max3D Pro', color:'#00a3c7', urls:['https://www.minhchinh.com/xo-so-dien-toan-max3d-pro.html','https://www.minhchinh.com/truc-tiep-xo-so-tu-chon-max3d-pro.html'] },
  max3d:{ name:'Max 3D', color:'#1967d2', urls:['https://www.minhchinh.com/xo-so-dien-toan-max-3d.html','https://www.minhchinh.com/truc-tiep-xo-so-tu-chon-max-3d.html'] }
};

let latest = {};
let mongo = null;
let db = null;
const historyMemory = {};
const ticketsMemory = [];

async function initMongo(){
  if(!MONGODB_URI) return;
  try {
    mongo = new MongoClient(MONGODB_URI);
    await mongo.connect();
    db = mongo.db();
    await db.collection('results').createIndex({game:1,period:1},{unique:true});
    await db.collection('tickets').createIndex({ownerKey:1,createdAt:-1});
    console.log('[MongoDB] connected');
  } catch(e){ console.error('[MongoDB]', e.message); }
}

function clean(s){ return String(s||'').replace(/\s+/g,' ').trim(); }
function parseMinhChinh(html, key){
  const $ = cheerio.load(html);
  const cfg = games[key];
  const body = clean($('body').text());

  if(key==='max3d' || key==='max3dpro'){
    const pm = body.match(/Kết quả QSMT kỳ\s*#?(\d+)\s*ngày\s*(\d{1,2}\/\d{1,2}\/\d{4})(?:\s*-\s*Lúc\s*([0-9:]+))?/i);
    if(!pm) throw new Error('Không đọc được kỳ/ngày Max3D');
    const period=pm[1], date=pm[2], time=pm[3]||'';
    const p0 = body.indexOf(pm[0]);
    let block = body.slice(p0 + pm[0].length);
    const p1 = block.search(/Kết quả QSMT kỳ\s*#?\d+/i);
    if(p1 >= 0) block = block.slice(0, p1);
    block = block.slice(0, 6000);
    const nums = txt => (String(txt).match(/\b\d{3}\b/g)||[]);
    const takeImmediate = (label, need) => {
      const re = new RegExp(label + '\\s+((?:\\d{3}\\s+){' + (need-1) + '}\\d{3})(?=\\s|$)', 'i');
      const m = block.match(re); return m ? nums(m[1]).slice(0, need) : [];
    };
    const takeAfterCount = (label, need) => {
      const re = new RegExp(label + '[^:]{0,50}:\\s*\\d+\\s+((?:\\d{3}\\s+){' + (need-1) + '}\\d{3})(?=\\s|$)', 'i');
      const m = block.match(re); return m ? nums(m[1]).slice(0, need) : [];
    };
    let dbn=[], g1=[], g2=[], g3=[];
    if(key==='max3dpro'){
      dbn=takeImmediate('Đặc biệt',2); g1=takeImmediate('Giải nhất',4); g2=takeImmediate('Giải nhì',6); g3=takeImmediate('Giải ba',8);
    } else {
      dbn=takeAfterCount('Đặc biệt',2); g1=takeAfterCount('Giải nhất',4); g2=takeAfterCount('Giải nhì',6); g3=takeAfterCount('Giải ba',8);
      if(dbn.length!==2) dbn=takeImmediate('Đặc biệt',2);
      if(g1.length!==4) g1=takeImmediate('Giải nhất',4);
      if(g2.length!==6) g2=takeImmediate('Giải nhì',6);
      if(g3.length!==8) g3=takeImmediate('Giải ba',8);
    }
    if(dbn.length!==2 || g1.length!==4 || g2.length!==6 || g3.length!==8){
      throw new Error(`Không đọc đủ bộ số Max3D (ĐB ${dbn.length}/2, G1 ${g1.length}/4, G2 ${g2.length}/6, G3 ${g3.length}/8)`);
    }
    const numbers=[...dbn,...g1,...g2,...g3];
    const prizes=[{label:'Đặc biệt',numbers:dbn},{label:'Giải nhất',numbers:g1},{label:'Giải nhì',numbers:g2},{label:'Giải ba',numbers:g3}];
    return {game:key,name:cfg.name,period,date,time,numbers,prizes,jackpots:[],source:'MinhChinh',updatedAt:new Date().toISOString()};
  }

  const title = key==='power' ? 'Kết quả Power 6/55' : key==='lotto' ? 'Kết quả Lotto 5/35' : 'Kết quả Mega 6/45';
  const pos = body.indexOf(title);
  if(pos < 0) throw new Error('Không tìm thấy khối '+title);
  const after = body.slice(pos + title.length);
  const nextResult = after.search(/Kết quả (?:Mega 6\/45|Power 6\/55|Lotto 5\/35|Max3D Pro|Max 3D)/);
  const block = nextResult >= 0 ? after.slice(0,nextResult) : after.slice(0,3500);
  const m = block.match(/Kết quả QSMT kỳ\s*#?(\d+)\s*ngày\s*(\d{1,2}\/\d{1,2}\/\d{4})(?:\s*-\s*Lúc\s*([0-9:]+))?/i);
  if(!m) throw new Error('Không đọc được kỳ/ngày');
  const period=m[1], date=m[2], time=m[3]||'';
  const tail=block.slice(m.index+m[0].length);
  const count=key==='mega'?6:(key==='power'?7:6);
  const max=key==='mega'?45:(key==='power'?55:35);
  const firstPart=tail.split(/Giá trị (?:Jackpot|Độc Đắc)/i)[0];
  const candidates=(firstPart.match(/\b\d{1,2}\b/g)||[]).map(x=>x.padStart(2,'0'));
  const numbers=candidates.slice(0,count);
  if(numbers.length!==count || numbers.some(x=>Number(x)<1 || Number(x)>max)) throw new Error('Bộ số không hợp lệ: '+numbers.join(' '));
  const jackpots=[]; const jp=/Giá trị (Jackpot(?:\s*[12])?|Độc Đắc)\s*([\d.,]+)/gi;
  let jm; while((jm=jp.exec(block))!==null){ jackpots.push({label:jm[1],value:jm[2]}); if(jackpots.length>=2) break; }
  return {game:key,name:cfg.name,period,date,time,numbers,prizes:[],jackpots,source:'MinhChinh',updatedAt:new Date().toISOString()};
}

async function fetchGame(key){
  const cfg=games[key]; let lastErr='';
  for(const url of cfg.urls){
    try{
      const r=await axios.get(url,{timeout:12000,headers:{'User-Agent':'Mozilla/5.0 VietlottRealtime/2.0','Accept-Language':'vi-VN,vi;q=0.9'}});
      const parsed=parseMinhChinh(r.data,key); parsed.url=url; return parsed;
    }catch(e){ lastErr=e.message; }
  }
  throw new Error(lastErr || 'Không lấy được dữ liệu');
}

async function saveResult(result){
  if(!result.period) return;
  historyMemory[result.game] ||= [];
  historyMemory[result.game] = [result, ...historyMemory[result.game].filter(x=>x.period!==result.period)].slice(0,50);
  if(!db) return;
  await db.collection('results').updateOne({game:result.game,period:result.period},{$set:result},{upsert:true});
}

function normalizeTicketNumbers(game, input){
  const tokens = Array.isArray(input) ? input : String(input||'').match(/\d{1,3}/g)||[];
  if(game==='max3d' || game==='max3dpro'){
    const arr=tokens.map(x=>String(x).padStart(3,'0')).filter(x=>/^\d{3}$/.test(x));
    if(!arr.length || arr.length>20) throw new Error('Nhập từ 1 đến 20 bộ số gồm 3 chữ số');
    return [...new Set(arr)];
  }
  const arr=tokens.map(Number);
  const need=game==='lotto'?6:6;
  const max=game==='mega'?45:game==='power'?55:35;
  if(arr.length!==need) throw new Error(`Cần nhập đúng ${need} số`);
  if(arr.some((n,i)=>!Number.isInteger(n)||n<1||n>(game==='lotto'&&i===5?35:max))) throw new Error('Có số ngoài phạm vi hợp lệ');
  if(new Set(arr.slice(0, game==='lotto'?5:6)).size!==(game==='lotto'?5:6)) throw new Error('Các số chính không được trùng nhau');
  return arr.map(x=>String(x).padStart(2,'0'));
}

function evaluateTicket(ticket, result){
  if(!result || !result.numbers) return {won:false,summary:'Chưa có kết quả'};
  if(ticket.game==='max3d' || ticket.game==='max3dpro'){
    const prizeMap={}; (result.prizes||[]).forEach(p=>(p.numbers||[]).forEach(n=>prizeMap[n]=p.label));
    const hits=ticket.numbers.filter(n=>prizeMap[n]);
    return {won:hits.length>0, hits, summary:hits.length?`Trúng ${hits.length} bộ: ${hits.map(n=>`${n} (${prizeMap[n]})`).join(', ')}`:'Không trùng bộ số nào'};
  }
  const ticketNums=ticket.numbers.map(Number);
  if(ticket.game==='mega'){
    const main=result.numbers.slice(0,6).map(Number); const matched=ticketNums.filter(n=>main.includes(n));
    return {won:matched.length>=3,matched:matched.length,summary:`Trùng ${matched.length}/6 số${matched.length?': '+matched.map(n=>String(n).padStart(2,'0')).join(', '):''}`};
  }
  if(ticket.game==='power'){
    const main=result.numbers.slice(0,6).map(Number), special=Number(result.numbers[6]);
    const matched=ticketNums.filter(n=>main.includes(n)); const hasSpecial=ticketNums.includes(special);
    return {won:matched.length>=3,matched:matched.length,hasSpecial,summary:`Trùng ${matched.length}/6 số chính${hasSpecial?' + số đặc biệt':''}`};
  }
  if(ticket.game==='lotto'){
    const main=result.numbers.slice(0,5).map(Number), special=Number(result.numbers[5]);
    const picks=ticketNums.slice(0,5), pickSpecial=ticketNums[5];
    const matched=picks.filter(n=>main.includes(n)); const hasSpecial=pickSpecial===special;
    // Chỉ dùng để cảnh báo vé có khả năng trúng; người dùng vẫn cần đối chiếu cơ cấu giải chính thức.
    return {won:matched.length>=2 || hasSpecial,matched:matched.length,hasSpecial,summary:`Trùng ${matched.length}/5 số chính${hasSpecial?' + số đặc biệt':''}`};
  }
  return {won:false,summary:'Không hỗ trợ'};
}

async function allActiveTickets(game){
  if(db) return db.collection('tickets').find({game,active:true}).toArray();
  return ticketsMemory.filter(t=>t.game===game&&t.active);
}
async function patchTicket(id, patch){
  if(db) return db.collection('tickets').updateOne({ticketId:id},{$set:patch});
  const t=ticketsMemory.find(x=>x.ticketId===id); if(t) Object.assign(t,patch);
}
async function sendTelegram(chatId,text){
  if(!TELEGRAM_BOT_TOKEN || !chatId) return false;
  try{ await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{chat_id:String(chatId),text,disable_web_page_preview:true},{timeout:10000}); return true; }
  catch(e){ console.error('[Telegram]',e.response?.data?.description||e.message); return false; }
}
async function checkSavedTickets(result){
  const tickets=await allActiveTickets(result.game);
  for(const t of tickets){
    if(t.lastCheckedPeriod===result.period) continue;
    const ev=evaluateTicket(t,result);
    const patch={lastCheckedPeriod:result.period,lastCheck:ev,checkedAt:new Date().toISOString()};
    if(ev.won && t.telegramChatId && t.lastNotifiedPeriod!==result.period){
      const msg=`🎟 ${games[t.game].name}\nVé: ${t.label||t.numbers.join(' ')}\nKỳ #${result.period} - ${result.date||''}\n${ev.summary}\n\nHãy đối chiếu lại kết quả/cơ cấu giải chính thức trước khi lĩnh thưởng.${PUBLIC_URL?`\n${PUBLIC_URL}/?game=${t.game}`:''}`;
      if(await sendTelegram(t.telegramChatId,msg)) patch.lastNotifiedPeriod=result.period;
    }
    await patchTicket(t.ticketId,patch);
  }
}

async function refresh(key, force=false){
  try{
    const r=await fetchGame(key); const old=latest[key]; latest[key]=r; await saveResult(r);
    const changed=!old || old.period!==r.period || JSON.stringify(old.numbers)!==JSON.stringify(r.numbers);
    if(changed){ await checkSavedTickets(r); io.emit('result:update', r); }
    else if(force) io.emit('result:update',r);
    return r;
  }catch(e){ latest[key]={...(latest[key]||{game:key,name:games[key].name}),error:e.message,updatedAt:new Date().toISOString()}; return latest[key]; }
}
async function refreshAll(force=false){ for(const key of Object.keys(games)) await refresh(key,force); }

app.get('/api/config',(req,res)=>res.json({ok:true,games:Object.fromEntries(Object.entries(games).map(([k,v])=>[k,{name:v.name,color:v.color}])),telegramEnabled:!!TELEGRAM_BOT_TOKEN,database:!!db}));
app.get('/api/results',(req,res)=>res.json({ok:true,results:latest}));
app.get('/api/results/:game',async(req,res)=>{ const key=req.params.game; if(!games[key]) return res.status(404).json({ok:false,error:'Game không tồn tại'}); const r=await refresh(key,true); res.json({ok:!r.error,result:r}); });
app.post('/api/admin/refresh',async(req,res)=>{ if(req.headers['x-admin-key']!==ADMIN_KEY) return res.status(401).json({ok:false,error:'Sai ADMIN_KEY'}); await refreshAll(true); res.json({ok:true,results:latest}); });
app.get('/api/history/:game',async(req,res)=>{
  if(!games[req.params.game]) return res.status(404).json({ok:false,error:'Game không tồn tại'});
  const limit=Math.min(50,Math.max(1,Number(req.query.limit||20)));
  const history=db ? await db.collection('results').find({game:req.params.game}).sort({updatedAt:-1}).limit(limit).toArray() : (historyMemory[req.params.game]||[]).slice(0,limit);
  res.json({ok:true,history});
});
app.post('/api/check',(req,res)=>{
  try{ const {game}=req.body; if(!games[game]) throw new Error('Game không tồn tại'); const numbers=normalizeTicketNumbers(game,req.body.numbers); const ev=evaluateTicket({game,numbers},latest[game]); res.json({ok:true,numbers,evaluation:ev,result:latest[game]||null}); }
  catch(e){ res.status(400).json({ok:false,error:e.message}); }
});
app.get('/api/tickets',async(req,res)=>{
  const ownerKey=String(req.query.ownerKey||''); if(!ownerKey) return res.status(400).json({ok:false,error:'Thiếu ownerKey'});
  const tickets=db ? await db.collection('tickets').find({ownerKey}).sort({createdAt:-1}).limit(100).toArray() : ticketsMemory.filter(t=>t.ownerKey===ownerKey).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  res.json({ok:true,tickets});
});
app.post('/api/tickets',async(req,res)=>{
  try{
    const ownerKey=String(req.body.ownerKey||'').slice(0,80); const game=String(req.body.game||'');
    if(!ownerKey) throw new Error('Thiếu ownerKey'); if(!games[game]) throw new Error('Game không tồn tại');
    const numbers=normalizeTicketNumbers(game,req.body.numbers);
    const ticket={ticketId:crypto.randomUUID(),ownerKey,game,numbers,label:String(req.body.label||'').slice(0,80),telegramChatId:String(req.body.telegramChatId||'').replace(/[^\d-]/g,'').slice(0,30),active:true,createdAt:new Date().toISOString(),lastCheckedPeriod:null,lastNotifiedPeriod:null};
    if(db) await db.collection('tickets').insertOne(ticket); else ticketsMemory.push(ticket);
    res.json({ok:true,ticket});
  }catch(e){res.status(400).json({ok:false,error:e.message});}
});
app.delete('/api/tickets/:id',async(req,res)=>{
  const ownerKey=String(req.query.ownerKey||'');
  if(db) await db.collection('tickets').deleteOne({ticketId:req.params.id,ownerKey});
  else { const i=ticketsMemory.findIndex(t=>t.ticketId===req.params.id&&t.ownerKey===ownerKey); if(i>=0) ticketsMemory.splice(i,1); }
  res.json({ok:true});
});
app.post('/api/tickets/:id/check',async(req,res)=>{
  const ownerKey=String(req.body.ownerKey||'');
  const t=db ? await db.collection('tickets').findOne({ticketId:req.params.id,ownerKey}) : ticketsMemory.find(x=>x.ticketId===req.params.id&&x.ownerKey===ownerKey);
  if(!t) return res.status(404).json({ok:false,error:'Không tìm thấy vé'});
  const ev=evaluateTicket(t,latest[t.game]); await patchTicket(t.ticketId,{lastCheck:ev,lastCheckedPeriod:latest[t.game]?.period||null,checkedAt:new Date().toISOString()});
  res.json({ok:true,evaluation:ev,result:latest[t.game]||null});
});
app.post('/telegram/webhook',async(req,res)=>{
  res.sendStatus(200); if(!TELEGRAM_BOT_TOKEN) return;
  const msg=req.body?.message; if(!msg?.chat?.id) return;
  const text=String(msg.text||'');
  if(/^\/start/i.test(text) || /^\/id/i.test(text)) await sendTelegram(msg.chat.id,`✅ Đã kết nối bot.\nChat ID của bạn: ${msg.chat.id}\n\nNhập Chat ID này khi lưu vé trên web để nhận thông báo.`);
});
app.get('/health',(req,res)=>res.json({ok:true,time:new Date().toISOString(),mongo:!!db,telegram:!!TELEGRAM_BOT_TOKEN}));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'..','public','index.html')));
io.on('connection', socket => socket.emit('init',{results:latest}));

async function setupTelegramWebhook(){
  if(!TELEGRAM_BOT_TOKEN || !PUBLIC_URL) return;
  try{ await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`,{url:`${PUBLIC_URL}/telegram/webhook`},{timeout:10000}); console.log('[Telegram] webhook ready'); }
  catch(e){ console.error('[Telegram webhook]',e.response?.data?.description||e.message); }
}

(async()=>{ await initMongo(); await setupTelegramWebhook(); await refreshAll(); setInterval(()=>refreshAll(),REFRESH_MS).unref(); server.listen(PORT,()=>console.log('Server listen on port',PORT)); })();
