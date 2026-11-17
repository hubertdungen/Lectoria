// Optional backends: the capability sensor, the single-user login and the voice fallback, with each backend off, dead or up.
const {test,after}=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');const {spawn}=require('node:child_process');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const fake=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(req.url==='/api/voice/status'?JSON.stringify({available:true,voices:[{id:'x',name:'X',lang:'pt-PT'}]}):'{}');});
const children=[],dirs=[];let fakeUp;
const ready=new Promise(r=>fake.listen(0,'127.0.0.1',r));
async function run(env){await ready;const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lectoria-cap-'));dirs.push(dir);const port=20000+Math.floor(Math.random()*20000);
  const child=spawn(process.execPath,[path.join(__dirname,'..','server.js')],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1',LECTORIA_DATA:dir,LECTORIA_GOVERNOR:'0',LECTORIA_BLOGS:'',...env},stdio:'ignore'});children.push(child);
  const base='http://127.0.0.1:'+port;for(let i=0;i<50;i++){try{await fetch(base+'/api/health');break;}catch{await new Promise(r=>setTimeout(r,100));}}return base;}
after(()=>{for(const c of children)c.kill();fake.close();for(const d of dirs)fs.rmSync(d,{recursive:true,force:true});});
const up=()=>'http://127.0.0.1:'+fake.address().port,dead='http://127.0.0.1:1';
const J=async(base,route,opt)=>{const r=await fetch(base+route,opt);return {status:r.status,body:await r.json().catch(()=>null),cookie:r.headers.get('set-cookie')};};
async function local(base){const r=await J(base,'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"local":true}'});assert.equal(r.status,200);return r.cookie.split(';')[0];}

test('no Kavita, no voice engine, no blogs: local login, browser voices, nothing breaks',async()=>{
  const base=await run({LECTORIA_KAVITA_URL:'',LECTORIA_VOICE_URL:''});
  const caps=(await J(base,'/api/capabilities')).body;assert.deepEqual([caps.kavita.configured,caps.voice.available,caps.voice.engine,caps.blogs.configured,caps.login],[false,false,'browser',false,'local']);
  const Cookie=await local(base),h={Cookie,'Content-Type':'application/json'};
  assert.equal((await J(base,'/api/session',{headers:{Cookie}})).body.username,'local');
  const voices=(await J(base,'/api/voices',{headers:{Cookie}})).body;assert.equal(voices.available,false);assert.ok(voices.voices.some(v=>v.id==='pt_PT-tugao'));
  const doc=await J(base,'/api/documents',{method:'POST',headers:h,body:JSON.stringify({title:'Sem backends',sections:[{title:'Um',text:'Texto local.'}]})});assert.equal(doc.status,201);
  assert.equal((await J(base,'/api/documents',{headers:{Cookie}})).body.length,1);
  assert.equal((await J(base,'/api/documents/'+doc.body.id+'/progress',{headers:{Cookie}})).status,200);
  assert.equal((await J(base,'/api/documents/'+doc.body.id+'/notes',{headers:{Cookie}})).status,200);
  assert.equal((await J(base,'/api/blogs',{headers:{Cookie}})).body.length,0);
  for(const [route,opt] of [['/api/libraries',{}],['/api/voice',{method:'POST',headers:h,body:'{"text":"a","voice":"x","rate":1}'}],['/api/jobs',{method:'POST',headers:h,body:'{}'}]])assert.equal((await J(base,route,{headers:{Cookie},...opt})).status,503,route);
  assert.equal((await J(base,'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"username":"a","password":"b"}'})).status,503);
});
test('only Kavita configured but down: shown as unavailable, and never a way around its login',async()=>{
  const base=await run({LECTORIA_KAVITA_URL:dead,LECTORIA_VOICE_URL:''});
  const caps=(await J(base,'/api/capabilities')).body;assert.deepEqual([caps.kavita.configured,caps.kavita.available,caps.login],[true,false,'kavita']);
  assert.equal((await J(base,'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"local":true}'})).status,403);
  assert.equal((await J(base,'/api/documents')).status,401);
});
test('only the voice engine up (Kavita off): host voices, local login',async()=>{
  const base=await run({LECTORIA_KAVITA_URL:'',LECTORIA_VOICE_URL:up()});
  const caps=(await J(base,'/api/capabilities')).body;assert.deepEqual([caps.kavita.configured,caps.voice.available,caps.voice.engine,caps.login],[false,true,'host','local']);
  assert.equal((await J(base,'/api/voices',{headers:{Cookie:await local(base)}})).body.voices[0].id,'x');
});
test('voice engine configured but dead: browser voices, no error',async()=>{
  const base=await run({LECTORIA_KAVITA_URL:'',LECTORIA_VOICE_URL:dead});
  const caps=(await J(base,'/api/capabilities')).body;assert.deepEqual([caps.voice.configured,caps.voice.available,caps.voice.engine],[true,false,'browser']);
  const v=await J(base,'/api/voices',{headers:{Cookie:await local(base)}});assert.equal(v.status,200);assert.equal(v.body.available,false);
});
test('both up: Kavita login, host voices',async()=>{
  const base=await run({LECTORIA_KAVITA_URL:up(),LECTORIA_VOICE_URL:up(),LECTORIA_BLOGS:'https://example.blogspot.com'});
  const caps=(await J(base,'/api/capabilities')).body;assert.deepEqual([caps.kavita.available,caps.voice.available,caps.blogs.configured,caps.login],[true,true,true,'kavita']);
});
