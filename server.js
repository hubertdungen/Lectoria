'use strict';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const DATA = process.env.LECTORIA_DATA || path.join(__dirname, 'data');
const KAVITA = process.env.LECTORIA_KAVITA_URL || 'http://127.0.0.1:5000';
const VOICE = process.env.LECTORIA_VOICE_URL || 'http://127.0.0.1:8103';
const KEY = process.env.LECTORIA_VOICE_KEY_FILE || path.join(DATA, 'voice-bridge.key');
// Blogs the reader may import from (public Blogger feeds); an allowlist so the server never fetches arbitrary URLs.
const BLOGS = (process.env.LECTORIA_BLOGS ?? 'https://ocosmosracional.blogspot.com,https://therationalcosmos.blogspot.com').split(',').map(x => x.trim().replace(/\/+$/, '')).filter(Boolean);
const CLOUD = process.env.LECTORIA_CLOUD_DIR || '';
const PYTHON = process.env.LECTORIA_PYTHON ?? 'python3';
const STATS = path.join(DATA, 'stats.json');
// Passages synthesised on the host are kept on disk (a `cache/` folder, which the Kopia backup ignores) so a refresh,
// another device or a later full-audio job never asks the engine for the same text twice. Size-capped, oldest first.
const CACHE = process.env.LECTORIA_CACHE_DIR || path.join(DATA, 'cache');
const CACHE_MAX = Number(process.env.LECTORIA_CACHE_MAX_MB || 6000) * 1048576;
const voiceKey = (text, voice, rate) => hash(voice + '\n' + rate + '\n' + text).slice(0, 40);
const cacheFile = key => path.join(CACHE, key + '.wav');
async function readCache(key) { try { const data = await fsp.readFile(cacheFile(key)); const now = new Date(); fsp.utimes(cacheFile(key), now, now).catch(() => {}); return data; } catch { return null; } }
let lastTrim = 0;
async function writeCache(key, data) {
  try { await fsp.mkdir(CACHE, { recursive: true, mode: 0o700 }); const temp = cacheFile(key) + '.' + crypto.randomUUID(); await fsp.writeFile(temp, data, { mode: 0o600 }); await fsp.rename(temp, cacheFile(key)); } catch { return; }
  if (Date.now() - lastTrim < 60000) return; lastTrim = Date.now();
  try {
    const files = []; let total = 0;
    for (const name of await fsp.readdir(CACHE)) { if (!name.endsWith('.wav')) continue; const stat = await fsp.stat(path.join(CACHE, name)); files.push({ name, mtime: stat.mtimeMs, size: stat.size }); total += stat.size; }
    if (total <= CACHE_MAX) return;
    for (const file of files.sort((a, b) => a.mtime - b.mtime)) { if (total <= CACHE_MAX * 0.9) break; await fsp.rm(path.join(CACHE, file.name), { force: true }); total -= file.size; }
  } catch {}
}
const { chunks } = require('./public/chunks.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Characters per second before any job has run; replaced by measured speed in stats.json.
const DEFAULT_SPEED = voice => voice.startsWith('sopro_') ? 10 : voice === 'kokoro_eu_pt' ? 20 : voice === 'pt_PT-tugao' || voice.startsWith('phoonnx_') ? 100 : 50;
let lastLive = 0; const running = { job: null, cancelled: new Set() };
const sessions = new Map(), attempts = new Map();
// Sessions outlive restarts: they are written to disk (0600) whenever they change.
const SESSIONS = path.join(DATA, 'sessions.json');
try { for (const [id, s] of Object.entries(JSON.parse(fs.readFileSync(SESSIONS, 'utf8')))) if (/^[a-f0-9]{64}$/.test(id) && s.expires > Date.now() && s.apiKey) sessions.set(id, s); } catch {} // sessions without the Kavita api key predate cover support: one fresh login fixes them
let sessionTimer; const saveSessions = () => { clearTimeout(sessionTimer); sessionTimer = setTimeout(() => atomic(SESSIONS, Object.fromEntries(sessions)).catch(() => {}), 500); sessionTimer.unref(); };
const MAX_UPLOAD = 50 * 1024 * 1024;
const error = (status, message) => Object.assign(new Error(message), { status });
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const numeric = value => { if (!/^\d+$/.test(String(value)) || Number(value) < 1) throw error(400, 'Identificador inválido.'); return Number(value); };
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
async function body(req, limit) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw error(413, 'Ficheiro demasiado grande (máximo 50 MB).'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function json(req, limit = 6_000_000) {
  try { return JSON.parse((await body(req, limit)).toString('utf8')); }
  catch (e) { if (e.status) throw e; throw error(400, 'Pedido inválido.'); }
}
async function kavita(route, session, options = {}) {
  const response = await fetch(KAVITA + route, { ...options, headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: 'Bearer ' + session.token } : {}), ...options.headers }, signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw error(response.status === 401 || response.status === 403 ? 401 : 502, response.status === 401 || response.status === 403 ? 'Volta a entrar no Kavita para continuar.' : 'O Kavita não conseguiu responder a este pedido.');
  return response;
}
function auth(req) {
  const match = (req.headers.cookie || '').match(/(?:^|;\s*)lectoria_session=([a-f0-9]{64})(?:;|$)/);
  const session = match && sessions.get(match[1]);
  if (!session || session.expires < Date.now()) throw error(401, 'Entra com a tua conta do Kavita.');
  return session;
}
const userDir = s => path.join(DATA, 'users', hash(s.userId));
async function atomic(file, value) { await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); const temp = file + '.' + crypto.randomUUID(); await fsp.writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await fsp.rename(temp, file); }
function validateDoc(doc) {
  if (!doc || !Array.isArray(doc.sections) || !doc.sections.length || doc.sections.length > 5000 || doc.sections.some(s => typeof s.text !== 'string' || typeof s.title !== 'string') || doc.sections.reduce((n,s) => n+s.text.length,0) > 2_000_000 || !doc.sections.some(s => s.text.trim())) throw error(400, 'Documento vazio ou demasiado extenso.');
  const cover = doc.cover === 'own' ? 'own' : /^https:\/\/\S{1,500}$/.test(String(doc.cover || '')) ? String(doc.cover) : null;
  return { title: String(doc.title || 'Sem título').slice(0,300), sections: doc.sections.map(s => ({ title: s.title.slice(0,200), text: s.text })), source: String(doc.source || 'Documento').slice(0,100), ...(cover ? { cover } : {}) };
}
async function saveDoc(s, doc) {
  doc = validateDoc(doc);
  const id = hash(JSON.stringify(doc)).slice(0,32), dir = userDir(s);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const files = (await fsp.readdir(dir)).filter(x => /^[a-f0-9]{32}\.json$/.test(x));
  if (files.length >= 80 && !files.includes(id+'.json')) throw error(409, 'A tua estante tem 80 documentos. Remove alguns para continuar.');
  const full = { ...doc, id, updated: new Date().toISOString() }; await atomic(path.join(dir,id+'.json'), full); return full;
}
async function boundedResponse(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) throw error(413, 'Livro demasiado grande (máximo 50 MB).');
  let size = 0; const chunks = [];
  for await (const chunk of response.body) { size += chunk.length; if (size > limit) {  throw error(413, 'Livro demasiado grande (máximo 50 MB).'); } chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
async function extract(buffer, name) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(),'lectoria-')); const file = path.join(dir, 'document');
  try {
    await fsp.writeFile(file, buffer, { mode: 0o600 });
    return await new Promise((resolve,reject) => {
      const child = spawn('python3', [path.join(__dirname,'extract.py'),file,name], { stdio: ['ignore','pipe','ignore'] });
      const parts = []; let size = 0, done = false;
      const timer = setTimeout(()=> { child.kill('SIGKILL'); reject(error(408,'Este documento demorou demasiado tempo a abrir.')); },75000);
      child.stdout.on('data', x => { size += x.length; if (size > 12_000_000) child.kill('SIGKILL'); else parts.push(x); });
      child.on('error',()=> { clearTimeout(timer); reject(error(503,'O conversor de documentos não está disponível.')); });
      child.on('close', code => { clearTimeout(timer); if (done) return; done=true; try { const doc=JSON.parse(Buffer.concat(parts).toString()); if(code || doc.error) throw error(400,doc.error || 'Não foi possível abrir o documento.'); resolve(doc); } catch(e) { reject(e.status ? e : error(400,'Não foi possível abrir o documento.')); } });
    });
  } finally { await fsp.rm(dir, { recursive:true, force:true }); }
}
// Covers (uploaded, or copied from Kavita at import): small images under users/<u>/covers, validated by magic bytes.
const imageType = buf => buf.length>12 && buf[0]===0xff && buf[1]===0xd8 ? 'image/jpeg' : buf.toString('ascii',1,4)==='PNG' ? 'image/png' : buf.toString('ascii',0,4)==='RIFF'&&buf.toString('ascii',8,12)==='WEBP' ? 'image/webp' : null;
const coverFile = (s, name) => path.join(userDir(s), 'covers', name + '.img');
async function storeCover(s, name, buf) { const type=imageType(buf); if(!type) throw error(400,'Usa uma imagem JPEG, PNG ou WebP.'); await fsp.mkdir(path.join(userDir(s),'covers'),{recursive:true,mode:0o700}); const temp=coverFile(s,name)+'.'+crypto.randomUUID(); await fsp.writeFile(temp,buf,{mode:0o600}); await fsp.rename(temp,coverFile(s,name)); return type; }
async function sendCover(res, s, name) { let buf; try { buf=await fsp.readFile(coverFile(s,name)); } catch { throw error(404,'Sem capa.'); } return send(res,200,buf,{'Content-Type':imageType(buf)||'application/octet-stream','Cache-Control':'private, max-age=3600'}); }
async function kavitaCover(session, series) { if(!session.apiKey||!series) return null; try { const r=await fetch(KAVITA+'/api/image/series-cover?seriesId='+numeric(series)+'&apiKey='+encodeURIComponent(session.apiKey),{signal:AbortSignal.timeout(15000)}); if(!r.ok) return null; const buf=await boundedResponse(r,4_000_000); return imageType(buf)?buf:null; } catch { return null; } }
function blogIndex(value) { const i=Number(value); if(!Number.isInteger(i)||i<0||i>=BLOGS.length) throw error(400,'Blogue desconhecido.'); return i; }
async function feedJson(url) {
  let response; try { response=await fetch(url,{signal:AbortSignal.timeout(20000),headers:{Accept:'application/json'}}); } catch { throw error(502,'O blogue não respondeu.'); }
  if(!response.ok) throw error(response.status===404?404:502,response.status===404?'Artigo não encontrado.':'O blogue não respondeu.');
  try { return JSON.parse((await boundedResponse(response,12_000_000)).toString('utf8')); } catch(e) { throw e.status?e:error(502,'O blogue devolveu uma resposta inesperada.'); }
}
// Cover for a post: Blogger's thumbnail (enlarged from 72 px) or the first image in the article; the browser loads it directly.
function postImage(entry) {
  const thumb=entry['media$thumbnail']?.url; const first=String(entry.content?.$t||'').match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
  const url=(thumb||first||'').replace(/&amp;/g,'&'); if(!/^https:\/\//i.test(url)) return null;
  return url.replace(/\/s72(-c)?\//,'/s400/').slice(0,500);
}
const blogTitles=new Map();
async function blogs() {
  return Promise.all(BLOGS.map(async (url,index)=>{
    if(!blogTitles.has(url)) { try { blogTitles.set(url,(await feedJson(url+'/feeds/posts/summary?alt=json&max-results=0')).feed?.title?.$t||new URL(url).hostname); } catch { return {index,url,title:new URL(url).hostname}; } }
    return {index,url,title:blogTitles.get(url)};
  }));
}
const safeName = title => String(title).replace(/[<>:"/\\|?*\x00-\x1f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,120)||'audio';
async function stats() { try { return JSON.parse(await fsp.readFile(STATS,'utf8')); } catch { return {}; } }
const speed = (st,voice) => st[voice]&&st[voice].seconds>=5 ? st[voice].chars/st[voice].seconds : DEFAULT_SPEED(voice);
const jobsDir = s => path.join(userDir(s),'jobs');
async function listJobs(s) {
  const dir=jobsDir(s); await fsp.mkdir(dir,{recursive:true,mode:0o700}); const jobs=[];
  for(const file of (await fsp.readdir(dir)).filter(x=>/^[a-f0-9]{32}\.json$/.test(x))) { try { jobs.push(JSON.parse(await fsp.readFile(path.join(dir,file),'utf8'))); } catch {} }
  return jobs.sort((a,b)=>b.created.localeCompare(a.created));
}
async function createJob(s,input) {
  if(!/^[a-f0-9]{32}$/.test(String(input.doc||''))) throw error(400,'Documento inválido.');
  let doc; try { doc=JSON.parse(await fsp.readFile(path.join(userDir(s),input.doc+'.json'),'utf8')); } catch { throw error(404,'Documento não encontrado.'); }
  const rate=Number(input.rate); if(!(rate>=0.5&&rate<=2)) throw error(400,'Velocidade inválida.');
  let voices; try { voices=(await (await fetch(VOICE+'/api/voice/status',{signal:AbortSignal.timeout(5000)})).json()).voices; } catch { throw error(503,'O motor de voz não está disponível.'); }
  const voice=voices.find(v=>v.id===input.voice); if(!voice) throw error(400,'Voz indisponível.');
  if(!['download','cloud'].includes(input.destination)) throw error(400,'Destino inválido.');
  if(input.destination==='cloud'&&!CLOUD) throw error(400,'Não há pasta de destino configurada neste servidor.');
  let startAt=Date.now(); if(input.startAt!=null) { startAt=Date.parse(input.startAt); if(!Number.isFinite(startAt)||startAt>Date.now()+366*86400000) throw error(400,'Data de início inválida.'); }
  const jobs=await listJobs(s); if(jobs.length>=50) throw error(409,'A fila tem 50 áudios. Remove alguns para continuar.');
  const total={chunks:0,chars:0}; for(const section of doc.sections) for(const c of chunks(section.text)) { total.chunks++; total.chars+=c.length; }
  if(!total.chunks) throw error(400,'O documento não tem texto para ler.');
  const job={id:crypto.randomBytes(16).toString('hex'),user:hash(s.userId),doc:doc.id,title:doc.title,cover:doc.cover==='own'?'./api/documents/'+doc.id+'/cover':doc.cover||null,voice:voice.id,voiceName:voice.name,rate,destination:input.destination,status:'queued',created:new Date().toISOString(),startAt:new Date(startAt).toISOString(),total,done:{chunks:0,chars:0},eta:Math.round(total.chars/speed(await stats(),voice.id))};
  await atomic(path.join(jobsDir(s),job.id+'.json'),job); return job;
}
function pcm(wav) {
  if(wav.length<44||wav.toString('ascii',0,4)!=='RIFF') throw new Error('invalid-audio');
  let offset=12, fmt;
  while(offset+8<=wav.length) {
    const id=wav.toString('ascii',offset,offset+4), size=wav.readUInt32LE(offset+4);
    if(id==='fmt ') fmt={channels:wav.readUInt16LE(offset+10),rate:wav.readUInt32LE(offset+12),bits:wav.readUInt16LE(offset+22)};
    else if(id==='data') { if(!fmt||fmt.bits!==16) throw new Error('invalid-audio'); return {...fmt,data:wav.subarray(offset+8,Math.min(wav.length,offset+8+size))}; }
    offset+=8+size+(size&1);
  }
  throw new Error('invalid-audio');
}
function wavHeader(bytes,rate,channels) { // ponytail: plain RIFF, so a single file tops out at 4 GB (~24 h at 24 kHz mono); split the book if that ever matters
  const h=Buffer.alloc(44); h.write('RIFF',0); h.writeUInt32LE(36+bytes,4); h.write('WAVE',8); h.write('fmt ',12); h.writeUInt32LE(16,16); h.writeUInt16LE(1,20); h.writeUInt16LE(channels,22); h.writeUInt32LE(rate,24); h.writeUInt32LE(rate*channels*2,28); h.writeUInt16LE(channels*2,32); h.writeUInt16LE(16,34); h.write('data',36); h.writeUInt32LE(bytes,40); return h;
}
async function synthesizeChunk(text,voice,rate,key) {
  const cached=await readCache(voiceKey(text,voice,rate)); if(cached)return pcm(cached);
  for(let attempt=0;;attempt++) {
    try {
      const response=await fetch(VOICE+'/api/voice',{method:'POST',headers:{'Content-Type':'application/json','X-Voice-Bridge':key},body:JSON.stringify({text,voice,rate}),signal:AbortSignal.timeout(300000)});
      if(response.status===429) { await sleep(3000); continue; }
      if(!response.ok) throw new Error('synthesis-failed');
      const wav=await boundedResponse(response,20_000_000); writeCache(voiceKey(text,voice,rate),wav); return pcm(wav);
    } catch(e) { if(attempt>=3) throw e; await sleep(5000); }
  }
}
async function runJob(job,file) {
  const dir=path.dirname(file), base=path.join(dir,job.id), key=(await fsp.readFile(KEY,'utf8')).trim();
  let doc; try { doc=JSON.parse(await fsp.readFile(path.join(dir,'..',job.doc+'.json'),'utf8')); } catch { throw new Error('O documento já não está na estante.'); }
  await fsp.rm(base+'.pcm',{force:true}); const out=fs.createWriteStream(base+'.pcm',{mode:0o600});
  const write=buffer=>new Promise((resolve,reject)=>out.write(buffer,e=>e?reject(e):resolve()));
  let rate=0,channels=1,bytes=0; const st=await stats(); job.chapters=[];
  try {
    for(const section of doc.sections) {
      job.chapters.push({title:section.title,seconds:rate?bytes/(rate*channels*2):0});
      for(const text of chunks(section.text)) {
        // Live listening has priority over background jobs: wait while someone is using the player.
        while(Date.now()-lastLive<15000) { if(running.cancelled.has(job.id)) throw new Error('cancelled'); await sleep(3000); }
        if(running.cancelled.has(job.id)) throw new Error('cancelled');
        const started=Date.now(); const audio=await synthesizeChunk(text,job.voice,job.rate,key);
        if(!rate) { rate=audio.rate; channels=audio.channels; } else if(audio.rate!==rate||audio.channels!==channels) throw new Error('synthesis-failed');
        await write(audio.data); await write(Buffer.alloc(Math.round(rate*0.4)*channels*2)); bytes+=audio.data.length+Math.round(rate*0.4)*channels*2;
        const seconds=(Date.now()-started)/1000; st[job.voice]={chars:(st[job.voice]?.chars||0)+text.length,seconds:(st[job.voice]?.seconds||0)+seconds};
        job.done.chunks++; job.done.chars+=text.length; job.eta=Math.round((job.total.chars-job.done.chars)/speed(st,job.voice)); job.speed=speed(st,job.voice);
        await atomic(STATS,st); await atomic(file,job);
      }
      await write(Buffer.alloc(Math.round(rate*0.8)*channels*2)); bytes+=Math.round(rate*0.8)*channels*2;
    }
    await new Promise((resolve,reject)=>out.end(e=>e?reject(e):resolve()));
    await new Promise((resolve,reject)=>{ const wav=fs.createWriteStream(base+'.wav',{mode:0o600}); wav.write(wavHeader(bytes,rate,channels)); fs.createReadStream(base+'.pcm').pipe(wav).on('finish',resolve).on('error',reject); });
    await fsp.rm(base+'.pcm',{force:true}); job.file=job.id+'.wav';
    if(PYTHON) {
      // Tags and cover art for the MP3: the document's own cover file, or the blog image fetched once.
      let coverPath=''; try { let image=null; if(doc.cover==='own') image=await fsp.readFile(path.join(dir,'..','covers',doc.id+'.img')); else if(/^https:\/\//.test(doc.cover||'')) { const r=await fetch(doc.cover,{signal:AbortSignal.timeout(15000)}); if(r.ok) image=await boundedResponse(r,4_000_000); } if(image&&imageType(image)) { coverPath=base+'.cover'; await fsp.writeFile(coverPath,image,{mode:0o600}); } } catch {}
      const ok=await new Promise(resolve=>{ const child=spawn(PYTHON,[path.join(__dirname,'tomp3.py'),base+'.wav',base+'.mp3',job.title,'Lectoria · '+job.voiceName.split(' · ')[0],doc.source||'Lectoria',coverPath],{stdio:'ignore'}); child.on('error',()=>resolve(false)); child.on('close',code=>resolve(code===0)); });
      if(coverPath)await fsp.rm(coverPath,{force:true});
      if(ok) { await fsp.rm(base+'.wav',{force:true}); job.file=job.id+'.mp3'; } else await fsp.rm(base+'.mp3',{force:true}); }
    job.seconds=Math.round(bytes/(rate*channels*2));
    if(job.destination==='cloud') { await fsp.mkdir(CLOUD,{recursive:true}); const target=path.join(CLOUD,safeName(job.title)+' · '+safeName(job.voiceName.split(' · ')[0])+path.extname(job.file)); await fsp.copyFile(path.join(dir,job.file),target); job.cloudPath=target; }
    job.status='done'; job.finished=new Date().toISOString(); job.eta=0;
  } catch(e) {
    out.destroy(); await fsp.rm(base+'.pcm',{force:true});
    job.status=e.message==='cancelled'?'cancelled':'error'; job.error=e.message==='cancelled'?'':e.message==='synthesis-failed'?'O motor de voz falhou a meio. Tenta novamente.':e.message; job.finished=new Date().toISOString();
  }
  await atomic(file,job);
}
async function tick() {
  if(running.job) return;
  let candidates=[]; const users=path.join(DATA,'users');
  for(const user of await fsp.readdir(users).catch(()=>[])) {
    const dir=path.join(users,user,'jobs');
    for(const name of (await fsp.readdir(dir).catch(()=>[])).filter(x=>/^[a-f0-9]{32}\.json$/.test(x))) {
      try { const job=JSON.parse(await fsp.readFile(path.join(dir,name),'utf8')); if(['queued','running'].includes(job.status)&&Date.parse(job.startAt)<=Date.now()) candidates.push({job,file:path.join(dir,name)}); } catch {}
    }
  }
  candidates.sort((a,b)=>a.job.startAt.localeCompare(b.job.startAt)||a.job.created.localeCompare(b.job.created));
  if(!candidates.length) return;
  const {job,file}=candidates[0]; running.job=job;
  try { job.status='running'; job.started=job.started||new Date().toISOString(); await atomic(file,job); await runJob(job,file); } catch {} finally { running.job=null; running.cancelled.delete(job.id); }
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host; try { host=new URL(origin).host; } catch { throw error(403,'Origem inválida.'); }
  if (host !== req.headers.host) throw error(403,'Origem inválida.');
}
async function handle(req,res) {
  try {
    const url = new URL(req.url,'http://localhost');
    let route = url.pathname.replace(/^\/lectoria(?=\/|$)/,'') || '/';
    if (!['GET','HEAD'].includes(req.method)) sameOrigin(req);
    if (route === '/api/health') return send(res,200,{ok:true,version:'1.1.0'});
    if (route === '/api/login' && req.method === 'POST') {
      const ip=req.socket.remoteAddress; const recent=attempts.get(ip)||{count:0,until:Date.now()+60000};
      if (recent.until < Date.now()) { recent.count=0;recent.until=Date.now()+60000; }
      if (++recent.count > 30) throw error(429,'Demasiadas tentativas. Aguarda um minuto.'); attempts.set(ip,recent);
      const input=await json(req,4000);
      if (typeof input.apiKey !== 'string' && (typeof input.username !== 'string' || typeof input.password !== 'string')) throw error(400,'Preenche os dados de acesso.');
      const result=await (await (input.apiKey ? kavita('/api/Plugin/authenticate?apiKey='+encodeURIComponent(input.apiKey)+'&pluginName=Lectoria',null,{method:'POST'}) : kavita('/api/Account/login',null,{method:'POST',body:JSON.stringify({username:input.username,password:input.password})}))).json();
      if (!result.token || result.id == null) throw error(401,'O Kavita não devolveu uma sessão válida.');
      let expires=Date.now()+30*86400000; // the Kavita token itself caps this (14 days)
      try { const jwt=JSON.parse(Buffer.from(result.token.split('.')[1],'base64url')); if(jwt.exp) expires=Math.min(expires,jwt.exp*1000); } catch {}
      if (sessions.size >= 200) throw error(503,'Demasiadas sessões abertas. Tenta mais tarde.');
      const sid=crypto.randomBytes(32).toString('hex'); sessions.set(sid,{userId:result.id,username:result.username,token:result.token,apiKey:typeof result.apiKey==='string'?result.apiKey:'',expires}); saveSessions();
      const secure=req.headers['x-forwarded-proto']==='https' || req.socket.encrypted;
      return send(res,200,{username:result.username},{'Set-Cookie':`lectoria_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.max(1,Math.floor((expires-Date.now())/1000))}${secure?'; Secure':''}`});
    }
    if (route === '/api/logout' && req.method === 'POST') {
      const sid=(req.headers.cookie||'').match(/lectoria_session=([a-f0-9]{64})/)?.[1]; if(sid){sessions.delete(sid);saveSessions();}
      return send(res,200,{ok:true},{'Set-Cookie':'lectoria_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
    }
    if (route.startsWith('/api/')) {
      const session=auth(req);
      if(route==='/api/session' && req.method==='GET')return send(res,200,{username:session.username});
      if(route==='/api/voices' && req.method==='GET')return send(res,200,await(await fetch(VOICE+'/api/voice/status',{signal:AbortSignal.timeout(5000)})).json());
      if(route==='/api/voice/cached' && req.method==='POST') {
        const input=await json(req,400000);if(!Array.isArray(input.texts)||input.texts.length>1000||input.texts.some(t=>typeof t!=='string'))throw error(400,'Pedido inválido.');
        return send(res,200,{cached:await Promise.all(input.texts.map(t=>fsp.access(cacheFile(voiceKey(t,String(input.voice),Number(input.rate)))).then(()=>true,()=>false)))});
      }
      if(route==='/api/voice' && req.method==='POST') {
        const payload=await json(req,16000); const controller=new AbortController(); lastLive=Date.now();
        const cacheId=typeof payload.text==='string'&&typeof payload.voice==='string'?voiceKey(payload.text,payload.voice,Number(payload.rate)):null;
        const cached=cacheId&&await readCache(cacheId); if(cached)return send(res,200,cached,{'Content-Type':'audio/wav','X-Lectoria-Cache':'hit'});
        res.on('close',()=> { if(!res.writableEnded)controller.abort(); });
        const key=(await fsp.readFile(KEY,'utf8')).trim();
        const response=await fetch(VOICE+'/api/voice',{method:'POST',headers:{'Content-Type':'application/json','X-Voice-Bridge':key},body:JSON.stringify(payload),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(120000)])});
        if(!response.ok)return send(res,response.status,{error:response.status===429?'O motor de voz está ocupado. Tenta novamente dentro de instantes.':'Não foi possível gerar o áudio.'},{...(response.status===429?{'Retry-After':'2'}:{})});
        const wav=await boundedResponse(response,20_000_000); if(cacheId)writeCache(cacheId,wav); return send(res,200,wav,{'Content-Type':'audio/wav'});
      }
      if(route==='/api/cover' && req.method==='GET') {
        // Kavita serves cover thumbnails only against the account's apiKey (returned at login), never the bearer token.
        if(!session.apiKey)throw error(404,'Capa indisponível.');
        const series=numeric(url.searchParams.get('series'));
        let upstream;try{upstream=await fetch(KAVITA+'/api/image/series-cover?seriesId='+series+'&apiKey='+encodeURIComponent(session.apiKey),{signal:AbortSignal.timeout(15000)});}catch{throw error(502,'Capa indisponível.');}
        const type=upstream.headers.get('content-type')||'';if(!upstream.ok||!type.startsWith('image/'))throw error(404,'Capa indisponível.');
        return send(res,200,await boundedResponse(upstream,4_000_000),{'Content-Type':type,'Cache-Control':'private, max-age=86400'});
      }
      if(route==='/api/libraries' && req.method==='GET')return send(res,200,await(await kavita('/api/Library/libraries',session)).json());
      if(route==='/api/books' && req.method==='GET') {
        const library=numeric(url.searchParams.get('library'));const page=Math.min(1000,Math.max(1,Number(url.searchParams.get('page'))||1));
        const query=String(url.searchParams.get('q')||'').slice(0,200);
        const statements=[{field:19,comparison:0,value:String(library)}]; if(query)statements.push({field:1,comparison:5,value:query});
        const response=await kavita(`/api/Series/all-v2?PageNumber=${page}&PageSize=48`,session,{method:'POST',body:JSON.stringify({statements,combination:1,sortOptions:{sortField:1,isAscending:true}})});
        return send(res,200,{books:await response.json(),pagination:response.headers.get('pagination')});
      }
      if(route==='/api/chapters' && req.method==='GET') {
        const detail=await(await kavita('/api/Series/series-detail?seriesId='+numeric(url.searchParams.get('series')),session)).json();
        const map=new Map(); for(const c of [...(detail.chapters||[]),...(detail.specials||[]),...(detail.storylineChapters||[]),...(detail.volumes||[]).flatMap(v=>v.chapters||[])])map.set(c.id,{id:c.id,title:c.titleName||c.title||c.range||'Livro',pages:c.pages,format:c.format});
        return send(res,200,[...map.values()]);
      }
      if(route==='/api/import-book' && req.method==='POST') {
        const input=await json(req,2000),chapter=numeric(input.chapter);
        const response=await kavita('/api/Download/chapter?chapterId='+chapter,session);
        const filename=response.headers.get('content-disposition')?.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i)?.[1]||'book.zip';
        const raw=await boundedResponse(response,MAX_UPLOAD);const doc=await extract(raw,decodeURIComponent(filename));
        if(input.title)doc.title=String(input.title).slice(0,300); doc.source='Kavita'; const cover=await kavitaCover(session,input.series); if(cover)doc.cover='own'; const saved=await saveDoc(session,doc); if(cover)await storeCover(session,saved.id,cover); return send(res,200,saved);
      }
      if(route==='/api/upload' && req.method==='POST') {
        const name=String(url.searchParams.get('name')||'').slice(0,300);if(!/\.(epub|pdf|docx|txt|md)$/i.test(name))throw error(400,'Usa EPUB, PDF, DOCX, TXT ou Markdown.');
        const doc=await extract(await body(req,MAX_UPLOAD),name);doc.source='Documento';return send(res,200,await saveDoc(session,doc));
      }
      if(route==='/api/blogs' && req.method==='GET')return send(res,200,await blogs());
      if(route==='/api/blog-posts' && req.method==='GET') {
        const blog=blogIndex(url.searchParams.get('blog'));const page=Math.min(1000,Math.max(1,Number(url.searchParams.get('page'))||1));
        const feed=(await feedJson(BLOGS[blog]+'/feeds/posts/default?alt=json&max-results=24&start-index='+((page-1)*24+1))).feed||{};
        const posts=(feed.entry||[]).map(e=>({id:String(e.id?.$t||'').match(/post-(\d+)$/)?.[1],title:e.title?.$t||'Sem título',published:e.published?.$t||'',url:e.link?.find(l=>l.rel==='alternate')?.href||'',chars:(e.content?.$t||'').replace(/<[^>]+>/g,'').length,image:postImage(e)})).filter(p=>p.id);
        return send(res,200,{title:feed.title?.$t||BLOGS[blog],total:Number(feed['openSearch$totalResults']?.$t)||posts.length,posts});
      }
      if(route==='/api/import-post' && req.method==='POST') {
        const input=await json(req,2000);const blog=blogIndex(input.blog);const post=String(input.post??'');if(!/^\d{1,30}$/.test(post))throw error(400,'Artigo inválido.'); // Blogger ids exceed 2^53, so they stay strings
        const entry=(await feedJson(BLOGS[blog]+'/feeds/posts/default/'+post+'?alt=json')).entry;if(!entry)throw error(404,'Artigo não encontrado.');
        const html='<title>'+String(entry.title?.$t||'Artigo').replace(/</g,'&lt;')+'</title>'+String(entry.content?.$t||'');
        const doc=await extract(Buffer.from(html,'utf8'),'post.html');doc.source=String((await blogs())[blog].title).slice(0,100);const image=postImage(entry);if(image)doc.cover=image;return send(res,200,await saveDoc(session,doc));
      }
      // Queue and playlists: lists of shelf document ids, one JSON file each, shared by every device of the account.
      const ids=list=>{if(!Array.isArray(list)||list.length>500||list.some(x=>!/^[a-f0-9]{32}$/.test(String(x))))throw error(400,'Lista inválida.');return list;};
      const readJson=async(name,fallback)=>{try{return JSON.parse(await fsp.readFile(path.join(userDir(session),name),'utf8'));}catch{return fallback;}};
      // User preferences (voice, engine, cache, appearance): small string map, the same on every device.
      if(route==='/api/settings' && req.method==='GET')return send(res,200,await readJson('settings.json',{}));
      if(route==='/api/settings' && req.method==='PUT'){const input=await json(req,20000);if(!input||typeof input!=='object'||Array.isArray(input))throw error(400,'Definições inválidas.');const current=await readJson('settings.json',{});for(const [k,v] of Object.entries(input)){if(!/^[a-zA-Z_-]{1,40}$/.test(k)||(typeof v!=='string'&&typeof v!=='number'))throw error(400,'Definições inválidas.');current[k]=String(v).slice(0,200);}if(Object.keys(current).length>60)throw error(400,'Demasiadas definições.');await atomic(path.join(userDir(session),'settings.json'),current);return send(res,200,current);}
      if(route==='/api/queue' && req.method==='GET')return send(res,200,{items:await readJson('queue.json',[])});
      if(route==='/api/queue' && req.method==='PUT'){const items=ids((await json(req,60000)).items);await atomic(path.join(userDir(session),'queue.json'),items);return send(res,200,{items});}
      if(route==='/api/playlists' && req.method==='GET')return send(res,200,await readJson('playlists.json',[]));
      if(route==='/api/playlists' && req.method==='POST'){const input=await json(req,60000);const name=String(input.name||'').trim().slice(0,100);if(!name)throw error(400,'Dá um nome à playlist.');const playlists=await readJson('playlists.json',[]);if(playlists.length>=100)throw error(409,'Já tens 100 playlists.');const playlist={id:crypto.randomBytes(16).toString('hex'),name,items:ids(input.items||[]),created:new Date().toISOString()};playlists.push(playlist);await atomic(path.join(userDir(session),'playlists.json'),playlists);return send(res,201,playlist);}
      const playlistMatch=route.match(/^\/api\/playlists\/([a-f0-9]{32})$/);
      if(playlistMatch){const playlists=await readJson('playlists.json',[]);const playlist=playlists.find(p=>p.id===playlistMatch[1]);if(!playlist)throw error(404,'Playlist não encontrada.');
        if(req.method==='PUT'){const input=await json(req,60000);if(input.name!=null){playlist.name=String(input.name).trim().slice(0,100)||playlist.name;}if(input.items!=null)playlist.items=ids(input.items);playlist.updated=new Date().toISOString();await atomic(path.join(userDir(session),'playlists.json'),playlists);return send(res,200,playlist);}
        if(req.method==='DELETE'){await atomic(path.join(userDir(session),'playlists.json'),playlists.filter(p=>p.id!==playlist.id));await fsp.rm(coverFile(session,'playlist-'+playlist.id),{force:true});return send(res,200,{ok:true});}
      }
      if(route==='/api/jobs' && req.method==='GET') {
        const st=await stats();const speeds={};for(const v of Object.keys(st))speeds[v]=speed(st,v);
        return send(res,200,{jobs:await listJobs(session),speeds,defaultSpeed:50,cloud:Boolean(CLOUD),cloudDir:CLOUD});
      }
      if(route==='/api/jobs' && req.method==='POST')return send(res,201,await createJob(session,await json(req,4000)));
      const jobMatch=route.match(/^\/api\/jobs\/([a-f0-9]{32})(\/audio)?$/);
      if(jobMatch) {
        const file=path.join(userDir(session),'jobs',jobMatch[1]+'.json');
        let job;try{job=JSON.parse(await fsp.readFile(file,'utf8'));}catch{throw error(404,'Áudio não encontrado.');}
        if(jobMatch[2] && req.method==='GET') {
          if(job.status!=='done'||!job.file)throw error(409,'Este áudio ainda não está pronto.');
          const audio=path.join(userDir(session),'jobs',job.file);const size=(await fsp.stat(audio)).size;
          res.writeHead(200,{'Content-Type':job.file.endsWith('.mp3')?'audio/mpeg':'audio/wav','Content-Length':size,'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(safeName(job.title)+path.extname(job.file)),'Cache-Control':'no-store'});
          return fs.createReadStream(audio).pipe(res);
        }
        if(!jobMatch[2] && req.method==='DELETE') {
          if(running.job?.id===job.id){running.cancelled.add(job.id);return send(res,200,{ok:true,cancelling:true});}
          for(const name of [jobMatch[1]+'.json',jobMatch[1]+'.pcm',jobMatch[1]+'.wav',jobMatch[1]+'.mp3'])await fsp.rm(path.join(userDir(session),'jobs',name),{force:true});
          return send(res,200,{ok:true});
        }
      }
      if(route==='/api/documents' && req.method==='POST')return send(res,201,await saveDoc(session,await json(req,12_000_000)));
      if(route==='/api/documents' && req.method==='GET') {
        const dir=userDir(session);await fsp.mkdir(dir,{recursive:true,mode:0o700});const docs=[];
        for(const file of (await fsp.readdir(dir)).filter(x=>/^[a-f0-9]{32}\.json$/.test(x))) {const d=JSON.parse(await fsp.readFile(path.join(dir,file),'utf8'));docs.push({id:d.id,title:d.title,source:d.source,updated:d.updated,sections:d.sections.length,cover:d.cover||null});}
        return send(res,200,docs.sort((a,b)=>b.updated.localeCompare(a.updated)));
      }
      const coverMatch=route.match(/^\/api\/(documents|playlists)\/([a-f0-9]{32})\/cover$/);
      if(coverMatch) {
        const [,kind,id]=coverMatch; const name=(kind==='playlists'?'playlist-':'')+id;
        if(req.method==='GET')return await sendCover(res,session,name); // await, so a missing file is caught here instead of crashing the process
        if(req.method==='POST') {
          const buf=await body(req,1_500_000);
          if(kind==='documents'){const file=path.join(userDir(session),id+'.json');let doc;try{doc=JSON.parse(await fsp.readFile(file,'utf8'));}catch{throw error(404,'Documento não encontrado.');}await storeCover(session,name,buf);doc.cover='own';await atomic(file,doc);}
          else{const playlists=await readJson('playlists.json',[]);const playlist=playlists.find(p=>p.id===id);if(!playlist)throw error(404,'Playlist não encontrada.');await storeCover(session,name,buf);playlist.cover='own';await atomic(path.join(userDir(session),'playlists.json'),playlists);}
          return send(res,200,{ok:true});
        }
      }
      const match=route.match(/^\/api\/documents\/([a-f0-9]{32})(\/progress)?$/);
      if(match) {
        const file=path.join(userDir(session),match[1]+(match[2]?'.progress':'')+'.json');
        if(req.method==='GET') { try{return send(res,200,JSON.parse(await fsp.readFile(file,'utf8')));}catch(e){if(match[2]&&e.code==='ENOENT')return send(res,200,{section:0,position:0});throw error(404,'Documento não encontrado.');} }
        if(match[2] && req.method==='PUT') { await fsp.access(path.join(userDir(session),match[1]+'.json')).catch(()=>{throw error(404,'Documento não encontrado.');});const input=await json(req,1000);if(!Number.isInteger(input.section)||input.section<0||!Number.isInteger(input.position)||input.position<0||input.position>2_000_000||input.section>5000)throw error(400,'Posição inválida.');await atomic(file,{section:input.section,position:input.position});return send(res,200,{ok:true}); }
        if(!match[2] && req.method==='DELETE') { await fsp.rm(file,{force:true});await fsp.rm(path.join(userDir(session),match[1]+'.progress.json'),{force:true});await fsp.rm(coverFile(session,match[1]),{force:true});return send(res,200,{ok:true}); }
      }
      return send(res,404,{error:'Pedido não encontrado.'});
    }
    if(!['GET','HEAD'].includes(req.method))return send(res,405,{error:'Método não permitido.'});
    const files={'/':'index.html','/app.js':'app.js','/chunks.js':'chunks.js','/sw.js':'sw.js','/local-worker.js':'local-worker.js','/style.css':'style.css','/icon.svg':'icon.svg','/icon-192.png':'icon-192.png','/icon-512.png':'icon-512.png','/manifest.json':'manifest.json'};
    if(!files[route])return send(res,404,{error:'Página não encontrada.'});
    const data=await fsp.readFile(path.join(__dirname,'public',files[route]));
    const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/manifest+json'};
    return send(res,200,data,{'Content-Type':mime[path.extname(files[route])],'Content-Security-Policy':"default-src 'self'; script-src 'self' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob:; connect-src 'self' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://huggingface.co https://*.hf.co; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"});
  }catch(e){if(!res.destroyed&&!res.writableEnded)send(res,e.status||500,{error:e.status?e.message:'Ocorreu um problema. Tenta novamente.'});}
}
const cleanup=setInterval(()=>{let changed=false;for(const [id,s]of sessions)if(s.expires<Date.now()){sessions.delete(id);changed=true;}if(changed)saveSessions();for(const[ip,a]of attempts)if(a.until<Date.now())attempts.delete(ip);},60000);cleanup.unref();
if(require.main===module) { process.umask(0o077);http.createServer(handle).listen(Number(process.env.PORT)||8104,process.env.HOST||'0.0.0.0',()=>console.log('Lectoria pronta na porta '+(process.env.PORT||8104))); setInterval(()=>tick().catch(()=>{}),10000); }
module.exports={handle,validateDoc,extract,hash,tick,pcm,wavHeader};
