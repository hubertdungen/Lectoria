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
const EXPORTS = process.env.LECTORIA_EXPORT_DIR || ''; // Word exports saved on the server (shared folder)
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
const DEFAULT_SPEED = voice => voice.startsWith('sopro_') ? 10 : voice === 'kokoro_eu_pt' ? 20 : voice.startsWith('pt_PT-') || voice.startsWith('phoonnx_') ? 100 : 50;
const LIVE_HOLD = Number(process.env.LECTORIA_LIVE_HOLD_MS) || 15000; // quiet time after live listening before a background job goes on
let lastLive = 0; const running = { job: null, cancelled: new Set(), inflight: null, yieldTo: null };
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
  const response = await fetch(KAVITA + route, { ...options, headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: 'Bearer ' + session.token } : {}), ...options.headers }, signal: options.signal || AbortSignal.timeout(120000) });
  if (!response.ok) { const detail = await response.text().catch(() => ''); throw error(response.status === 401 || response.status === 403 ? 401 : 502, response.status === 401 || response.status === 403 ? 'Volta a entrar no Kavita para continuar.' : /input\/output|not found|no such file/i.test(detail) ? 'O Kavita não consegue ler o ficheiro deste livro no disco (erro de disco ou ficheiro em falta). Verifica a montagem do disco de media.' : 'O Kavita não conseguiu responder a este pedido.'); }
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
  const o = doc.origin; const origin = o && o.kind === 'kavita' && /^\d+$/.test(String(o.chapter)) ? { kind: 'kavita', chapter: Number(o.chapter), series: /^\d+$/.test(String(o.series)) ? Number(o.series) : null } : o && o.kind === 'blog' && /^\d{1,30}$/.test(String(o.post)) ? { kind: 'blog', blog: Number(o.blog) || 0, post: String(o.post) } : null;
  const href = h => typeof h === 'string' && /^[^\0\\]{1,300}$/.test(h) && !h.split('/').includes('..') ? { href: h } : {};
  return { title: String(doc.title || 'Sem título').slice(0,300), sections: doc.sections.map(s => ({ title: s.title.slice(0,200), text: s.text, ...(doc.book ? href(s.href) : {}), ...(Number.isInteger(s.page) && s.page >= 0 ? { page: s.page } : {}) })), ...(doc.book === true ? { book: true } : {}), source: String(doc.source || 'Documento').slice(0,100), ...(cover ? { cover } : {}), ...(origin ? { origin } : {}) };
}
async function saveDoc(s, doc) {
  const bookDir = doc && typeof doc.bookDir === 'string' && doc.bookDir.startsWith(os.tmpdir()) ? doc.bookDir : null;
  doc = validateDoc(doc);
  let id = hash(JSON.stringify(doc)).slice(0,32); const dir = userDir(s);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const files = (await fsp.readdir(dir)).filter(x => /^[a-f0-9]{32}\.json$/.test(x));
  // Books and articles still being written: importing the same source again updates the existing document (same id, same place).
  if (doc.origin) for (const file of files) { try { const old = JSON.parse(await fsp.readFile(path.join(dir, file), 'utf8')); if (old.origin && JSON.stringify(old.origin) === JSON.stringify(doc.origin)) { id = old.id; if (!doc.cover && old.cover) doc.cover = old.cover; break; } } catch {} }
  if (files.length >= 80 && !files.includes(id+'.json')) throw error(409, 'A tua estante tem 80 documentos. Remove alguns para continuar.');
  const full = { ...doc, id, updated: new Date().toISOString() }; await atomic(path.join(dir,id+'.json'), full);
  const book = path.join(dir, 'books', id); await fsp.rm(book, { recursive: true, force: true });
  if (bookDir && full.book) { await fsp.mkdir(path.dirname(book), { recursive: true, mode: 0o700 }); await fsp.cp(bookDir, book, { recursive: true }); }
  if (bookDir) await fsp.rm(bookDir, { recursive: true, force: true });
  return full;
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
      const child = spawn('python3', [path.join(__dirname,'extract.py'),file,name,path.join(dir,'book')], { stdio: ['ignore','pipe','ignore'] });
      const parts = []; let size = 0, done = false;
      const timer = setTimeout(()=> { child.kill('SIGKILL'); reject(error(408,'Este documento demorou demasiado tempo a abrir.')); },75000);
      child.stdout.on('data', x => { size += x.length; if (size > 12_000_000) child.kill('SIGKILL'); else parts.push(x); });
      child.on('error',()=> { clearTimeout(timer); reject(error(503,'O conversor de documentos não está disponível.')); });
      child.on('close', code => { clearTimeout(timer); if (done) return; done=true; try { const doc=JSON.parse(Buffer.concat(parts).toString()); if(code || doc.error) throw error(400,doc.error || 'Não foi possível abrir o documento.'); resolve(doc); } catch(e) { reject(e.status ? e : error(400,'Não foi possível abrir o documento.')); } });
    }).then(async doc => { if (doc.book) { doc.bookDir = await fsp.mkdtemp(path.join(os.tmpdir(),'lectoria-book-')); await fsp.cp(path.join(dir,'book'), doc.bookDir, { recursive:true }); } return doc; });
  } finally { await fsp.rm(dir, { recursive:true, force:true }); }
}
// Reading position shared with Kavita: a section is a Kavita page (`page`, its spine index), a paragraph is the
// block Kavita stores as bookScrollId (an xpath inside that page). Positions travel by paragraph start.
function anchors(session, doc, section) {
  const s = doc.sections[section]; if (!doc.book || !s?.href) return Promise.resolve([]);
  return new Promise(resolve => { const child = spawn('python3', [path.join(__dirname,'extract.py'),'--anchors',path.join(userDir(session),'books',doc.id,...s.href.split('/'))], { stdio: ['ignore','pipe','ignore'] }); const parts = []; child.stdout.on('data', x => parts.push(x)); child.on('error', () => resolve([])); child.on('close', () => { try { resolve(JSON.parse(Buffer.concat(parts))); } catch { resolve([]); } }); });
}
const anchorCache = new Map(); // doc+section+version → anchors promise (one python run per chapter)
function anchorsCached(session, doc, section) { const k = doc.id + ':' + section + ':' + doc.updated; if (!anchorCache.has(k)) { if (anchorCache.size > 60) anchorCache.clear(); anchorCache.set(k, anchors(session, doc, section)); } return anchorCache.get(k); }
// The reader counts positions over its passages (chunks.js: trimmed, no paragraph breaks); Kavita mapping works on the section text.
function chunkMap(text) { const out = []; let at = 0, sum = 0; for (const c of chunks(text)) { const i = text.indexOf(c, at), t = i < 0 ? at : i; out.push({ t, c: sum, len: c.length }); at = t + c.length; sum += c.length; } return out; }
function toText(text, pos) { let r = { t: 0, c: 0, len: 0 }; for (const x of chunkMap(text)) if (x.c <= pos) r = x; return r.t + Math.max(0, Math.min(pos - r.c, r.len)); }
function toChunk(text, pos) { let r = { t: 0, c: 0, len: 0 }; for (const x of chunkMap(text)) if (x.t <= pos) r = x; return r.c + Math.max(0, Math.min(pos - r.t, r.len)); }
const anchorKey = s => s.replace(/\s+/g,'').toLowerCase().slice(0,30);
const paraStarts = text => { const out = []; for (let i = 0; i < text.length; i = text.indexOf('\n', i) + 1 || text.length) if (text[i] !== '\n') out.push(i); return out; };
const paraAt = (text, position) => paraStarts(text).filter(p => p <= position).pop() || 0;
function toXpath(list, text, position) {
  const at = paraAt(text, position), want = anchorKey(text.slice(at, at + 200)); if (!want) return null;
  const nth = paraStarts(text).filter(p => p < at && anchorKey(text.slice(p, p + 200)) === want).length;
  const hits = list.filter(a => anchorKey(a.text) && (anchorKey(a.text).startsWith(want) || want.startsWith(anchorKey(a.text))));
  return (hits[nth] || hits[hits.length - 1])?.xpath || null;
}
function fromXpath(list, text, xpath, selected = '') {
  // Exact block; else the first block inside it (Kavita saved a container); else the block that contains it (a span in a paragraph).
  let i = list.findIndex(a => a.xpath === xpath || a.idpath === xpath); if (i < 0) i = list.findIndex(a => a.xpath.startsWith(xpath + '/') || a.idpath?.startsWith(xpath + '/'));
  if (i < 0) { let best = -1; list.forEach((a, k) => { if ((xpath.startsWith(a.xpath + '/') || (a.idpath && xpath.startsWith(a.idpath + '/'))) && (best < 0 || a.xpath.length > list[best].xpath.length)) best = k; }); i = best; }
  if (i < 0) return findSelected(text, selected, 0);
  const want = anchorKey(list[i].text); const nth = list.slice(0, i).filter(a => anchorKey(a.text) === want).length;
  const starts = paraStarts(text).filter(p => { const k = anchorKey(text.slice(p, p + 200)); return k.startsWith(want) || want.startsWith(k); });
  return findSelected(text, selected, starts[nth] ?? starts[starts.length - 1] ?? 0);
}
// Where a quoted passage starts, at or after `from` (whitespace-tolerant: Kavita joins inline elements without spaces).
function findSelected(text, selected, from) { return matchSelected(text, selected, from)?.index ?? from; }
function matchSelected(text, selected, from) {
  const words = String(selected || '').trim().split(/\s+/).filter(Boolean).slice(0, 12); if (!words.length) return from;
  const re = new RegExp(words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'g'); re.lastIndex = from; return re.exec(text);
}
const kavitaIds = new Map(); // chapter → {volumeId, seriesId, libraryId, pages}
async function chapterIds(session, o) {
  if (!kavitaIds.has(o.chapter)) { const signal = AbortSignal.timeout(8000); const c = await (await kavita('/api/Series/chapter?chapterId=' + o.chapter, session, { signal })).json(); const v = await (await kavita('/api/Series/volume?volumeId=' + c.volumeId, session, { signal })).json(); const s = await (await kavita('/api/Series/' + v.seriesId, session, { signal })).json(); kavitaIds.set(o.chapter, { volumeId: c.volumeId, seriesId: v.seriesId, libraryId: s.libraryId, pages: c.pages }); }
  return kavitaIds.get(o.chapter);
}
// Lectoria → Kavita, once per paragraph. Reaching the last paragraph of the book marks it read (pageNum = pages).
async function pushKavita(session, doc, p, old) {
  const s = doc.sections[p.section]; if (doc.origin?.kind !== 'kavita' || !Number.isInteger(s?.page)) return p;
  const tpos = toText(s.text, p.position), para = paraAt(s.text, tpos); if (old?.kavita && old.kavita.section === p.section && old.kavita.para === para) return { ...p, kavita: old.kavita };
  try {
    const ids = await chapterIds(session, doc.origin), last = p.section === doc.sections.length - 1 && !paraStarts(s.text).some(x => x > para);
    const page = last ? ids.pages : s.page, scroll = last ? null : toXpath(await anchorsCached(session, doc, p.section), s.text, tpos);
    await kavita('/api/Reader/progress', session, { method: 'POST', signal: AbortSignal.timeout(8000), body: JSON.stringify({ volumeId: ids.volumeId, chapterId: doc.origin.chapter, pageNum: page, seriesId: ids.seriesId, libraryId: ids.libraryId, bookScrollId: scroll }) });
    return { ...p, kavita: { section: p.section, para, page, scroll } };
  } catch { return p; } // Kavita away: the next paragraph tries again
}
// Kavita → Lectoria: adopt Kavita's position when it was saved after ours (read in Kavita's own reader or another app).
async function pullKavita(session, doc, file) {
  let local = { section: 0, position: 0 }, mtime = 0; try { mtime = (await fsp.stat(file)).mtimeMs; local = JSON.parse(await fsp.readFile(file, 'utf8')); } catch {}
  if (doc.origin?.kind !== 'kavita' || !doc.sections.some(s => Number.isInteger(s.page))) return local;
  try {
    const k = await (await kavita('/api/Reader/get-progress?chapterId=' + doc.origin.chapter, session, { signal: AbortSignal.timeout(4000) })).json();
    if (!(Date.parse(String(k.lastModifiedUtc).replace(/Z?$/, 'Z')) > mtime) || (local.kavita?.page === k.pageNum && (local.kavita.scroll || null) === (k.bookScrollId || null))) return local;
    let section = 0; doc.sections.forEach((s, i) => { if (s.page <= k.pageNum) section = i; }); const s = doc.sections[section];
    const tpos = s.page === k.pageNum && k.bookScrollId ? fromXpath(await anchorsCached(session, doc, section), s.text, k.bookScrollId) : k.pageNum > s.page && section === doc.sections.length - 1 ? paraAt(s.text, s.text.length) : 0;
    const p = { section, position: toChunk(s.text, tpos), kavita: { section, para: paraAt(s.text, tpos), page: k.pageNum, scroll: k.bookScrollId || null } };
    await atomic(file, p); return p;
  } catch { return local; }
}
// Bookmarks and notes. Books from Kavita keep them in Kavita itself (bookmarks = its personal table of contents,
// notes/highlights = its annotations), so both readers show the same list; other documents keep a local file.
// Positions travel in reader coordinates (passages), like the reading progress.
const kavitaBacked = doc => doc.origin?.kind === 'kavita' && doc.sections.some(s => Number.isInteger(s.page));
const htmlText = h => String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p[^>]*>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
const escHtml = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const quill = comment => comment ? { comment: JSON.stringify({ ops: [{ insert: comment + '\n' }] }), commentHtml: '<p>' + escHtml(comment).replace(/\n/g, '<br>') + '</p>' } : { comment: '{}', commentHtml: '' };
const ptocId = (page, title) => 'p' + page + '-' + Buffer.from(title).toString('base64url');
async function kavitaPlace(session, doc, page, xpath, selected) {
  let section = -1; doc.sections.forEach((s, i) => { if (Number.isInteger(s.page) && s.page <= page) section = i; }); if (section < 0) return { section: 0, position: 0 };
  const s = doc.sections[section]; if (s.page !== page) return { section, position: 0 };
  const t = xpath ? fromXpath(await anchorsCached(session, doc, section), s.text, xpath, selected) : findSelected(s.text, selected, 0);
  return { section, position: toChunk(s.text, t) };
}
async function listNotes(session, doc) {
  if (!kavitaBacked(doc)) return JSON.parse(await fsp.readFile(path.join(userDir(session), doc.id + '.notes.json'), 'utf8').catch(() => '[]'));
  const ch = doc.origin.chapter, opt = () => ({ signal: AbortSignal.timeout(8000) });
  const [anns, ptoc] = await Promise.all([kavita('/api/annotation/all?chapterId=' + ch, session, opt()).then(r => r.json()), kavita('/api/reader/ptoc?chapterId=' + ch, session, opt()).then(r => r.json())]);
  const notes = [];
  for (const a of anns) notes.push({ id: 'a' + a.id, kind: 'note', ...await kavitaPlace(session, doc, a.pageNumber, a.xPath, a.selectedText), text: a.selectedText || '', comment: a.commentPlainText || htmlText(a.commentHtml), color: Math.max(0, Math.min(4, a.selectedSlotIndex || 0)), owner: a.ownerUsername || '', mine: String(a.ownerUserId) === String(session.userId), at: a.createdUtc || null });
  for (const b of ptoc) notes.push({ id: ptocId(b.pageNumber, b.title), kind: 'bookmark', ...await kavitaPlace(session, doc, b.pageNumber, b.bookScrollId, b.selectedText), text: b.selectedText || '', comment: b.title || '', color: 0, mine: true, at: null });
  return notes;
}
function validNote(doc, input) {
  const n = { kind: input.kind === 'bookmark' ? 'bookmark' : 'note', section: input.section, position: input.position, text: String(input.text || '').slice(0, 2000), comment: String(input.comment || '').slice(0, 10000), color: Number.isInteger(input.color) && input.color >= 0 && input.color <= 4 ? input.color : 0 };
  if (!Number.isInteger(n.section) || !doc.sections[n.section] || !Number.isInteger(n.position) || n.position < 0) throw error(400, 'Posição inválida.');
  return n;
}
async function addNote(session, doc, n) {
  if (!kavitaBacked(doc)) { const file = path.join(userDir(session), doc.id + '.notes.json'); const notes = await listNotes(session, doc); const note = { id: crypto.randomBytes(8).toString('hex'), ...n, mine: true, at: new Date().toISOString() }; notes.push(note); await atomic(file, notes); return note; }
  const s = doc.sections[n.section]; if (!Number.isInteger(s.page)) throw error(400, 'Este capítulo não existe no Kavita.');
  const ids = await chapterIds(session, doc.origin), tpos = toText(s.text, n.position), para = paraAt(s.text, tpos);
  const xpath = toXpath(await anchorsCached(session, doc, n.section), s.text, tpos) || '//body';
  const common = { libraryId: ids.libraryId, seriesId: ids.seriesId, volumeId: ids.volumeId, chapterId: doc.origin.chapter };
  if (n.kind === 'bookmark') {
    const title = (n.comment || n.text || s.text.slice(para, para + 80)).replace(/\s+/g, ' ').trim().slice(0, 100) || s.title;
    await kavita('/api/reader/create-ptoc', session, { method: 'POST', signal: AbortSignal.timeout(8000), body: JSON.stringify({ ...common, pageNumber: s.page, title, bookScrollId: xpath, selectedText: n.text || '' }) });
    return { id: ptocId(s.page, title), ...n, comment: title, mine: true, at: null };
  }
  const paragraph = s.text.slice(para, (s.text.indexOf('\n', para) + 1 || s.text.length + 1) - 1);
  const a = await (await kavita('/api/annotation/create', session, { method: 'POST', signal: AbortSignal.timeout(8000), body: JSON.stringify({ id: 0, xPath: xpath, endingXPath: xpath, selectedText: n.text, ...quill(n.comment), containsSpoiler: false, pageNumber: s.page, selectedSlotIndex: n.color, chapterTitle: s.title, highlightCount: n.text.length, ownerUserId: 0, ownerUsername: '', createdUtc: '0001-01-01T00:00:00Z', lastModifiedUtc: '0001-01-01T00:00:00Z', context: paragraph.slice(0, 1000), ...common }) })).json();
  return { id: 'a' + a.id, ...n, mine: true, at: a.createdUtc || null };
}
async function editNote(session, doc, id, input) {
  const comment = String(input.comment || '').slice(0, 10000), color = Number.isInteger(input.color) && input.color >= 0 && input.color <= 4 ? input.color : null;
  if (!kavitaBacked(doc)) { const file = path.join(userDir(session), doc.id + '.notes.json'); const notes = await listNotes(session, doc); const note = notes.find(x => x.id === id); if (!note) throw error(404, 'Nota não encontrada.'); note.comment = comment; if (color !== null) note.color = color; await atomic(file, notes); return note; }
  if (!/^a\d+$/.test(id)) throw error(400, 'Os marcadores do Kavita não se editam: apaga e cria outro.');
  const a = await (await kavita('/api/annotation/' + id.slice(1), session, { signal: AbortSignal.timeout(8000) })).json();
  if (String(a.ownerUserId) !== String(session.userId)) throw error(403, 'Esta nota é de outra pessoa.');
  await kavita('/api/annotation/update', session, { method: 'POST', signal: AbortSignal.timeout(8000), body: JSON.stringify({ ...a, ...quill(comment), ...(color !== null ? { selectedSlotIndex: color } : {}) }) });
  return { ok: true };
}
async function removeNote(session, doc, id) {
  if (!kavitaBacked(doc)) { const file = path.join(userDir(session), doc.id + '.notes.json'); const notes = await listNotes(session, doc); await atomic(file, notes.filter(x => x.id !== id)); return; }
  const opt = { method: 'DELETE', signal: AbortSignal.timeout(8000) };
  if (/^a\d+$/.test(id)) return void await kavita('/api/annotation?annotationId=' + id.slice(1), session, opt);
  const m = id.match(/^p(\d+)-([A-Za-z0-9_-]*)$/); if (!m) throw error(400, 'Nota inválida.');
  await kavita('/api/reader/ptoc?chapterId=' + doc.origin.chapter + '&pageNum=' + m[1] + '&title=' + encodeURIComponent(Buffer.from(m[2], 'base64url').toString()), session, opt);
}
// Word export (export_docx.py): the text with bookmarks as Word bookmarks, notes as comments, highlights in their colour.
async function highlightColors(session) {
  try { const p = await (await kavita('/api/users/get-preferences', session, { signal: AbortSignal.timeout(5000) })).json(); const slots = (p.bookReaderHighlightSlots || []).slice().sort((a, b) => a.slotNumber - b.slotNumber).map(x => x.color).filter(c => c && [c.r, c.g, c.b].every(Number.isFinite)).slice(0, 5); if (slots.length === 5) return slots.map(c => ({ r: c.r, g: c.g, b: c.b, a: Number.isFinite(c.a) ? c.a : 0.4 })); } catch {}
  return [[242, 214, 92], [143, 209, 158], [127, 179, 240], [242, 155, 192], [245, 167, 108]].map(([r, g, b]) => ({ r, g, b, a: 0.45 }));
}
async function exportDocx(session, doc) {
  const [notes, colors] = await Promise.all([listNotes(session, doc).catch(() => []), highlightColors(session)]);
  const marks = notes.map(n => { const s = doc.sections[n.section]; if (!s) return null; let start = toText(s.text, n.position), end = start;
    if (n.kind === 'note' && n.text) { const m = matchSelected(s.text, n.text, Math.max(0, start - 5)); if (m && m.index - start < 300) { start = m.index; end = m.index + m[0].length; } else end = start + n.text.length; }
    const para = paraAt(s.text, start), c = colors[n.color || 0] || colors[0];
    return { kind: n.kind, section: n.section, start, end, comment: n.kind === 'note' ? n.comment || '' : '', color: [c.r, c.g, c.b], label: n.kind === 'bookmark' ? (n.comment || n.text || s.text.slice(para, para + 80)).replace(/\s+/g, ' ').trim().slice(0, 120) : '', author: n.owner || session.username }; }).filter(Boolean);
  const input = JSON.stringify({ title: doc.title, subtitle: [doc.source, 'Exportado do Lectoria a ' + new Date().toLocaleDateString('pt-PT')].filter(Boolean).join(' · '), author: session.username, sections: doc.sections.map(s => ({ title: s.title, text: s.text })), marks });
  return await new Promise((resolve, reject) => { const child = spawn('python3', [path.join(__dirname, 'export_docx.py')], { stdio: ['pipe', 'pipe', 'ignore'] }); const parts = []; child.stdout.on('data', x => parts.push(x)); child.on('error', () => reject(error(503, 'O exportador para Word não está disponível.'))); child.on('close', code => code ? reject(error(500, 'Não foi possível criar o ficheiro Word.')) : resolve(Buffer.concat(parts))); child.stdin.end(input); });
}
const exportName = doc => String(doc.title || 'Documento').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').trim().slice(0, 120) + ' (Lectoria).docx';
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
// Partial recording: how many passages of a document already sit in the disk cache for a voice and speed.
// Characters of a document still to be made with a voice and speed (the rest is in the passage cache): what an estimate should count.
async function uncached(doc,voice,rate){let chars=0,total=0;for(const section of doc.sections)for(const text of chunks(section.text)){total+=text.length;if(!await fsp.access(cacheFile(voiceKey(text,voice,rate))).then(()=>true,()=>false))chars+=text.length;}return {chars,total};}
async function coverage(doc,voice,rate){let done=0,total=0;for(const section of doc.sections)for(const text of chunks(section.text)){total++;if(await fsp.access(cacheFile(voiceKey(text,voice,rate))).then(()=>true,()=>false))done++;}return {done,total};}
async function autoCompile(s,docId,voice,rate){
  try{
    const settings=JSON.parse(await fsp.readFile(path.join(userDir(s),'settings.json'),'utf8').catch(()=>'{}'));if(settings.partialRecording!=='1')return;
    const doc=JSON.parse(await fsp.readFile(path.join(userDir(s),docId+'.json'),'utf8'));const c=await coverage(doc,voice,rate);if(c.done<c.total)return;
    if((await listJobs(s)).some(j=>j.doc===docId&&j.voice===voice&&j.rate===rate&&['queued','running','done'].includes(j.status)))return;
    await createJob(s,{doc:docId,voice,rate,destination:settings.cloudCopy==='1'&&CLOUD?'cloud':'download'});
  }catch{}
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
  const twin=jobs.find(j=>j.title.trim().toLowerCase()===doc.title.trim().toLowerCase()&&j.voice===voice.id&&j.rate===rate&&['queued','running','cancelling','done'].includes(j.status)); if(twin&&!input.force) throw error(409,twin.status==='done'?'Já existe este áudio com esta voz e velocidade. Remove-o em Áudios se quiseres gerar outro.':'Este áudio já está na fila com esta voz e velocidade.');
  const total={chunks:0,chars:0}; for(const section of doc.sections) for(const c of chunks(section.text)) { total.chunks++; total.chars+=c.length; }
  if(!total.chunks) throw error(400,'O documento não tem texto para ler.');
  const job={id:crypto.randomBytes(16).toString('hex'),user:hash(s.userId),doc:doc.id,title:doc.title,cover:doc.cover==='own'?'./api/documents/'+doc.id+'/cover':doc.cover||null,voice:voice.id,voiceName:voice.name,rate,destination:input.destination,status:'queued',created:new Date().toISOString(),startAt:new Date(startAt).toISOString(),total,done:{chunks:0,chars:0},todo:(await uncached(doc,voice.id,rate)).chars,eta:Math.round((await uncached(doc,voice.id,rate)).chars/speed(await stats(),voice.id)),...(input.auto?{auto:true}:{})};
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
async function synthesizeChunk(text,voice,rate,key,signal) {
  const cached=await readCache(voiceKey(text,voice,rate)); if(cached)return {...pcm(cached),cached:true};
  for(let attempt=0;;attempt++) {
    try {
      const response=await fetch(VOICE+'/api/voice',{method:'POST',headers:{'Content-Type':'application/json','X-Voice-Bridge':key},body:JSON.stringify({text,voice,rate}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(300000)]):AbortSignal.timeout(300000)});
      if(response.status===429) { await sleep(3000); continue; }
      if(!response.ok) throw new Error('synthesis-failed');
      const wav=await boundedResponse(response,20_000_000); writeCache(voiceKey(text,voice,rate),wav); return pcm(wav);
    } catch(e) { if(signal?.aborted||attempt>=3) throw e; await sleep(5000); }
  }
}
// A job passage that live listening interrupted is simply made again once the player is quiet.
async function jobChunk(job,text,key) {
  for(;;) {
    while(Date.now()-lastLive<LIVE_HOLD) { if(running.cancelled.has(job.id)) throw new Error('cancelled'); await sleep(Math.min(3000,LIVE_HOLD)); }
    if(running.cancelled.has(job.id)) throw new Error('cancelled');
    const controller=new AbortController(); running.inflight=controller;
    try { const t=Date.now(), audio=await synthesizeChunk(text,job.voice,job.rate,key,controller.signal); return {...audio,seconds:(Date.now()-t)/1000}; }
    catch(e) { if(!controller.signal.aborted) throw e; }
    finally { running.inflight=null; }
  }
}
async function runJob(job,file) {
  const dir=path.dirname(file), base=path.join(dir,job.id), key=(await fsp.readFile(KEY,'utf8')).trim();
  let doc; try { doc=JSON.parse(await fsp.readFile(path.join(dir,'..',job.doc+'.json'),'utf8')); } catch { throw new Error('O documento já não está na estante.'); }
  job.todo=(await uncached(doc,job.voice,job.rate)).chars;
  job.total={chunks:0,chars:0}; for(const section of doc.sections) for(const c of chunks(section.text)) { job.total.chunks++; job.total.chars+=c.length; } // the book may have changed since the job was queued
  await fsp.rm(base+'.pcm',{force:true}); const out=fs.createWriteStream(base+'.pcm',{mode:0o600});
  const write=buffer=>new Promise((resolve,reject)=>out.write(buffer,e=>e?reject(e):resolve()));
  let rate=0,channels=1,bytes=0; const st=await stats(); job.chapters=[];
  try {
    for(const section of doc.sections) {
      job.chapters.push({title:section.title,seconds:rate?bytes/(rate*channels*2):0});
      for(const text of chunks(section.text)) {
        // Live listening has priority over background jobs (jobChunk waits, and a live request interrupts it);
        // a job given priority takes the engine at the next passage — what is done stays in the cache.
        if(running.yieldTo&&running.yieldTo!==job.id) throw new Error('yield');
        const audio=await jobChunk(job,text,key);
        if(!rate) { rate=audio.rate; channels=audio.channels; } else if(audio.rate!==rate||audio.channels!==channels) throw new Error('synthesis-failed');
        await write(audio.data); await write(Buffer.alloc(Math.round(rate*0.4)*channels*2)); bytes+=audio.data.length+Math.round(rate*0.4)*channels*2;
        // Only passages the engine really made count for the measured speed and for what is left (cache hits take no time).
        if(!audio.cached) { st[job.voice]={chars:(st[job.voice]?.chars||0)+text.length,seconds:(st[job.voice]?.seconds||0)+audio.seconds}; job.todo=Math.max(0,(job.todo||0)-text.length); }
        job.done.chunks++; job.done.chars+=text.length; job.eta=Math.round((job.todo||0)/speed(st,job.voice)); job.speed=speed(st,job.voice);
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
    if(job.auto) for(const name of (await fsp.readdir(dir)).filter(x=>/^[a-f0-9]{32}\.json$/.test(x)&&x!==job.id+'.json')) { try { const old=JSON.parse(await fsp.readFile(path.join(dir,name),'utf8')); if(old.doc===job.doc&&old.voice===job.voice&&old.rate===job.rate&&old.status==='done') for(const ext of ['.json','.wav','.mp3']) await fsp.rm(path.join(dir,old.id+ext),{force:true}); } catch {} }
  } catch(e) {
    out.destroy(); await fsp.rm(base+'.pcm',{force:true});
    if(e.message==='yield') { job.status='queued'; job.done={chunks:0,chars:0}; await atomic(file,job); return; }
    job.status=e.message==='cancelled'||job.status==='cancelling'?'cancelled':'error'; job.error=e.message==='cancelled'?'':e.message==='synthesis-failed'?'O motor de voz falhou a meio. Tenta novamente.':e.message; job.finished=new Date().toISOString();
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
  candidates.sort((a,b)=>(b.job.priority||0)-(a.job.priority||0)||a.job.startAt.localeCompare(b.job.startAt)||a.job.created.localeCompare(b.job.created));
  if(!candidates.length) return;
  const {job,file}=candidates[0]; running.job=job; if(running.yieldTo===job.id) running.yieldTo=null;
  try { job.status='running'; job.started=job.started||new Date().toISOString(); job.done={chunks:0,chars:0}; /* a job resumed after a restart starts over; finished passages come from the cache */ await atomic(file,job); await runJob(job,file); } catch {} finally { running.job=null; running.cancelled.delete(job.id); }
}
async function importKavita(session,chapter,series,title) {
  const response=await kavita('/api/Download/chapter?chapterId='+chapter,session);
  const filename=response.headers.get('content-disposition')?.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i)?.[1]||'book.zip';
  const raw=await boundedResponse(response,MAX_UPLOAD);const doc=await extract(raw,decodeURIComponent(filename));kavitaIds.delete(chapter);
  if(title)doc.title=String(title).slice(0,300); doc.source='Kavita'; doc.origin={kind:'kavita',chapter,series}; const cover=await kavitaCover(session,series); if(cover)doc.cover='own'; const saved=await saveDoc(session,doc); if(cover)await storeCover(session,saved.id,cover); return saved;
}
async function importPost(session,blog,post,entry) {
  entry=entry||(await feedJson(BLOGS[blog]+'/feeds/posts/default/'+post+'?alt=json')).entry;if(!entry)throw error(404,'Artigo não encontrado.');
  const html='<title>'+String(entry.title?.$t||'Artigo').replace(/</g,'&lt;')+'</title>'+String(entry.content?.$t||'');
  const doc=await extract(Buffer.from(html,'utf8'),'post.html');doc.source=String((await blogs())[blog].title).slice(0,100);doc.origin={kind:'blog',blog,post};const image=postImage(entry);if(image)doc.cover=image;return saveDoc(session,doc);
}
// Next start for automatic audio: the user's chosen hour (server local time), or right away.
function nextAt(hour){const h=Number(hour);if(hour===''||hour==null||!(h>=0&&h<=23))return new Date();const d=new Date();d.setMinutes(0,0,0);d.setHours(h);if(d<=new Date())d.setDate(d.getDate()+1);return d;}
// Background sync, per account with a live session (it needs the Kavita token): every `syncEvery` hours re-import
// shelf items whose source changed; then make sure every item marked for automatic audio has a current full audio.
async function autoSync() {
  const users=new Map(); for(const s of sessions.values()) if(s.expires>Date.now()&&(!users.has(s.userId)||users.get(s.userId).expires<s.expires)) users.set(s.userId,s); // ponytail: an account with no session for 14 days is not synced until it logs in again
  for(const s of users.values()) {
    const dir=userDir(s); const read=async(n,f)=>{try{return JSON.parse(await fsp.readFile(path.join(dir,n),'utf8'));}catch{return f;}};
    const settings=await read('settings.json',{}); const every=Number(settings.syncEvery??1)||0; const sync=await read('sync.json',{});
    const docs=[]; for(const f of (await fsp.readdir(dir).catch(()=>[])).filter(x=>/^[a-f0-9]{32}\.json$/.test(x))) { try{docs.push(JSON.parse(await fsp.readFile(path.join(dir,f),'utf8')));}catch{} }
    if(every>0&&Date.now()-(Date.parse(sync.last)||0)>=every*3600000) {
      const updated=[];
      for(const d of docs.filter(d=>d.origin)) {
        try {
          if(d.origin.kind==='kavita') { const c=await(await kavita('/api/Series/chapter?chapterId='+d.origin.chapter,s)).json(); if(c.lastModifiedUtc&&Date.parse(c.lastModifiedUtc.replace(/Z?$/,'Z'))>Date.parse(d.updated)) { await importKavita(s,d.origin.chapter,d.origin.series,d.title); updated.push(d.title); } }
          else if(BLOGS[d.origin.blog]) { const entry=(await feedJson(BLOGS[d.origin.blog]+'/feeds/posts/default/'+d.origin.post+'?alt=json')).entry; if(entry&&Date.parse(entry.updated?.$t)>Date.parse(d.updated)) { await importPost(s,d.origin.blog,d.origin.post,entry); updated.push(d.title); } }
        } catch {}
      }
      await atomic(path.join(dir,'sync.json'),{last:new Date().toISOString(),updated});
      if(updated.length) { docs.length=0; for(const f of (await fsp.readdir(dir)).filter(x=>/^[a-f0-9]{32}\.json$/.test(x))) { try{docs.push(JSON.parse(await fsp.readFile(path.join(dir,f),'utf8')));}catch{} } }
    }
    const auto=await read('auto.json',{}); if(!Object.keys(auto).length) continue; const jobs=await listJobs(s);
    for(const d of docs) {
      const a=auto[d.id]; if(!a) continue;
      // A job already covers this version when it is still pending, or was created after the document last changed (done, failed or cancelled: no retry loop).
      if(jobs.some(j=>j.doc===d.id&&j.voice===a.voice&&j.rate===a.rate&&(['queued','running','cancelling'].includes(j.status)||j.created>=d.updated))) continue;
      try { await createJob(s,{doc:d.id,voice:a.voice,rate:a.rate,destination:settings.cloudCopy==='1'&&CLOUD?'cloud':'download',startAt:nextAt(settings.autoHour??'3').toISOString(),force:true,auto:true}); } catch {}
    }
  }
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
        const payload=await json(req,16000); const controller=new AbortController();
        const cacheId=typeof payload.text==='string'&&typeof payload.voice==='string'?voiceKey(payload.text,payload.voice,Number(payload.rate)):null;
        const cached=cacheId&&await readCache(cacheId); if(cached)return send(res,200,cached,{'Content-Type':'audio/wav','X-Lectoria-Cache':'hit'});
        lastLive=Date.now(); // only engine work counts as live use; cache hits never hold a background job back
        if(running.inflight) running.inflight.abort(); // the reader does not wait for a background passage to finish
        res.on('close',()=> { if(!res.writableEnded)controller.abort(); });
        const key=(await fsp.readFile(KEY,'utf8')).trim();
        let response;for(let i=0;;i++){response=await fetch(VOICE+'/api/voice',{method:'POST',headers:{'Content-Type':'application/json','X-Voice-Bridge':key},body:JSON.stringify({text:payload.text,voice:payload.voice,rate:payload.rate}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(120000)])});if(response.status!==429||i>=10)break;await sleep(300);} // the interrupted job releases the engine within moments
        if(!response.ok)return send(res,response.status,{error:response.status===429?'O motor de voz está ocupado. Tenta novamente dentro de instantes.':'Não foi possível gerar o áudio.'},{...(response.status===429?{'Retry-After':'2'}:{})});
        const wav=await boundedResponse(response,20_000_000); if(cacheId)await writeCache(cacheId,wav); if(cacheId&&/^[a-f0-9]{32}$/.test(String(payload.doc||'')))autoCompile(session,payload.doc,payload.voice,Number(payload.rate)); return send(res,200,wav,{'Content-Type':'audio/wav'});
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
        const statements=[{field:19,comparison:0,value:String(library)}]; if(query)statements.push({field:1,comparison:7,value:query});
        const response=await kavita(`/api/Series/all-v2?PageNumber=${page}&PageSize=48`,session,{method:'POST',body:JSON.stringify({statements,combination:1,sortOptions:{sortField:1,isAscending:true}})});
        return send(res,200,{books:await response.json(),pagination:response.headers.get('pagination')});
      }
      if(route==='/api/chapters' && req.method==='GET') {
        const detail=await(await kavita('/api/Series/series-detail?seriesId='+numeric(url.searchParams.get('series')),session)).json();
        const map=new Map(); for(const c of [...(detail.chapters||[]),...(detail.specials||[]),...(detail.storylineChapters||[]),...(detail.volumes||[]).flatMap(v=>v.chapters||[])])map.set(c.id,{id:c.id,title:c.titleName||c.title||c.range||'Livro',pages:c.pages,format:c.format,modified:c.lastModifiedUtc?c.lastModifiedUtc+'Z':c.lastModified||null});
        return send(res,200,[...map.values()]);
      }
      if(route==='/api/import-book' && req.method==='POST') {
        const input=await json(req,2000);return send(res,200,await importKavita(session,numeric(input.chapter),input.series,input.title));
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
        const input=await json(req,2000);const post=String(input.post??'');if(!/^\d{1,30}$/.test(post))throw error(400,'Artigo inválido.'); // Blogger ids exceed 2^53, so they stay strings
        return send(res,200,await importPost(session,blogIndex(input.blog),post));
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
        // ?voice=&rate= adds the partial-recording coverage of every shelf document for that voice.
        const partial={};const voice=url.searchParams.get('voice'),rate=Number(url.searchParams.get('rate'));
        if(voice&&rate){const dir=userDir(session);for(const file of (await fsp.readdir(dir).catch(()=>[])).filter(x=>/^[a-f0-9]{32}\.json$/.test(x))){try{const d=JSON.parse(await fsp.readFile(path.join(dir,file),'utf8'));const c=await coverage(d,voice,rate);if(c.done)partial[d.id]={...c,title:d.title,cover:d.cover||null};}catch{}}}
        const jobs=await listJobs(session);for(const j of jobs)if(j.status==='queued'){try{const d=JSON.parse(await fsp.readFile(path.join(userDir(session),j.doc+'.json'),'utf8'));j.todo=(await uncached(d,j.voice,j.rate)).chars;j.eta=Math.round(j.todo/speed(st,j.voice));}catch{}}
        return send(res,200,{jobs,speeds,defaultSpeed:50,cloud:Boolean(CLOUD),cloudDir:CLOUD,partial});
      }
      if(route==='/api/jobs' && req.method==='POST')return send(res,201,await createJob(session,await json(req,4000)));
      const prioMatch=route.match(/^\/api\/jobs\/([a-f0-9]{32})\/priority$/);
      if(prioMatch&&req.method==='POST') {
        // Front of the queue; "now" also brings a scheduled start forward. A running job yields at its next passage.
        const file=path.join(userDir(session),'jobs',prioMatch[1]+'.json'); let job;try{job=JSON.parse(await fsp.readFile(file,'utf8'));}catch{throw error(404,'Áudio não encontrado.');}
        if(!['queued','running'].includes(job.status)) throw error(409,'Este áudio já não está em fila.');
        const input=await json(req,1000); job.priority=Date.now(); if(input.now&&Date.parse(job.startAt)>Date.now()) job.startAt=new Date().toISOString();
        await atomic(file,job); if(running.job&&running.job.id!==job.id&&Date.parse(job.startAt)<=Date.now()) running.yieldTo=job.id;
        return send(res,200,{ok:true,startAt:job.startAt});
      }
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
          if(running.job?.id===job.id){running.cancelled.add(job.id);running.job.status='cancelling';await atomic(file,running.job).catch(()=>{});return send(res,200,{ok:true,cancelling:true});}
          for(const name of [jobMatch[1]+'.json',jobMatch[1]+'.pcm',jobMatch[1]+'.wav',jobMatch[1]+'.mp3'])await fsp.rm(path.join(userDir(session),'jobs',name),{force:true});
          return send(res,200,{ok:true});
        }
      }
      const autoMatch=route.match(/^\/api\/documents\/([a-f0-9]{32})\/auto$/);
      if(autoMatch&&req.method==='PUT') {
        const input=await json(req,2000);const auto=await readJson('auto.json',{});
        if(input.voice==null) delete auto[autoMatch[1]];
        else { await fsp.access(path.join(userDir(session),autoMatch[1]+'.json')).catch(()=>{throw error(404,'Documento não encontrado.');}); const rate=Number(input.rate); if(typeof input.voice!=='string'||!/^[\w.-]{1,80}$/.test(input.voice)||!(rate>=0.5&&rate<=2))throw error(400,'Voz ou velocidade inválida.'); auto[autoMatch[1]]={voice:input.voice,rate}; }
        await atomic(path.join(userDir(session),'auto.json'),auto); autoSync().catch(()=>{}); return send(res,200,{auto:auto[autoMatch[1]]||null});
      }
      if(route==='/api/sync' && req.method==='GET')return send(res,200,await readJson('sync.json',{}));
      if(route==='/api/documents' && req.method==='POST')return send(res,201,await saveDoc(session,await json(req,12_000_000)));
      if(route==='/api/documents' && req.method==='GET') {
        const dir=userDir(session);await fsp.mkdir(dir,{recursive:true,mode:0o700});const docs=[];const auto=await readJson('auto.json',{});
        await Promise.all((await fsp.readdir(dir)).filter(x=>/^[a-f0-9]{32}\.json$/.test(x)).map(async file=>{const d=JSON.parse(await fsp.readFile(path.join(dir,file),'utf8'));const total=d.sections.reduce((n,s)=>n+s.text.length,0)||1;
          // Reading position (and when it was last saved) so the shelf can show progress and "continue" ordering.
          let progress=null;try{const pfile=path.join(dir,d.id+'.progress.json');const p=await pullKavita(session,d,pfile);const st=await fsp.stat(pfile);const before=d.sections.slice(0,p.section).reduce((n,s)=>n+s.text.length,0);const percent=Math.max(0,Math.min(100,Math.round((before+toText(d.sections[p.section]?.text||'',p.position))/total*100))),lastPage=d.sections[d.sections.length-1]?.page;progress={section:p.section,position:p.position,at:st.mtime.toISOString(),percent,read:percent>=99||(Number.isInteger(lastPage)&&p.kavita?.page>lastPage)};}catch{}
          docs.push({id:d.id,title:d.title,source:d.source,updated:d.updated,sections:d.sections.length,chars:total,cover:d.cover||null,origin:d.origin||null,auto:auto[d.id]||null,progress});}));
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
      const bookMatch=route.match(/^\/api\/documents\/([a-f0-9]{32})\/book\/(.+)$/);
      if(bookMatch&&req.method==='GET') {
        const base=path.join(userDir(session),'books',bookMatch[1]); let rel; try{rel=decodeURIComponent(bookMatch[2]);}catch{throw error(400,'Caminho inválido.');}
        const file=path.resolve(base,rel); if(!file.startsWith(base+path.sep))throw error(400,'Caminho inválido.');
        let buf; try{buf=await fsp.readFile(file);}catch{throw error(404,'Ficheiro não encontrado.');}
        const types={'.xhtml':'application/xhtml+xml','.html':'text/html','.htm':'text/html','.css':'text/css','.svg':'image/svg+xml','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.webp':'image/webp','.ttf':'font/ttf','.otf':'font/otf','.woff':'font/woff','.woff2':'font/woff2'};
        // Book files are untrusted markup: never scripts, never anything from outside this origin.
        return send(res,200,buf,{'Content-Type':(types[path.extname(file).toLowerCase()]||'application/octet-stream')+(/\.(x?html?|css|svg)$/i.test(file)?'; charset=utf-8':''),'Content-Security-Policy':"default-src 'self' data:; script-src 'none'; object-src 'none'; style-src 'self' 'unsafe-inline' data:; frame-ancestors 'self'",'X-Content-Type-Options':'nosniff','Cache-Control':'private, max-age=600'});
      }
      // Highlight colours: the account's own Kavita slots, so a highlight has the same colour in both readers.
      if(route==='/api/highlight-colors'&&req.method==='GET') return send(res,200,await highlightColors(session));
      // Books in progress in Kavita that are not on the shelf yet ("on deck" + the chapter to continue).
      if(route==='/api/kavita/reading'&&req.method==='GET') {
        const opt=()=>({signal:AbortSignal.timeout(8000)});
        const deck=await(await kavita('/api/series/on-deck?libraryId=0&pageNumber=1&pageSize=12',session,{method:'POST',body:'{}',...opt()})).json();
        const shelf=new Set();for(const f of await fsp.readdir(userDir(session)).catch(()=>[]))if(/^[a-f0-9]{32}\.json$/.test(f))try{const d=JSON.parse(await fsp.readFile(path.join(userDir(session),f),'utf8'));if(d.origin?.kind==='kavita')shelf.add(d.origin.chapter);}catch{}
        const out=[];for(const s of deck){try{const c=await(await kavita('/api/reader/continue-point?seriesId='+s.id,session,opt())).json();if(!c?.id||shelf.has(c.id))continue;out.push({series:s.id,chapter:c.id,title:String(s.name||'Livro').slice(0,300),percent:s.pages?Math.round((s.pagesRead||0)/s.pages*100):0,at:s.latestReadDate||null,format:s.format});}catch{}}
        return send(res,200,out);
      }
      const exportMatch=route.match(/^\/api\/documents\/([a-f0-9]{32})\/export(\.docx)?$/);
      if(exportMatch) {
        const doc=JSON.parse(await fsp.readFile(path.join(userDir(session),exportMatch[1]+'.json'),'utf8').catch(()=>{throw error(404,'Documento não encontrado.');}));
        if(exportMatch[2]&&req.method==='GET') return send(res,200,await exportDocx(session,doc),{'Content-Type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(exportName(doc)),'Cache-Control':'no-store'});
        if(!exportMatch[2]&&req.method==='POST') { if(!EXPORTS) throw error(400,'Não há pasta de exportação configurada neste servidor.'); const file=path.join(EXPORTS,exportName(doc)); await fsp.mkdir(EXPORTS,{recursive:true}); await fsp.writeFile(file,await exportDocx(session,doc)); return send(res,200,{saved:file}); }
      }
      const leftMatch=route.match(/^\/api\/documents\/([a-f0-9]{32})\/uncached$/);
      if(leftMatch&&req.method==='GET'){const doc=JSON.parse(await fsp.readFile(path.join(userDir(session),leftMatch[1]+'.json'),'utf8').catch(()=>{throw error(404,'Documento não encontrado.');}));return send(res,200,await uncached(doc,String(url.searchParams.get('voice')||''),Number(url.searchParams.get('rate'))||1));}
      const notesMatch=route.match(/^\/api\/documents\/([a-f0-9]{32})\/notes(?:\/([A-Za-z0-9_-]{1,200}))?$/);
      if(notesMatch) {
        const doc=JSON.parse(await fsp.readFile(path.join(userDir(session),notesMatch[1]+'.json'),'utf8').catch(()=>{throw error(404,'Documento não encontrado.');}));
        if(!notesMatch[2]&&req.method==='GET') return send(res,200,await listNotes(session,doc));
        if(!notesMatch[2]&&req.method==='POST') return send(res,201,await addNote(session,doc,validNote(doc,await json(req,20000))));
        if(notesMatch[2]&&req.method==='PUT') return send(res,200,await editNote(session,doc,notesMatch[2],await json(req,20000)));
        if(notesMatch[2]&&req.method==='DELETE') { await removeNote(session,doc,notesMatch[2]); return send(res,200,{ok:true}); }
      }
      const match=route.match(/^\/api\/documents\/([a-f0-9]{32})(\/progress)?$/);
      if(match) {
        const file=path.join(userDir(session),match[1]+(match[2]?'.progress':'')+'.json');
        if(req.method==='GET') { try{const doc=JSON.parse(await fsp.readFile(path.join(userDir(session),match[1]+'.json'),'utf8'));if(match[2]){const p=await pullKavita(session,doc,file);return send(res,200,{section:p.section,position:p.position});}return send(res,200,doc);}catch(e){if(match[2]&&e.code==='ENOENT')return send(res,200,{section:0,position:0});throw error(404,'Documento não encontrado.');} }
        if(match[2] && req.method==='PUT') { const doc=JSON.parse(await fsp.readFile(path.join(userDir(session),match[1]+'.json'),'utf8').catch(()=>{throw error(404,'Documento não encontrado.');}));const input=await json(req,1000);if(!Number.isInteger(input.section)||input.section<0||!Number.isInteger(input.position)||input.position<0||input.position>2_000_000||input.section>5000)throw error(400,'Posição inválida.');const old=await fsp.readFile(file,'utf8').then(JSON.parse).catch(()=>null);await atomic(file,await pushKavita(session,doc,{section:input.section,position:input.position},old));return send(res,200,{ok:true}); }
        if(!match[2] && req.method==='DELETE') { await fsp.rm(file,{force:true});await fsp.rm(path.join(userDir(session),match[1]+'.progress.json'),{force:true});await fsp.rm(path.join(userDir(session),match[1]+'.notes.json'),{force:true});await fsp.rm(coverFile(session,match[1]),{force:true});await fsp.rm(path.join(userDir(session),'books',match[1]),{recursive:true,force:true});return send(res,200,{ok:true}); }
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
if(require.main===module) { process.umask(0o077);http.createServer(handle).listen(Number(process.env.PORT)||8104,process.env.HOST||'0.0.0.0',()=>console.log('Lectoria pronta na porta '+(process.env.PORT||8104))); setInterval(()=>tick().catch(()=>{}),10000); setInterval(()=>autoSync().catch(()=>{}),600000); setTimeout(()=>autoSync().catch(()=>{}),60000); }
module.exports={handle,validateDoc,extract,hash,tick,pcm,wavHeader,nextAt};
