const express = require('express');
const http = require('http');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 10000;
const MONGODB_URI = process.env.MONGODB_URI || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '123456';
const REFRESH_MS = Math.max(15000, Number(process.env.REFRESH_MS || 30000));

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const games = {
  mega: { name:'Mega 6/45', color:'#e53935', urls:['https://www.minhchinh.com/truc-tiep-xo-so-tu-chon-mega-645.html'] },
  power:{ name:'Power 6/55', color:'#f6a800', urls:['https://www.minhchinh.com/truc-tiep-xo-so-tu-chon-power-655.html'] },
  lotto:{ name:'Lotto 5/35', color:'#18a957', urls:['https://www.minhchinh.com/truc-tiep-xo-so-lotto-535.html','https://www.minhchinh.com/xo-so-vietlott-lotto-535.html'] },
  max3dpro:{ name:'Max3D Pro', color:'#00a3c7', urls:['https://www.minhchinh.com/truc-tiep-xo-so-max3d-pro.html'] },
  max3d:{ name:'Max 3D', color:'#1967d2', urls:['https://www.minhchinh.com/truc-tiep-xo-so-max-3d.html'] }
};

let latest = {};
let mongo = null;
let db = null;

async function initMongo(){
  if(!MONGODB_URI) return;
  try {
    mongo = new MongoClient(MONGODB_URI);
    await mongo.connect();
    db = mongo.db();
    console.log('[MongoDB] connected');
  } catch(e){ console.error('[MongoDB]', e.message); }
}

function clean(s){ return String(s||'').replace(/\s+/g,' ').trim(); }
function extractNumbers(text, game){
  const all = (text.match(/\b\d{1,2}\b/g)||[]).map(n=>n.padStart(2,'0'));
  const max = game==='mega'?45:game==='power'?55:game==='lotto'?35:99;
  const wanted = game==='lotto'?6:(game==='mega'?6:(game==='power'?7:0));
  if(!wanted) return [];
  // Find a plausible consecutive window. For lotto, result commonly includes 5 main + 1 special.
  for(let i=0;i<=all.length-wanted;i++){
    const w=all.slice(i,i+wanted); const vals=w.map(Number);
    if(vals.every(v=>v>=1&&v<=max)) return w;
  }
  return [];
}

function parseMinhChinh(html, key){
  const $ = cheerio.load(html);
  const body = clean($('body').text());
  const cfg = games[key];
  let period = '';
  let date = '';
  const m = body.match(/Kết quả QSMT kỳ\s*#?(\d+)\s*ngày\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
  if(m){ period=m[1]; date=m[2]; }
  let numbers=[];
  // Prefer visible number-like elements near the result heading.
  const heading = $('*:contains("Kết quả QSMT kỳ")').last();
  if(heading.length){
    const near = clean(heading.parent().text());
    numbers = extractNumbers(near, key);
  }
  if(!numbers.length) numbers = extractNumbers(body, key);
  const jackpots=[];
  const jackpotRegex = /Giá trị Jackpot(?:\s*([12]))?\s*([\d.,]+)/gi;
  let jm; while((jm=jackpotRegex.exec(body))!==null){ jackpots.push({label:'Jackpot'+(jm[1]?' '+jm[1]:''), value:jm[2]}); if(jackpots.length>=2) break; }
  return {game:key,name:cfg.name,period,date,numbers,jackpots,source:'MinhChinh',updatedAt:new Date().toISOString()};
}

async function fetchGame(key){
  const cfg=games[key];
  let lastErr='';
  for(const url of cfg.urls){
    try{
      const r=await axios.get(url,{timeout:12000,headers:{'User-Agent':'Mozilla/5.0 VietlottRealtime/1.0','Accept-Language':'vi-VN,vi;q=0.9'}});
      const parsed=parseMinhChinh(r.data,key);
      if(parsed.period || parsed.numbers.length){
        parsed.url=url;
        return parsed;
      }
      lastErr='Không nhận diện được dữ liệu';
    }catch(e){ lastErr=e.message; }
  }
  throw new Error(lastErr || 'Không lấy được dữ liệu');
}

async function saveResult(result){
  if(!db || !result.period) return;
  await db.collection('results').updateOne(
    {game:result.game,period:result.period},
    {$set:result},
    {upsert:true}
  );
}

async function refresh(key, force=false){
  try{
    const r=await fetchGame(key);
    const old=latest[key];
    latest[key]=r;
    await saveResult(r);
    const changed=!old || old.period!==r.period || JSON.stringify(old.numbers)!==JSON.stringify(r.numbers);
    if(changed || force) io.emit('result:update', r);
    return r;
  }catch(e){
    latest[key]={...(latest[key]||{game:key,name:games[key].name}),error:e.message,updatedAt:new Date().toISOString()};
    return latest[key];
  }
}

async function refreshAll(force=false){
  for(const key of Object.keys(games)) await refresh(key,force);
}

app.get('/api/results',(req,res)=>res.json({ok:true,results:latest}));
app.get('/api/results/:game',async(req,res)=>{
  const key=req.params.game;
  if(!games[key]) return res.status(404).json({ok:false,error:'Game không tồn tại'});
  const r=await refresh(key,true);
  res.json({ok:!r.error,result:r});
});
app.post('/api/admin/refresh',async(req,res)=>{
  if(req.headers['x-admin-key']!==ADMIN_KEY) return res.status(401).json({ok:false,error:'Sai ADMIN_KEY'});
  await refreshAll(true); res.json({ok:true,results:latest});
});
app.get('/api/history/:game',async(req,res)=>{
  if(!db) return res.json({ok:true,history:[]});
  const history=await db.collection('results').find({game:req.params.game}).sort({updatedAt:-1}).limit(30).toArray();
  res.json({ok:true,history});
});
app.get('/health',(req,res)=>res.json({ok:true,time:new Date().toISOString()}));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'..','public','index.html')));

io.on('connection', socket => socket.emit('init',{results:latest}));

(async()=>{
  await initMongo();
  await refreshAll();
  setInterval(()=>refreshAll(),REFRESH_MS).unref();
  server.listen(PORT,()=>console.log('Server listen on port',PORT));
})();
