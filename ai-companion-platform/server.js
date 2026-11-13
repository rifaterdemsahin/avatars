// Companion chat backend: Venice (LLM + image + TTS), SQLite persistence, zero npm dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
for (const l of fs.existsSync(path.join(root, '.env')) ? fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n') : []) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const KEY = process.env.VENICE_API_KEY;
const PORT = +process.env.PORT || 3100;
const CHAT_MODEL = process.env.CHAT_MODEL || 'venice-uncensored-role-play';
const CHAT_MODEL_TR = process.env.CHAT_MODEL_TR || 'gemma-4-uncensored'; // role-play model garbles Turkish
// Uncensored text models the user can pick in Settings (validated server-side).
const UNCENSORED = ['venice-uncensored-role-play', 'gemma-4-uncensored', 'venice-uncensored-1-2', 'deepseek-v4-1-flash-uncensored', 'olafangensan-glm-4.7-flash-heretic'];
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
CREATE TABLE IF NOT EXISTS costs(id INTEGER PRIMARY KEY, ts INTEGER, route TEXT, model TEXT, usd REAL, tin INTEGER, tout INTEGER);
CREATE TABLE IF NOT EXISTS scenarios(persona TEXT PRIMARY KEY, text TEXT);
CREATE TABLE IF NOT EXISTS state(persona TEXT PRIMARY KEY, json TEXT);`);

try { db.exec('ALTER TABLE messages ADD COLUMN cost REAL'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN model TEXT'); } catch {}
const personas = JSON.parse(fs.readFileSync(path.join(root, 'personas.json'), 'utf8'));
const P = Object.fromEntries(personas.map(p => [p.id, p]));

const venice = async (route, body) => {
  const r = await fetch('https://api.venice.ai/api/v1' + route, {
    method: 'POST', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (r.status === 402) throw new Error('NO_CREDIT');
  if (!r.ok) throw new Error(`Venice ${route} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  await track(route, body, r);
  return r;
};

// Cost tracking. Estimate = tokens/characters/image count x Venice's published model price. Video has no published
// price, so its cost is the drop in the x-venice-balance-usd header. Every call is added to a per-request list and a ledger.
const als = new AsyncLocalStorage();
const PRICE = {}; let balance = null;
(async () => { for (const t of ['text', 'image', 'tts', 'video']) { try {
  const r = await fetch('https://api.venice.ai/api/v1/models?type=' + t, { headers: { Authorization: 'Bearer ' + KEY } });
  for (const m of (await r.json()).data || []) PRICE[m.id] = m.model_spec?.pricing || {};
} catch {} } })();
async function track(route, body, r) {
  const b = parseFloat(r.headers.get('x-venice-balance-usd'));
  const delta = balance != null && !isNaN(b) ? Math.max(0, balance - b) : null;
  if (!isNaN(b)) balance = b;
  const pr = PRICE[body.model] || {}; let usage = null, usd = null;
  if (route === '/chat/completions') { try { usage = (await r.clone().json()).usage; } catch {}
    if (usage) usd = (usage.prompt_tokens * (pr.input?.usd || 0) + usage.completion_tokens * (pr.output?.usd || 0)) / 1e6; }
  else if (route === '/image/generate') usd = pr.generation?.usd ?? null;
  else if (route === '/audio/speech') usd = (String(body.input).length * (pr.input?.usd || 0)) / 1e6;
  if (usd == null) usd = delta; // video and anything without a published price
  const call = { route, model: body.model, usd, tin: usage?.prompt_tokens || 0, tout: usage?.completion_tokens || 0 };
  als.getStore()?.calls.push(call);
  db.prepare('INSERT INTO costs(ts,route,model,usd,tin,tout) VALUES(?,?,?,?,?,?)').run(Date.now(), route, call.model, usd, call.tin, call.tout);
  log(`[cost] ${route} ${call.model} $${(usd ?? 0).toFixed(5)} tokens ${call.tin}/${call.tout} balance=${balance}`);
}
const reqCost = () => { const c = als.getStore()?.calls || []; return { usd: c.reduce((a, x) => a + (x.usd || 0), 0), calls: c.length, tin: c.reduce((a, x) => a + x.tin, 0), tout: c.reduce((a, x) => a + x.tout, 0) }; };

