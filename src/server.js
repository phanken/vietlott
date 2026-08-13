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
  max3dpro:{ name:'Max3D Pro', color:'#00a3c7', urls:['https://www.minhchinh.com/xo-so-dien-toan-max3d-pro.html','https://www.minhchinh.com/truc-tiep-xo-so-tu-chon-max3d-pro.html'] },
  max3d:{ name:'Max 3D', color:'#1967d2', urls:['https://www.minhchinh.com/xo-so-dien-toan-max-3d.html','https://www.minhchinh.com/truc-tiep-xo-so-tu-chon-max-3d.html'] }
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
  const body = clean($('body').text());

  // Max3D / Max3D Pro: MinhChinh hiện không dùng một cấu trúc <table>
  // cố định ở mọi trang. Parser V4 đọc theo nội dung từng hàng giải thay vì
  // phụ thuộc thẻ table/td, nhờ vậy dùng được cả trang kết quả và trang trực tiếp.
  if(key==='max3d' || key==='max3dpro'){
    const pm = body.match(/Kết quả QSMT kỳ\s*#?(\d+)\s*ngày\s*(\d{1,2}\/\d{1,2}\/\d{4})(?:\s*-\s*Lúc\s*([0-9:]+))?/i);
    if(!pm) throw new Error('Không đọc được kỳ/ngày Max3D');
    const period=pm[1], date=pm[2], time=pm[3]||'';

    // Chỉ parse kỳ mới nhất, tránh lẫn các kỳ cũ phía dưới trang.
    const p0 = body.indexOf(pm[0]);
    let block = body.slice(p0 + pm[0].length);
    const p1 = block.search(/Kết quả QSMT kỳ\s*#?\d+/i);
    if(p1 >= 0) block = block.slice(0, p1);
    block = block.slice(0, 5000);

    const nums = txt => (String(txt).match(/\b\d{3}\b/g)||[]);
    const takeImmediate = (label, need) => {
      // Max3D Pro: "Đặc biệt 398 723 2 Tỷ ..."
      const re = new RegExp(label + '\\s+((?:\\d{3}\\s+){' + (need-1) + '}\\d{3})(?=\\s|$)', 'i');
      const m = block.match(re);
      return m ? nums(m[1]).slice(0, need) : [];
    };
    const takeAfterCount = (label, need) => {
      // Max 3D: "Giải nhất 350K: 83 853 988 718 792 Giải nhất ..."
      // Bỏ số lượng người trúng ở cột trái (83), chỉ lấy cột Số Quay Thưởng.
      const re = new RegExp(label + '[^:]{0,40}:\\s*\\d+\\s+((?:\\d{3}\\s+){' + (need-1) + '}\\d{3})(?=\\s|$)', 'i');
      const m = block.match(re);
      return m ? nums(m[1]).slice(0, need) : [];
    };

    let db=[], g1=[], g2=[], g3=[];
    if(key==='max3dpro'){
      db=takeImmediate('Đặc biệt',2);
      g1=takeImmediate('Giải nhất',4);
      g2=takeImmediate('Giải nhì',6);
      g3=takeImmediate('Giải ba',8);
    } else {
      db=takeAfterCount('Đặc biệt',2);
      g1=takeAfterCount('Giải nhất',4);
      g2=takeAfterCount('Giải nhì',6);
      g3=takeAfterCount('Giải ba',8);

      // Một số phiên bản trang tối giản bỏ cột thống kê bên trái.
      if(db.length!==2) db=takeImmediate('Đặc biệt',2);
      if(g1.length!==4) g1=takeImmediate('Giải nhất',4);
      if(g2.length!==6) g2=takeImmediate('Giải nhì',6);
      if(g3.length!==8) g3=takeImmediate('Giải ba',8);
    }

    if(db.length!==2 || g1.length!==4 || g2.length!==6 || g3.length!==8){
      throw new Error(`Không đọc đủ bộ số Max3D (ĐB ${db.length}/2, G1 ${g1.length}/4, G2 ${g2.length}/6, G3 ${g3.length}/8)`);
    }

    const numbers=[...db,...g1,...g2,...g3];
    const prizes=[
      {label:'Đặc biệt',numbers:db},
      {label:'Giải nhất',numbers:g1},
      {label:'Giải nhì',numbers:g2},
      {label:'Giải ba',numbers:g3}
    ];
    return {game:key,name:cfg.name,period,date,time,numbers,prizes,jackpots:[],source:'MinhChinh',updatedAt:new Date().toISOString()};
  }

  // Mega / Power / Lotto: chỉ lấy khối kết quả đầu tiên của đúng game.
  const title = key==='power' ? 'Kết quả Power 6/55' :
                key==='lotto' ? 'Kết quả Lotto 5/35' : 'Kết quả Mega 6/45';
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
  if(numbers.length!==count || numbers.some(x=>Number(x)<1 || Number(x)>max))
    throw new Error('Bộ số không hợp lệ: '+numbers.join(' '));

  const jackpots=[];
  const jp=/Giá trị (Jackpot(?:\s*[12])?|Độc Đắc)\s*([\d.,]+)/gi;
  let jm; while((jm=jp.exec(block))!==null){ jackpots.push({label:jm[1],value:jm[2]}); if(jackpots.length>=2) break; }
  return {game:key,name:cfg.name,period,date,time,numbers,prizes:[],jackpots,source:'MinhChinh',updatedAt:new Date().toISOString()};
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
