// Browser-side voices, off the main thread. Only Tugão (Piper) and the Kokoro English voices exist as browser models;
// the libraries fetch each model once (≈60 MB Tugão, ≈90 MB Kokoro) and keep it in the browser's own storage.
const KOKORO='https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';
const PIPER='https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.5/+esm'; // its default ONNX runtime path (cdnjs 1.18) lacks the files the bundled runtime 1.27 asks for
let kokoro,piper,queue=Promise.resolve();
const report=(id,phase,ratio)=>postMessage({id,progress:{phase,ratio}});
async function kokoroTTS(id){if(!kokoro){const {KokoroTTS}=await import(KOKORO);kokoro=await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX',{dtype:'q8',device:'wasm',progress_callback:p=>{if(p.status==='progress'&&String(p.file||'').endsWith('.onnx'))report(id,'download',(p.progress||0)/100);}});}return kokoro;}
async function piperTTS(id){if(!piper){const {TtsSession}=await import(PIPER);piper=await TtsSession.create({voiceId:'pt_PT-tugão-medium',wasmPaths:{onnxWasm:'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/',piperData:'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data',piperWasm:'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.wasm'},progress:p=>{if(p.total&&String(p.url||'').endsWith('.onnx'))report(id,'download',p.loaded/p.total);}});}return piper;}
onmessage=({data})=>{queue=queue.then(async()=>{try{let wav,playbackRate=1;
  if(data.voice==='pt_PT-tugao'){const tts=await piperTTS(data.id);report(data.id,'synth',0);wav=await (await tts.predict(data.text)).arrayBuffer();playbackRate=data.rate;}
  else{const tts=await kokoroTTS(data.id);report(data.id,'synth',0);wav=(await tts.generate(data.text,{voice:data.voice,speed:data.rate})).toWav();}
  postMessage({id:data.id,wav,playbackRate},[wav]);}catch(e){postMessage({id:data.id,error:String(e?.message||e)});}});};