const customScenario = id => db.prepare('SELECT text FROM scenarios WHERE persona=?').get(id)?.text || null;
const scenarioOf = id => customScenario(id) || P[id].scenario;
const getState = id => ({ affection_level: 1, agreed_plans: [], scene: P[id].scene0, ...JSON.parse(db.prepare('SELECT json FROM state WHERE persona=?').get(id)?.json || '{}') });
const setState = (id, st) => db.prepare('INSERT OR REPLACE INTO state(persona,json) VALUES(?,?)').run(id, JSON.stringify(st));
const log = (...a) => { const l = new Date().toISOString() + ' ' + a.join(' '); console.log(l); fs.appendFileSync(path.join(root, 'data/prompts.log'), l + '\n'); };
const history = id => db.prepare('SELECT role,kind,content,ts FROM messages WHERE persona=? ORDER BY id DESC LIMIT ?').all(id, TURNS).reverse();
const save = (id, role, kind, content, cost = null, model = null) => db.prepare('INSERT INTO messages(persona,role,kind,content,ts,cost,model) VALUES(?,?,?,?,?,?,?)').run(id, role, kind, content, Date.now(), cost, model);

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
Scenario (follow this setting and relationship; the user may have just changed it): ${scenarioOf(id)}
Hard boundaries: ${p.boundaries.join('; ')}. Keep content non-explicit.
Current scene (the world right now; your dialogue must react to it and to any change the user states): ${JSON.stringify(getState(id).scene)}
Relationship state: ${JSON.stringify({ affection_level: getState(id).affection_level, agreed_plans: getState(id).agreed_plans })}
${mem.length ? 'Things you remember about the user:\n- ' + mem.join('\n- ') : ''}
Do not assume the user's gender or age. Never call them boy, girl, man, miss, sir, lad or similar; use their name if known, otherwise 'you' or a neutral address like 'friend'.
${lang === 'tr' ? 'Write every reply in natural, idiomatic Turkish (keep the character\'s flavor, adapt the dialect to a Turkish equivalent). Always answer in Turkish, even when the user writes in English; never reply in English.' : 'Write every reply in English.'}
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

