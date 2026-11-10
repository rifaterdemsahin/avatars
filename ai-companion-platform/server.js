// Companion chat backend: Venice (LLM + image + TTS), SQLite persistence, zero npm dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
for (const l of fs.existsSync(path.join(root, '.env')) ? fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n') : []) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const KEY = process.env.VENICE_API_KEY;
const PORT = +process.env.PORT || 3100;
const CHAT_MODEL = process.env.CHAT_MODEL || 'venice-uncensored-role-play';
const CHAT_MODEL_TR = process.env.CHAT_MODEL_TR || 'zai-org-glm-5-1'; // roleplay model is weak in Turkish
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'venice-sd35';
const VIDEO_MODEL = process.env.VIDEO_MODEL || 'seedance-2-0-fast-text-to-video-basic';
const TTS_MODEL_TR = process.env.TTS_MODEL_TR || 'tts-elevenlabs-turbo-v2-5';
const TTS_MODEL = process.env.TTS_MODEL || 'tts-kokoro';
const TURNS = 20; // working context window
if (!KEY) { console.error('VENICE_API_KEY missing'); process.exit(1); }

fs.mkdirSync(path.join(root, 'data/assets'), { recursive: true });
const db = new DatabaseSync(path.join(root, 'data/companion.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, persona TEXT, role TEXT, kind TEXT DEFAULT 'text', content TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS memories(id INTEGER PRIMARY KEY, persona TEXT, fact TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS state(persona TEXT PRIMARY KEY, json TEXT);`);

const personas = JSON.parse(fs.readFileSync(path.join(root, 'personas.json'), 'utf8'));
const P = Object.fromEntries(personas.map(p => [p.id, p]));

const venice = async (route, body) => {
  const r = await fetch('https://api.venice.ai/api/v1' + route, {
    method: 'POST', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`Venice ${route} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r;
};

const getState = id => ({ affection_level: 1, agreed_plans: [], scene: P[id].scene0, ...JSON.parse(db.prepare('SELECT json FROM state WHERE persona=?').get(id)?.json || '{}') });
const setState = (id, st) => db.prepare('INSERT OR REPLACE INTO state(persona,json) VALUES(?,?)').run(id, JSON.stringify(st));
const log = (...a) => { const l = new Date().toISOString() + ' ' + a.join(' '); console.log(l); fs.appendFileSync(path.join(root, 'data/prompts.log'), l + '\n'); };
const history = id => db.prepare('SELECT role,kind,content,ts FROM messages WHERE persona=? ORDER BY id DESC LIMIT ?').all(id, TURNS).reverse();
const save = (id, role, kind, content) => db.prepare('INSERT INTO messages(persona,role,kind,content,ts) VALUES(?,?,?,?,?)').run(id, role, kind, content, Date.now());

// Episodic memory: keyword retrieval (swap for pgvector/embeddings later).
function recall(id, text) {
  const words = new Set(text.toLowerCase().match(/[a-z]{4,}/g) || []);
  return db.prepare('SELECT fact FROM memories WHERE persona=? ORDER BY id DESC LIMIT 200').all(id)
    .filter(m => (m.fact.toLowerCase().match(/[a-z]{4,}/g) || []).some(w => words.has(w))).slice(0, 5).map(m => m.fact);
}

function systemPrompt(p, id, userText, lang = 'en', emoji = true) {
  const mem = recall(id, userText);
  return `You are ${p.name}, a fictional character in an interactive story. Stay in character at all times.
Background: ${p.bio}
Speaking tone: ${p.tone}
Scenario: ${p.scenario}
Hard boundaries: ${p.boundaries.join('; ')}. Keep content non-explicit.
Current scene (the world right now; your dialogue must react to it and to any change the user states): ${JSON.stringify(getState(id).scene)}
Relationship state: ${JSON.stringify({ affection_level: getState(id).affection_level, agreed_plans: getState(id).agreed_plans })}
${mem.length ? 'Things you remember about the user:\n- ' + mem.join('\n- ') : ''}
Do not assume the user's gender or age. Never call them boy, girl, man, miss, sir, lad or similar; use their name if known, otherwise 'you' or a neutral address like 'friend'.
${lang === 'tr' ? 'Write every reply in natural, idiomatic Turkish (keep the character\'s flavor, adapt the dialect to a Turkish equivalent). The user may write in Turkish or English.' : 'Write every reply in English.'}
${emoji ? 'Use emojis naturally: 1-3 per reply that match the mood.' : 'Do not use emojis.'}
Reply in 1-4 short sentences, in first person, no stage-direction headings.`;
}

// Every 4 user turns, extract state + durable facts in a background pass.
async function extract(id) {
  const h = history(id).slice(-8).map(m => `${m.role}: ${m.content}`).join('\n');
  try {
    const r = await (await venice('/chat/completions', {
      model: CHAT_MODEL, temperature: 0,
      messages: [{ role: 'user', content: `From this conversation return ONLY JSON {"affection_level":1-10,"agreed_plans":[strings],"facts":[short durable facts about the user]}\n\n${h}` }]
    })).json();
    const j = JSON.parse(r.choices[0].message.content.match(/\{[\s\S]*\}/)[0]);
    const { facts = [], ...state } = j;
    setState(id, { ...getState(id), ...state });
    for (const f of facts) db.prepare('INSERT INTO memories(persona,fact,ts) VALUES(?,?,?)').run(id, String(f), Date.now());
  } catch (e) { console.warn('extract failed:', e.message); }
}

// Scene state: location, indoor/outdoor, lighting, time, weather, props. Updated from every turn.
const sceneQ = {};
async function updateScene(id, extra = '') {
  const st = getState(id);
  const lines = history(id).filter(m => m.kind === 'text').slice(-4).map(m => `${m.role === 'user' ? 'User' : P[id].name}: ${m.content}`).join('\n') + extra;
  try {
    const r = await (await venice('/chat/completions', { model: CHAT_MODEL, temperature: 0, max_tokens: 250,
      messages: [{ role: 'user', content: `Current scene: ${JSON.stringify(st.scene)}\nRecent messages:\n${lines}\n\nUpdate the scene so it reflects what the latest messages say has changed (moving indoors/outdoors, lights going out, time passing, weather, objects). Keep fields that did not change, but make all fields mutually consistent: if it is dark, the time of day must be night or a power cut, and drop props or views that contradict it (e.g. a sunlit window or sea view). Return ONLY JSON {"location":string,"indoor":boolean,"lighting":string,"time_of_day":string,"weather":string,"props":[strings]}` }] })).json();
    const scene = JSON.parse(r.choices[0].message.content.match(/\{[\s\S]*\}/)[0]);
    setState(id, { ...getState(id), scene });
    log(`[scene ${id}]`, JSON.stringify(scene));
  } catch (e) { console.warn('scene update failed:', e.message); }
}
const queueScene = (id, extra) => (sceneQ[id] = (sceneQ[id] || Promise.resolve()).then(() => updateScene(id, extra)));

// Image/video prompt = scene state + last 3 turns + persona appearance. Reference images are not used; identity
// comes only from the appearance text and a seed derived from persona seed + scene, so the background can change.
function scenePrompt(id) {
  const p = P[id], sc = getState(id).scene;
  const turns = history(id).filter(m => m.kind === 'text').slice(-3).map(m => `${m.role === 'user' ? 'The visitor' : p.name}: ${m.content}`).join(' ');
  const dark = /dark|dim|candle|lantern|night|gloom|shadow|low light|blackout|unlit/i.test(sc.lighting + ' ' + sc.time_of_day);
  if (dark) { // keep the state self-consistent whatever the extractor returned
    if (/morning|noon|afternoon|day|dawn|dusk|sunset/i.test(sc.time_of_day)) sc.time_of_day = 'night';
    sc.props = (sc.props || []).filter(x => !/window|sun|sea|sky|view/i.test(x));
    sc.lighting += '; only a single lantern or candle glow, deep shadows, windows dark';
  }
  const prompt = `${sc.indoor ? 'Interior' : 'Exterior'} scene. Location: ${sc.location}. Lighting: ${sc.lighting}. Time: ${sc.time_of_day}. Weather: ${sc.weather}. Props: ${(sc.props || []).join(', ')}. Story moment: ${turns.slice(-350)}. Character: ${p.name}, ${p.visual.appearance}. Cinematic, tasteful, fully clothed.`;
  const neg = ['deformed', 'extra limbs', 'text', 'watermark'];
  if (dark) neg.push('daylight', 'sunlight', 'bright window', 'golden hour', 'overexposed', 'blue sky');
  if (sc.indoor) neg.push('outdoor view', 'open sea horizon');
  else neg.push('ceiling', 'indoor room');
  const key = sc.location + sc.lighting + sc.time_of_day;
  const seed = (p.visual.seed + [...key].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)) % 999999999;
  return { prompt: prompt.slice(0, 1400), negative_prompt: neg.join(', '), seed };
}

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(ok => { let b = ''; req.on('data', c => b += c); req.on('end', () => ok(b ? JSON.parse(b) : {})); });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/pay-config') { // PAYMENT_URL e.g. https://paypal.me/yourname or a Stripe payment link
      return json(res, 200, { url: process.env.PAYMENT_URL || null, payee: process.env.PAYEE || null });
    }
    if (url.pathname === '/pay') url.pathname = '/pay.html';
    if (url.pathname === '/api/personas') {
      return json(res, 200, personas.map(p => { const h = history(p.id); const last = h.at(-1); return { ...p, boundaries: undefined, visual: undefined, scene0: undefined, last: last ? { content: last.kind === 'text' ? last.content : `[${last.kind}]`, ts: last.ts } : null }; }));
    }
    let m;
    if ((m = url.pathname.match(/^\/api\/chat\/(\w+)$/))) {
      const id = m[1], p = P[id]; if (!p) return json(res, 404, { error: 'unknown persona' });
      if (req.method === 'GET') return json(res, 200, { messages: db.prepare('SELECT role,kind,content,ts FROM messages WHERE persona=? ORDER BY id').all(id), state: getState(id) });
      const { text, lang, emoji } = await readBody(req);
      await sceneQ[id];
      save(id, 'user', 'text', text);
      await queueScene(id);
      const msgs = [{ role: 'system', content: systemPrompt(p, id, text, lang, emoji !== false) },
        ...history(id).filter(x => x.kind === 'text').map(x => ({ role: x.role === 'user' ? 'user' : 'assistant', content: x.content }))];
      const out = await (await venice('/chat/completions', { model: lang === 'tr' ? CHAT_MODEL_TR : CHAT_MODEL, messages: msgs, temperature: 0.9, max_tokens: 300 })).json();
      const reply = out.choices[0].message.content.trim();
      save(id, 'assistant', 'text', reply);
      queueScene(id);
      if (db.prepare("SELECT COUNT(*) c FROM messages WHERE persona=? AND role='user'").get(id).c % 4 === 0) extract(id);
      return json(res, 200, { reply, ts: Date.now() });
    }
    if ((m = url.pathname.match(/^\/api\/image\/(\w+)$/))) {
      const id = m[1], p = P[id]; if (!p) return json(res, 404, { error: 'unknown persona' });
      await sceneQ[id];
      const sp = scenePrompt(id);
      log(`[image ${id}] model=${IMAGE_MODEL} seed=${sp.seed} prompt="${sp.prompt}" negative="${sp.negative_prompt}"`);
      const r = await (await venice('/image/generate', { model: IMAGE_MODEL, prompt: sp.prompt, negative_prompt: sp.negative_prompt, seed: sp.seed, width: 1024, height: 640, format: 'png', safe_mode: true, return_binary: false })).json();
      const file = `${id}-${Date.now()}.png`;
      fs.writeFileSync(path.join(root, 'data/assets', file), Buffer.from(r.images[0], 'base64'));
      save(id, 'assistant', 'image', '/assets/' + file);
      return json(res, 200, { url: '/assets/' + file });
    }
    if ((m = url.pathname.match(/^\/api\/video\/(\w+)$/))) {
      const id = m[1], p = P[id]; if (!p) return json(res, 404, { error: 'unknown persona' });
      await sceneQ[id];
      const sp = scenePrompt(id);
      log(`[video ${id}] model=${VIDEO_MODEL} prompt="${sp.prompt}" negative="${sp.negative_prompt}"`);
      const q = await (await venice('/video/queue', { model: VIDEO_MODEL, prompt: sp.prompt, negative_prompt: sp.negative_prompt, duration: '4s', resolution: '480p', aspect_ratio: '16:9', audio: false })).json();
      for (let i = 0; i < 90; i++) {
        await new Promise(r => setTimeout(r, 4000));
        const r = await venice('/video/retrieve', { model: VIDEO_MODEL, queue_id: q.queue_id });
        if ((r.headers.get('content-type') || '').includes('video')) {
          const file = `${id}-${Date.now()}.mp4`;
          fs.writeFileSync(path.join(root, 'data/assets', file), Buffer.from(await r.arrayBuffer()));
          save(id, 'assistant', 'video', '/assets/' + file);
          return json(res, 200, { url: '/assets/' + file });
        }
        const st = await r.json(); log(`[video ${id}] status`, st.status || JSON.stringify(st).slice(0, 80));
        if (/fail|error/i.test(st.status || '')) throw new Error('video failed');
      }
      throw new Error('video timed out');
    }
    if ((m = url.pathname.match(/^\/api\/tts\/(\w+)$/)) && req.method === 'POST') {
      const p = P[m[1]]; const { text, lang } = await readBody(req);
      const tr = lang === 'tr'; // Kokoro has no Turkish; use the multilingual ElevenLabs model
      const r = await venice('/audio/speech', { model: tr ? TTS_MODEL_TR : TTS_MODEL, input: text.slice(0, 1000), voice: tr ? p.voice_tr : p.voice, response_format: 'mp3' });
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    // static
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    const base = file.startsWith('/assets/') ? path.join(root, 'data') : path.join(root, 'public');
    const full = path.normalize(path.join(base, file));
    if (!full.startsWith(base) || !fs.existsSync(full)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  } catch (e) { console.error(e.message); json(res, 500, { error: e.message }); }
}).listen(PORT, () => console.log(`Companion platform on http://localhost:${PORT} (chat=${CHAT_MODEL}, image=${IMAGE_MODEL}, tts=${TTS_MODEL})`));
