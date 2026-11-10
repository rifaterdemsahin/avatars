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
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'venice-sd35';
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

const getState = id => JSON.parse(db.prepare('SELECT json FROM state WHERE persona=?').get(id)?.json || '{"affection_level":1,"current_location":null,"agreed_plans":[]}');
const history = id => db.prepare('SELECT role,kind,content,ts FROM messages WHERE persona=? ORDER BY id DESC LIMIT ?').all(id, TURNS).reverse();
const save = (id, role, kind, content) => db.prepare('INSERT INTO messages(persona,role,kind,content,ts) VALUES(?,?,?,?,?)').run(id, role, kind, content, Date.now());

// Episodic memory: keyword retrieval (swap for pgvector/embeddings later).
function recall(id, text) {
  const words = new Set(text.toLowerCase().match(/[a-z]{4,}/g) || []);
  return db.prepare('SELECT fact FROM memories WHERE persona=? ORDER BY id DESC LIMIT 200').all(id)
    .filter(m => (m.fact.toLowerCase().match(/[a-z]{4,}/g) || []).some(w => words.has(w))).slice(0, 5).map(m => m.fact);
}

function systemPrompt(p, id, userText) {
  const mem = recall(id, userText);
  return `You are ${p.name}, a fictional character in an interactive story. Stay in character at all times.
Background: ${p.bio}
Speaking tone: ${p.tone}
Scenario: ${p.scenario}
Hard boundaries: ${p.boundaries.join('; ')}. Keep content non-explicit.
Current state: ${JSON.stringify(getState(id))}
${mem.length ? 'Things you remember about the user:\n- ' + mem.join('\n- ') : ''}
Reply in 1-4 short sentences, in first person, no stage-direction headings.`;
}

// Every 4 user turns, extract state + durable facts in a background pass.
async function extract(id) {
  const h = history(id).slice(-8).map(m => `${m.role}: ${m.content}`).join('\n');
  try {
    const r = await (await venice('/chat/completions', {
      model: CHAT_MODEL, temperature: 0,
      messages: [{ role: 'user', content: `From this conversation return ONLY JSON {"affection_level":1-10,"current_location":string|null,"agreed_plans":[strings],"facts":[short durable facts about the user]}\n\n${h}` }]
    })).json();
    const j = JSON.parse(r.choices[0].message.content.match(/\{[\s\S]*\}/)[0]);
    const { facts = [], ...state } = j;
    db.prepare('INSERT OR REPLACE INTO state(persona,json) VALUES(?,?)').run(id, JSON.stringify(state));
    for (const f of facts) db.prepare('INSERT INTO memories(persona,fact,ts) VALUES(?,?,?)').run(id, String(f), Date.now());
  } catch (e) { console.warn('extract failed:', e.message); }
}

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(ok => { let b = ''; req.on('data', c => b += c); req.on('end', () => ok(b ? JSON.parse(b) : {})); });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.mp3': 'audio/mpeg' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/personas') {
      return json(res, 200, personas.map(p => { const h = history(p.id); const last = h.at(-1); return { ...p, boundaries: undefined, visual: undefined, last: last ? { content: last.kind === 'text' ? last.content : `[${last.kind}]`, ts: last.ts } : null }; }));
    }
    let m;
    if ((m = url.pathname.match(/^\/api\/chat\/(\w+)$/))) {
      const id = m[1], p = P[id]; if (!p) return json(res, 404, { error: 'unknown persona' });
      if (req.method === 'GET') return json(res, 200, { messages: db.prepare('SELECT role,kind,content,ts FROM messages WHERE persona=? ORDER BY id').all(id), state: getState(id) });
      const { text } = await readBody(req);
      save(id, 'user', 'text', text);
      const msgs = [{ role: 'system', content: systemPrompt(p, id, text) },
        ...history(id).filter(x => x.kind === 'text').map(x => ({ role: x.role === 'user' ? 'user' : 'assistant', content: x.content }))];
      const out = await (await venice('/chat/completions', { model: CHAT_MODEL, messages: msgs, temperature: 0.9, max_tokens: 300 })).json();
      const reply = out.choices[0].message.content.trim();
      save(id, 'assistant', 'text', reply);
      if (db.prepare("SELECT COUNT(*) c FROM messages WHERE persona=? AND role='user'").get(id).c % 4 === 0) extract(id);
      return json(res, 200, { reply, ts: Date.now() });
    }
    if ((m = url.pathname.match(/^\/api\/image\/(\w+)$/))) {
      const id = m[1], p = P[id]; if (!p) return json(res, 404, { error: 'unknown persona' });
      const last = history(id).filter(x => x.kind === 'text').slice(-4).map(x => x.content).join(' ');
      const prompt = `${p.visual.base_prompt}. Scene: ${p.scenario.slice(0, 160)}. Moment: ${last.slice(0, 200)}. Cinematic, tasteful, fully clothed.`;
      const r = await (await venice('/image/generate', { model: IMAGE_MODEL, prompt, seed: p.visual.seed, width: 1024, height: 640, format: 'png', safe_mode: true, return_binary: false })).json();
      const file = `${id}-${Date.now()}.png`;
      fs.writeFileSync(path.join(root, 'data/assets', file), Buffer.from(r.images[0], 'base64'));
      save(id, 'assistant', 'image', '/assets/' + file);
      return json(res, 200, { url: '/assets/' + file });
    }
    if ((m = url.pathname.match(/^\/api\/tts\/(\w+)$/)) && req.method === 'POST') {
      const p = P[m[1]]; const { text } = await readBody(req);
      const r = await venice('/audio/speech', { model: TTS_MODEL, input: text.slice(0, 1000), voice: p.voice, response_format: 'mp3' });
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