// Optional user description for "Show me the scene": merged with the scene state into one English prompt; the user's words win.
async function withNote(id, sp, note) {
  const p = P[id];
  try {
    const r = await (await venice('/chat/completions', { model: CHAT_MODEL, temperature: 0.3, max_tokens: 300,
      messages: [{ role: 'user', content: `Write ONE English image-generation prompt (max 800 characters, no preamble, no quotes).\nBase scene: ${sp.prompt}\nUser's request (it overrides any conflicting scene detail; translate it to English if needed): ${note}\nKeep the character's look: ${p.visual.appearance}. Tasteful and fully clothed.` }] })).json();
    const prompt = r.choices[0].message.content.trim().replace(/^["']|["']$/g, '').slice(0, 1200);
    const seed = (sp.seed + [...note].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)) % 999999999;
    return { prompt, negative_prompt: 'deformed, extra limbs, text, watermark', seed };
  } catch (e) { console.warn('note merge failed:', e.message); return { ...sp, prompt: `${note}. ${sp.prompt}`.slice(0, 1400) }; }
}

// Prompt fixer: before generating, rewrite the request using the storyline, scene state and persona look. Shown to the user in a modal.
const hashStr = t => [...t].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
async function fixPrompt(id, note, kind, lang) {
  const p = P[id], st = getState(id), sc = st.scene, sp = scenePrompt(id);
  const turns = history(id).filter(m => m.kind === 'text').slice(-6).map(m => `${m.role === 'user' ? 'User' : p.name}: ${m.content}`).join('\n');
  const ask = `You are a prompt fixer for an ${kind} generator in an interactive story. Rewrite the request into ONE strong English ${kind} prompt that matches the storyline.\n\nStory so far (latest turns):\n${turns || '(no messages yet)'}\n\nScenario: ${scenarioOf(id)}\nCurrent scene: ${JSON.stringify(sc)}\nCharacter look (keep identical): ${p.name}, ${p.visual.appearance}\nUser's request (may be empty, may be Turkish; if empty, depict the latest story moment): ${note || '(none)'}\n\nRules: keep continuity with location, lighting, time, weather and props from the story; the user's request wins on conflicts; describe subject, setting, lighting, camera framing and mood; tasteful and fully clothed; max 800 characters; no names of real people.\nReturn ONLY JSON: {"prompt": string, "negative_prompt": string, "changes": [up to 4 short strings in ${lang === 'tr' ? 'Turkish' : 'English'} saying what you fixed or added]}`;
  const r = await (await venice('/chat/completions', { model: lang === 'tr' ? CHAT_MODEL_TR : CHAT_MODEL, temperature: 0.4, max_tokens: 500, messages: [{ role: 'user', content: ask }] })).json();
  let j; try { j = JSON.parse(r.choices[0].message.content.match(/\{[\s\S]*\}/)[0]); } catch { j = { prompt: `${note ? note + '. ' : ''}${sp.prompt}`, negative_prompt: sp.negative_prompt, changes: [] }; }
  const base = ['deformed', 'extra limbs', 'text', 'watermark'];
  const dark = /dark|dim|candle|night|gloom|low light/i.test(sc.lighting + ' ' + sc.time_of_day) && !/daylight|sunny|bright/i.test(note || '');
  const neg = [...new Set([...base, ...String(j.negative_prompt || '').split(',').map(x => x.trim()).filter(Boolean), ...(dark ? ['daylight', 'sunlight', 'bright window', 'golden hour', 'overexposed'] : [])])].join(', ');
  return { original: note, prompt: String(j.prompt).slice(0, 1400), negative_prompt: neg, changes: j.changes || [],
    context: { scene: sc, turns: turns.split('\n').slice(-3) }, model: kind === 'video' ? VIDEO_MODEL : IMAGE_MODEL };
}

const jobs = {};
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(ok => { let b = ''; req.on('data', c => b += c); req.on('end', () => ok(b ? JSON.parse(b) : {})); });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4' };

// Model choice with the reason, shown in the right-hand panel. Reasons come from tests run on 2026-11-11.
function chooseModel(p, lang, picked) {
  const tr = (p.speaks || lang) === 'tr', price = id => PRICE[id]?.output?.usd;
  if (UNCENSORED.includes(picked)) return { model: picked, auto: false, price: price(picked),
    reason_en: `You picked ${picked} in Settings, so Auto is off.`, reason_tr: `Ayarlar'dan ${picked} modelini seçtiniz, bu yüzden Otomatik kapalı.` };
  if (tr) return { model: CHAT_MODEL_TR, auto: true, price: price(CHAT_MODEL_TR),
    reason_en: `Auto: ${p.name} speaks Turkish, so ${CHAT_MODEL_TR} is used. In my tests venice-uncensored-role-play produced broken Turkish (invented words, stray Arabic) and venice-uncensored-1-2 was weak, while ${CHAT_MODEL_TR} and deepseek-v4-1-flash-uncensored were fluent. Gemma is the cheaper of the two ($0.50 vs $1.32 per 1M output tokens). All are uncensored models.`,
    reason_tr: `Otomatik: ${p.name} Türkçe konuştuğu için ${CHAT_MODEL_TR} kullanılıyor. Testlerimde venice-uncensored-role-play bozuk Türkçe üretti (uydurma kelimeler, Arapça harfler), venice-uncensored-1-2 zayıftı; ${CHAT_MODEL_TR} ve deepseek-v4-1-flash-uncensored akıcıydı. Gemma ikisinden daha ucuz (1M çıktı token: $0,50 - $1,32). Hepsi sansürsüz modeller.` };
  return { model: CHAT_MODEL, auto: true, price: price(CHAT_MODEL),
    reason_en: `Auto: English chat uses ${CHAT_MODEL}, the uncensored model Venice tunes for role-play, as you asked. I did not benchmark other models for English, only Turkish. You can switch in Settings.`,
    reason_tr: `Otomatik: İngilizce sohbet için ${CHAT_MODEL} kullanılıyor; Venice'in rol yapma için ayarladığı sansürsüz model, istediğiniz gibi. İngilizce için diğer modelleri karşılaştırmadım, yalnızca Türkçeyi test ettim. Ayarlar'dan değiştirebilirsiniz.` };
}

const handle = async (req, res) => {
  const url = new URL(req.url, 'http://x'); let m;
  try {
    if (url.pathname === '/api/pay-config') { // PAYMENT_URL e.g. https://paypal.me/yourname or a Stripe payment link
      return json(res, 200, { url: process.env.PAYMENT_URL || null, payee: process.env.PAYEE || null });
    }
    if (url.pathname === '/api/model-choice') { const p = P[url.searchParams.get('persona')]; return p ? json(res, 200, chooseModel(p, url.searchParams.get('lang') || 'en', url.searchParams.get('model') || '')) : json(res, 404, { error: 'unknown persona' }); }
    if (url.pathname === '/api/models') return json(res, 200, UNCENSORED.map(id => ({ id, out: PRICE[id]?.output?.usd ?? null })));
    if (url.pathname === '/api/costs') { // running totals for the UI
      if (balance == null) { const d = ((await (await fetch('https://api.venice.ai/api/v1/api_keys/rate_limits', { headers: { Authorization: 'Bearer ' + KEY } })).json()).data) || {}; balance = d.balances?.USD ?? null; }
      const day = new Date(); day.setHours(0, 0, 0, 0);
      const one = q => db.prepare(q).get(day.getTime()) || {};
      return json(res, 200, { balance, today: one('SELECT COALESCE(SUM(usd),0) usd, COUNT(*) n FROM costs WHERE ts>=?'),
        byRoute: db.prepare('SELECT route, COUNT(*) n, ROUND(SUM(usd),5) usd FROM costs WHERE ts>=? GROUP BY route').all(day.getTime()) });
    }
    if (url.pathname === '/api/balance') { // balance of the API key in .env (key never leaves the server)
      const r = await fetch('https://api.venice.ai/api/v1/api_keys/rate_limits', { headers: { Authorization: 'Bearer ' + KEY } });
      const d = (await r.json()).data || {};
      return json(res, 200, { tier: d.apiTier?.id, balances: d.balances, accessPermitted: d.accessPermitted });
    }
    if (url.pathname === '/api/e2b/run' && req.method === 'POST') { // dry-run probe of the Venice login page in an E2B sandbox; never pays
      const jid = String(Date.now()); jobs[jid] = { log: [], done: false };
      import('./e2b/run.mjs').then(m => m.runProbe({ apiKey: process.env.E2B_API_KEY, root, log: l => jobs[jid].log.push(l) }))
        .then(r => { jobs[jid].result = r; }).catch(e => { jobs[jid].error = String(e.message).slice(0, 300); }).finally(() => { jobs[jid].done = true; });
      return json(res, 200, { job: jid });
    }
    if ((m = url.pathname.match(/^\/api\/e2b\/job\/(\d+)$/))) return json(res, 200, jobs[m[1]] || { error: 'unknown job', done: true });
    if (url.pathname === '/e2b') url.pathname = '/e2b.html';
    if (url.pathname === '/pay') url.pathname = '/pay.html';
    if (url.pathname === '/balance') url.pathname = '/balance.html';
    if (url.pathname === '/api/personas') {
      return json(res, 200, personas.map(p => { const h = history(p.id); const last = h.at(-1); const cs = customScenario(p.id); return { ...p, ...(cs ? { scenario: cs, scenario_tr: cs } : {}), customScenario: !!cs, boundaries: undefined, visual: undefined, scene0: undefined, last: last ? { content: last.kind === 'text' ? last.content : `[${last.kind}]`, ts: last.ts } : null }; }));
    }
    if ((m = url.pathname.match(/^\/api\/scenario\/(\w+)$/)) && req.method === 'POST') {
      const id = m[1], p = P[id]; if (!p) return json(res, 404, { error: 'unknown persona' });
      const text = String((await readBody(req)).scenario || '').trim().slice(0, 1200);
      if (text) db.prepare('INSERT OR REPLACE INTO scenarios(persona,text) VALUES(?,?)').run(id, text); else db.prepare('DELETE FROM scenarios WHERE persona=?').run(id);
      const sc = text || p.scenario;
      // Re-derive the scene (location, lighting, time, weather, props) from the new scenario so images and dialogue follow it.
      let scene = p.scene0;
      try {
        const r = await (await venice('/chat/completions', { model: CHAT_MODEL, temperature: 0, max_tokens: 250,
          messages: [{ role: 'user', content: `Scenario: ${sc}\n\nReturn ONLY JSON describing the opening scene: {"location":string,"indoor":boolean,"lighting":string,"time_of_day":string,"weather":string,"props":[strings]}` }] })).json();
        scene = JSON.parse(r.choices[0].message.content.match(/\{[\s\S]*\}/)[0]);
      } catch (e) { console.warn('scenario scene failed:', e.message); }
      setState(id, { ...getState(id), scene });
      log(`[scenario ${id}]`, text ? 'custom: ' + text : 'reset to default', JSON.stringify(scene));
      save(id, 'system', 'note', text ? 'Scenario updated: ' + text : 'Scenario reset to default');
      return json(res, 200, { scenario: sc, scenario_tr: text || p.scenario_tr, customScenario: !!text, scene });
    }
    if ((m = url.pathname.match(/^\/api\/chat\/(\w+)$/))) {
      const id = m[1], p = P[id]; if (!p) return json(res, 404, { error: 'unknown persona' });
      if (req.method === 'GET') return json(res, 200, { messages: db.prepare('SELECT role,kind,content,ts,cost,model FROM messages WHERE persona=? ORDER BY id').all(id), state: getState(id) });
      const { text, lang, emoji, model } = await readBody(req);
      await sceneQ[id];
      save(id, 'user', 'text', text);
      await queueScene(id);
      const msgs = [{ role: 'system', content: systemPrompt(p, id, text, p.speaks || lang, emoji !== false) },
        ...history(id).filter(x => x.kind === 'text').map(x => ({ role: x.role === 'user' ? 'user' : 'assistant', content: x.content }))];
      if ((p.speaks || lang) === 'tr') { msgs.at(-1).content += '\n\n[Rol gereği yalnızca Türkçe yanıt ver. Reply ONLY in Turkish.]'; msgs.push({ role: 'system', content: 'Sadece Türkçe yaz. Your next reply must be entirely in Turkish.' }); } // history in English would otherwise pull replies to English
      const out = await (await venice('/chat/completions', { model: chooseModel(p, lang, model).model, messages: msgs, temperature: 0.9, max_tokens: 300 })).json();
      const reply = out.choices[0].message.content.trim();
      const cost = reqCost();
      const choice = chooseModel(p, lang, model);
      save(id, 'assistant', 'text', reply, cost.usd, choice.model);
      queueScene(id);
      if (db.prepare("SELECT COUNT(*) c FROM messages WHERE persona=? AND role='user'").get(id).c % 4 === 0) extract(id);
      return json(res, 200, { reply, ts: Date.now(), cost, balance, choice, model: choice.model });
    }
    if ((m = url.pathname.match(/^\/api\/prompt-fix\/(\w+)$/)) && req.method === 'POST') {
      const id = m[1]; if (!P[id]) return json(res, 404, { error: 'unknown persona' });
      const { note, kind, lang } = await readBody(req);
      await sceneQ[id];
      const fx = await fixPrompt(id, String(note || '').trim().slice(0, 300), kind === 'video' ? 'video' : 'image', lang);
      log(`[prompt-fix ${id}] request="${note || ''}" fixed="${fx.prompt}" negative="${fx.negative_prompt}"`);
      return json(res, 200, { ...fx, cost: reqCost(), balance });
    }
    if ((m = url.pathname.match(/^\/api\/image\/(\w+)$/))) {
      const id = m[1], p = P[id]; if (!p) return json(res, 404, { error: 'unknown persona' });
      await sceneQ[id];
      const body = await readBody(req), note = String(body.note || '').trim().slice(0, 300);
      let sp = scenePrompt(id);
      if (body.prompt) { // already fixed and approved by the user in the modal
        const pr = String(body.prompt).slice(0, 1400);
        sp = { prompt: pr, negative_prompt: String(body.negative_prompt || '').slice(0, 600), seed: (P[id].visual.seed + hashStr(pr)) % 999999999 };
        save(id, 'system', 'note', 'Approved prompt: ' + pr);
      } else if (note) { sp = await withNote(id, sp, note); save(id, 'system', 'note', 'Image request: ' + note); }
      log(`[image ${id}] note="${note}" model=${IMAGE_MODEL} seed=${sp.seed} prompt="${sp.prompt}" negative="${sp.negative_prompt}"`);
      const r = await (await venice('/image/generate', { model: IMAGE_MODEL, prompt: sp.prompt, negative_prompt: sp.negative_prompt, seed: sp.seed, width: 1024, height: 640, format: 'png', safe_mode: true, return_binary: false })).json();
      const file = `${id}-${Date.now()}.png`;
      fs.writeFileSync(path.join(root, 'data/assets', file), Buffer.from(r.images[0], 'base64'));
      const cost = reqCost();
      save(id, 'assistant', 'image', '/assets/' + file, cost.usd, IMAGE_MODEL);
      return json(res, 200, { url: '/assets/' + file, cost, balance, model: IMAGE_MODEL });
    }
    if ((m = url.pathname.match(/^\/api\/video\/(\w+)$/))) {
      const id = m[1], p = P[id]; if (!p) return json(res, 404, { error: 'unknown persona' });
      await sceneQ[id];
      const body = await readBody(req), note = String(body.note || '').trim().slice(0, 300);
      let sp = scenePrompt(id);
      if (body.prompt) { // already fixed and approved by the user in the modal
        const pr = String(body.prompt).slice(0, 1400);
        sp = { prompt: pr, negative_prompt: String(body.negative_prompt || '').slice(0, 600), seed: (P[id].visual.seed + hashStr(pr)) % 999999999 };
        save(id, 'system', 'note', 'Approved prompt: ' + pr);
      } else if (note) { sp = await withNote(id, sp, note); save(id, 'system', 'note', 'Image request: ' + note); }
      log(`[video ${id}] note="${note}" model=${VIDEO_MODEL} prompt="${sp.prompt}" negative="${sp.negative_prompt}"`);
      const q = await (await venice('/video/queue', { model: VIDEO_MODEL, prompt: sp.prompt, negative_prompt: sp.negative_prompt, duration: '4s', resolution: '480p', aspect_ratio: '16:9', audio: false })).json();
      for (let i = 0; i < 90; i++) {
        await new Promise(r => setTimeout(r, 4000));
        const r = await venice('/video/retrieve', { model: VIDEO_MODEL, queue_id: q.queue_id });
        if ((r.headers.get('content-type') || '').includes('video')) {
          const file = `${id}-${Date.now()}.mp4`;
          fs.writeFileSync(path.join(root, 'data/assets', file), Buffer.from(await r.arrayBuffer()));
          const cost = reqCost();
          save(id, 'assistant', 'video', '/assets/' + file, cost.usd, VIDEO_MODEL);
          return json(res, 200, { url: '/assets/' + file, cost, balance, model: VIDEO_MODEL });
        }
        const st = await r.json(); log(`[video ${id}] status`, st.status || JSON.stringify(st).slice(0, 80));
        if (/fail|error/i.test(st.status || '')) throw new Error('video failed');
      }
      throw new Error('video timed out');
    }
    if ((m = url.pathname.match(/^\/api\/tts\/(\w+)$/)) && req.method === 'POST') {
      const p = P[m[1]]; const { text, lang } = await readBody(req);
      const tr = (p.speaks || lang) === 'tr'; // Kokoro has no Turkish; use the multilingual ElevenLabs model
      const r = await venice('/audio/speech', { model: tr ? TTS_MODEL_TR : TTS_MODEL, input: text.slice(0, 1000), voice: tr ? p.voice_tr : p.voice, response_format: 'mp3' });
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'X-Cost-USD': String(reqCost().usd), 'Access-Control-Expose-Headers': 'X-Cost-USD' });
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
};
http.createServer((req, res) => als.run({ calls: [] }, () => handle(req, res))).listen(PORT, () => console.log(`Companion platform on http://localhost:${PORT} (chat=${CHAT_MODEL}, image=${IMAGE_MODEL}, tts=${TTS_MODEL})`));
