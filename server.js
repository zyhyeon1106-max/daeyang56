'use strict';
const express=require('express');
const cookieParser=require('cookie-parser');
const helmet=require('helmet');
const crypto=require('crypto');
const fs=require('fs');
const path=require('path');
const {Pool}=require('pg');
const app=express();
const PORT=process.env.PORT||3000;
const prod=process.env.NODE_ENV==='production';
if(prod && (!process.env.DATABASE_URL || !process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET)) { console.error('필수 환경변수 DATABASE_URL, ADMIN_PASSWORD, SESSION_SECRET이 누락되었습니다.');process.exit(1); }
app.disable('x-powered-by');
app.set('trust proxy',1);
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'"],imgSrc:["'self'","data:"],connectSrc:["'self'"],fontSrc:["'self'"]}}}));
app.use(express.json({limit:'24kb'}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname,'public'),{index:false,maxAge:'1h'}));
const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:5}):null;
const localPath=path.join(__dirname,'local-data.json');
let local={posts:[],students:[],classes:{},settings:{},next:1};
if(!pool&&fs.existsSync(localPath)) {try{local=JSON.parse(fs.readFileSync(localPath,'utf8'));}catch{}}
const persist=()=>{if(!pool)fs.writeFileSync(localPath,JSON.stringify(local,null,2));};
const classes=Array.from({length:8},(_,i)=>`${i<4?5:6}-${i%4+1}`);
function cls(v){return classes.includes(String(v))?String(v):null;}
function clean(v,max=500){return String(v??'').trim().replace(/\s+/g,' ').slice(0,max);}
function textBody(v,max=1600){return String(v??'').trim().slice(0,max);}
function cookieSig(payload){return crypto.createHmac('sha256',process.env.SESSION_SECRET||'LOCAL_DEV_ONLY_SECRET').update(payload).digest('hex');}
function isAdmin(req){const raw=req.cookies.hs_admin;if(!raw)return false;const [payload,sig]=raw.split('.');if(!payload||!sig||sig.length!==64)return false;try{return crypto.timingSafeEqual(Buffer.from(cookieSig(payload),'hex'),Buffer.from(sig,'hex'))&&Number(payload)>Date.now();}catch{return false;}}
function admin(req,res,next){if(!isAdmin(req))return res.status(401).json({error:'관리자 로그인이 필요합니다.'});next();}
const rate=new Map();
function throttle(req,res,next){const key=req.ip||'unknown',now=Date.now(),x=rate.get(key)||[];const a=x.filter(t=>now-t<60000);if(a.length>=80)return res.status(429).json({error:'요청이 너무 많습니다. 잠시 후 다시 시도하세요.'});a.push(now);rate.set(key,a);next();}
app.use('/api',throttle);
function sendErr(res,error){console.error(error);res.status(500).json({error:'저장 과정에서 문제가 발생했습니다. 잠시 후 다시 시도하세요.'});}
async function init(){if(!pool)return;
await pool.query(`CREATE TABLE IF NOT EXISTS hs_students(id BIGSERIAL PRIMARY KEY, class_id TEXT NOT NULL, name TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(class_id,name));
CREATE TABLE IF NOT EXISTS hs_posts(id BIGSERIAL PRIMARY KEY, class_id TEXT NOT NULL, student_id BIGINT REFERENCES hs_students(id) ON DELETE SET NULL, nickname TEXT NOT NULL, kind TEXT NOT NULL, mission INTEGER, choice TEXT, body TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS hs_classes(class_id TEXT PRIMARY KEY, total_students INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS hs_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
for(const c of classes)await pool.query('INSERT INTO hs_classes(class_id,total_students) VALUES($1,0) ON CONFLICT DO NOTHING',[c]);
}
async function q(sql,args=[]){return (await pool.query(sql,args)).rows;}
async function ensureStudent(c,name){if(pool){const r=await q('INSERT INTO hs_students(class_id,name) VALUES($1,$2) ON CONFLICT(class_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id',[c,name]);return String(r[0].id);}let v=local.students.find(s=>s.class_id===c&&s.name===name);if(!v){v={id:local.next++,class_id:c,name};local.students.push(v);persist();}return String(v.id);}
function masked(name){return name.length<=1?'*':name[0]+'○'.repeat(Math.max(1,name.length-1));}
function safePost(p,priv=false){return {id:Number(p.id),class_id:p.class_id,mission:p.mission===null?null:Number(p.mission),kind:p.kind,choice:p.choice||'',body:p.body,created_at:p.created_at,display_name:p.nickname,...(priv?{student_id:String(p.student_id||'')}: {})};}
async function getPosts(filter={},priv=false){let rows=[];if(pool){let where=[],args=[];for(const [k,v] of Object.entries(filter)){args.push(v);where.push(`${k}=$${args.length}`);}rows=await q(`SELECT * FROM hs_posts ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY created_at DESC,id DESC LIMIT 2000`,args);}else rows=local.posts.filter(p=>Object.entries(filter).every(([k,v])=>String(p[k])===String(v))).sort((a,b)=>b.id-a.id).slice(0,2000);return rows.map(p=>safePost(p,priv));}
async function getStats(){const students=pool?await q('SELECT id,class_id FROM hs_students'):local.students;const records=pool?await q('SELECT DISTINCT class_id, student_id, mission FROM hs_posts WHERE kind=$1 AND mission BETWEEN 1 AND 4',['mission']):local.posts.filter(p=>p.kind==='mission'&&p.mission>=1&&p.mission<=4);const totals=pool?await q('SELECT class_id,total_students FROM hs_classes'):classes.map(c=>({class_id:c,total_students:local.classes[c]||0}));return classes.map(c=>{const total=Number(totals.find(t=>t.class_id===c)?.total_students||0);const st=students.filter(s=>s.class_id===c);const ids=new Set(st.map(s=>String(s.id)));const uniq=new Set(records.filter(r=>r.class_id===c&&ids.has(String(r.student_id))).map(r=>`${r.student_id}:${r.mission}`));const engaged=new Set(Array.from(uniq).map(s=>s.split(':')[0])).size;return {class_id:c,total_students:total,participant_count:engaged,completed_missions:uniq.size,total_missions:total*4,participation_pct:total?Math.min(100,Math.round(engaged/total*100)):0,completion_pct:total?Math.min(100,Math.round(uniq.size/(total*4)*100)):0,configured:total>0};});}
app.post('/api/entry',async(req,res)=>{const c=cls(req.body.class_id),name=clean(req.body.name,24);if(!c||name.length<2||name.length>24)return res.status(400).json({error:'학급을 선택하고 이름을 2~24자로 입력해 주세요.'});try{const sid=await ensureStudent(c,name);res.json({class_id:c,name,student_id:sid});}catch(e){sendErr(res,e);}});
app.get('/api/stats',async(req,res)=>{try{res.json(await getStats());}catch(e){sendErr(res,e);}});
app.get('/api/posts',async(req,res)=>{let filter={};if(req.query.class_id){let c=cls(req.query.class_id);if(!c)return res.status(400).json({error:'학급을 확인해 주세요.'});filter.class_id=c;}if(req.query.kind){if(!['mission','question','idea'].includes(req.query.kind))return res.status(400).json({error:'잘못된 종류입니다.'});filter.kind=req.query.kind;}if(req.query.mission){const m=Number(req.query.mission);if(![1,2,3,4].includes(m))return res.status(400).json({error:'잘못된 미션입니다.'});filter.mission=m;}try{res.json(await getPosts(filter,false));}catch(e){sendErr(res,e);}});
app.post('/api/posts',async(req,res)=>{const c=cls(req.body.class_id),name=clean(req.body.name,24),kind=clean(req.body.kind,12),body=textBody(req.body.body),mission=Number(req.body.mission),choice=clean(req.body.choice,30);if(!c||name.length<2||!['mission','question','idea'].includes(kind)||body.length<5||body.length>1600||kind==='mission'&&![1,2,3,4].includes(mission))return res.status(400).json({error:'학급, 이름, 질문과 답변(5~1600자)을 확인해 주세요.'});if(kind==='mission'&&mission===2&&!['유명한 사람','실력 있는 사람'].includes(choice))return res.status(400).json({error:'미션 2의 선택지를 선택해 주세요.'});try{const sid=await ensureStudent(c,name);let row;if(pool){row=(await q('INSERT INTO hs_posts(class_id,student_id,nickname,kind,mission,choice,body) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[c,sid,name,kind,kind==='mission'?mission:null,choice,body]))[0];}else{row={id:local.next++,class_id:c,student_id:sid,nickname:name,kind,mission:kind==='mission'?mission:null,choice,body,created_at:new Date().toISOString()};local.posts.push(row);persist();}res.status(201).json(safePost(row));}catch(e){sendErr(res,e);}});
app.post('/api/admin/login',(req,res)=>{const target=process.env.ADMIN_PASSWORD||'local-admin-change-me',given=String(req.body.password||'');const a=crypto.createHash('sha256').update(target).digest(),b=crypto.createHash('sha256').update(given).digest();if(!crypto.timingSafeEqual(a,b))return res.status(401).json({error:'관리자 비밀번호가 올바르지 않습니다.'});const payload=String(Date.now()+8*60*60*1000);res.cookie('hs_admin',`${payload}.${cookieSig(payload)}`,{httpOnly:true,sameSite:'strict',secure:prod,maxAge:8*60*60*1000,path:'/'});res.json({ok:true});});
app.post('/api/admin/logout',(req,res)=>{res.clearCookie('hs_admin',{path:'/'});res.json({ok:true});});
app.get('/api/admin/status',(req,res)=>res.json({admin:isAdmin(req)}));
app.get('/api/admin/posts',admin,async(req,res)=>{try{res.json(await getPosts({},true));}catch(e){sendErr(res,e);}});
app.get('/api/admin/students',admin,async(req,res)=>{try{const rows=pool?await q('SELECT id,class_id,name FROM hs_students ORDER BY class_id,name'):local.students;res.json(rows.map(s=>({id:String(s.id),class_id:s.class_id,name:s.name})));}catch(e){sendErr(res,e);}});
// 관리자 학생 삭제: 소속 학생의 글도 함께 삭제하여 익명 게시글이 남지 않게 처리한다.
app.delete('/api/admin/students/:id',admin,async(req,res)=>{
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'잘못된 학생 번호입니다.'});
  try{
    if(pool){
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        const existing=await client.query('SELECT id FROM hs_students WHERE id=$1 FOR UPDATE',[id]);
        if(!existing.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'해당 학생을 찾을 수 없습니다.'});}
        await client.query('DELETE FROM hs_posts WHERE student_id=$1',[id]);
        await client.query('DELETE FROM hs_students WHERE id=$1',[id]);
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }else{
      const exists=local.students.some(s=>Number(s.id)===id);
      if(!exists)return res.status(404).json({error:'해당 학생을 찾을 수 없습니다.'});
      local.posts=local.posts.filter(p=>Number(p.student_id)!==id);
      local.students=local.students.filter(s=>Number(s.id)!==id);
      persist();
    }
    res.json({ok:true});
  }catch(error){sendErr(res,error);}
});
app.put('/api/admin/classes/:id',admin,async(req,res)=>{const c=cls(req.params.id),count=Number(req.body.total_students);if(!c||!Number.isInteger(count)||count<0||count>60)return res.status(400).json({error:'학생 수는 0~60명 사이로 입력하세요.'});try{if(pool)await q('UPDATE hs_classes SET total_students=$1 WHERE class_id=$2',[count,c]);else{local.classes[c]=count;persist();}res.json({ok:true});}catch(e){sendErr(res,e);}});
app.delete('/api/admin/posts/:id',admin,async(req,res)=>{const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'잘못된 번호입니다.'});try{if(pool)await q('DELETE FROM hs_posts WHERE id=$1',[id]);else{local.posts=local.posts.filter(p=>p.id!==id);persist();}res.json({ok:true});}catch(e){sendErr(res,e);}});
app.get('/api/author/posts',async(req,res)=>{const target=process.env.AUTHOR_TOKEN;if(!target||req.query.token!==target)return res.status(403).json({error:'작가 전용 접근 주소가 필요합니다.'});try{res.json(await getPosts({},false));}catch(e){sendErr(res,e);}});
app.get('/api/health',async(req,res)=>{try{if(pool)await q('SELECT 1');res.json({ok:true,storage:pool?'postgres':'local-demo'});}catch(e){sendErr(res,e);}});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
if(require.main===module){init().then(()=>app.listen(PORT,()=>console.log(`Reading wall running on :${PORT}`))).catch(e=>{console.error('DB 준비 실패',e);process.exit(1);});}
module.exports={app,init,masked};
