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
  mega: { name:'Mega 6/45', color:'#e53935', urls:['https://www.minhchinh.com/xo-so-dien-toan-mega-645.html'] },
  power:{ name:'Power 6/55', color:'#f6a800', urls:['https://www.minhchinh.com/xo-so-dien-toan-power-655.html'] },
  lotto:{ name:'Lotto 5/35', color:'#18a957', urls:['https://www.minhchinh.com/xo-so-dien-toan.html'] },
  max3dpro:{ name:'Max3D Pro', color:'#00a3c7', urls:['https://www.minhchinh.com/xo-so-dien-toan-max3d-pro.html'] },
  max3d:{ name:'Max 3D', color:'#1967d2', urls:['https://www.minhchinh.com/xo-so-dien-toan-max-3d.html'] }
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
function parseMinhChinh(html, key){
  const $ = cheerio.load(html);
  const cfg = games[key];

  // Quan trọng: chỉ lấy KHỐI KẾT QUẢ ĐẦU TIÊN của đúng game.
  // Bản cũ quét toàn bộ body nên dính ngày, kỳ, bảng thống kê và kết quả game khác.
  const body = clean($('body').text());
  const title = key==='max3dpro' ? 'Kết quả Max3D Pro' :
                key==='max3d' ? 'Kết quả Max 3D' :
                key==='power' ? 'Kết quả Power 6/55' :
                key==='lotto' ? 'Kết quả Lotto 5/35' : 'Kết quả Mega 6/45';
  const pos = body.indexOf(title);
  if(pos < 0) throw new Error('Không tìm thấy khối '+title);
  const after = body.slice(pos + title.length);
  const nextResult = after.search(/Kết quả (?:Mega 6\/45|Power 6\/55|Lotto 5\/35|Max3D Pro|Max 3D)/);
  const block = nextResult >= 0 ? after.slice(0,nextResult) : after.slice(0,3500);

  const m = block.match(/Kết quả QSMT kỳ\s*#?(\d+)\s*ngày\s*(\d{1,2}\/\d{1,2}\/\d{4})(?:\s*-\s*Lúc\s*([0-9:]+))?/i);
  if(!m) throw new Error('Không đọc được kỳ/ngày');
  const period=m[1], date=m[2], time=m[3]||'';

  let numbers=[];
  let prizes=[];
  if(key==='mega' || key==='power' || key==='lotto'){
    const tail=block.slice(m.index+m[0].length);
    const count=key==='mega'?6:(key==='power'?7:6);
    const max=key==='mega'?45:(key==='power'?55:35);
    // Chỉ đọc dãy số ngay sau dòng kỳ/ngày, trước Jackpot/Độc Đắc.
    const firstPart=tail.split(/Giá trị (?:Jackpot|Độc Đắc)/i)[0];
    const candidates=(firstPart.match(/\b\d{1,2}\b/g)||[]).map(x=>x.padStart(2,'0'));
    numbers=candidates.slice(0,count);
    if(numbers.length!==count || numbers.some(x=>Number(x)<1 || Number(x)>max))
      throw new Error('Bộ số không hợp lệ: '+numbers.join(' '));
  } else {
    // Max3D / Max3D Pro: 20 bộ 3 chữ số = 2 ĐB + 4 nhất + 6 nhì + 8 ba.
    const tail=block.slice(m.index+m[0].length);
    const stop=tail.search(/(?:Thống kê tần suất|Dò kết quả|In vé dò)/i);
    const tablePart=stop>=0?tail.slice(0,stop):tail;
    const triples=(tablePart.match(/\b\d{3}\b/g)||[]);
    // Loại số tiền/SL bằng cách ưu tiên DOM các hàng giải nếu có.
    const wanted=[];
    $('tr').each((_,tr)=>{
      const txt=clean($(tr).text());
      if(!/^(Đặc biệt|Giải nhất|Giải nhì|Giải ba)\b/i.test(txt)) return;
      const t=(txt.match(/\b\d{3}\b/g)||[]);
      const need=/^Đặc biệt/i.test(txt)?2:/^Giải nhất/i.test(txt)?4:/^Giải nhì/i.test(txt)?6:8;
      wanted.push(...t.slice(0,need));
    });
    numbers=(wanted.length>=20?wanted.slice(0,20):triples.slice(0,20));
    if(numbers.length<20) throw new Error('Không đọc đủ 20 bộ số Max3D');
    prizes=[
      {label:'Đặc biệt',numbers:numbers.slice(0,2)},
      {label:'Giải nhất',numbers:numbers.slice(2,6)},
      {label:'Giải nhì',numbers:numbers.slice(6,12)},
      {label:'Giải ba',numbers:numbers.slice(12,20)}
    ];
  }

  const jackpots=[];
  const jp=/Giá trị (Jackpot(?:\s*[12])?|Độc Đắc)\s*([\d.,]+)/gi;
  let jm; while((jm=jp.exec(block))!==null){ jackpots.push({label:jm[1],value:jm[2]}); if(jackpots.length>=2) break; }
  return {game:key,name:cfg.name,period,date,time,numbers,prizes,jackpots,source:'MinhChinh',updatedAt:new Date().toISOString()};
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
