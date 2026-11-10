// Spins up an E2B sandbox, installs Playwright, runs a script, returns logs + screenshot.
import { Sandbox } from 'e2b';
import fs from 'node:fs';

export async function runProbe({ apiKey, log, root }) {
  const sb = await Sandbox.create({ apiKey, timeoutMs: 600000 });
  try {
    log('sandbox ' + sb.sandboxId + ' started');
    log('installing playwright + chromium (about a minute)...');
    const inst = await sb.commands.run('pip install -q playwright && playwright install --with-deps chromium 2>&1 | tail -3', { timeoutMs: 400000, user: 'root', envs: { PLAYWRIGHT_BROWSERS_PATH: '/opt/pw' } });
    log(inst.stdout.trim().split('\n').pop() || 'installed');
    await sb.files.write('/tmp/venice_probe.py', fs.readFileSync(new URL('./venice_probe.py', import.meta.url), 'utf8'));
    log('opening Venice...');
    const r = await sb.commands.run('python3 /tmp/venice_probe.py', { timeoutMs: 120000, user: 'root', envs: { PLAYWRIGHT_BROWSERS_PATH: '/opt/pw' } });
    const result = JSON.parse(r.stdout.trim().split('\n').pop());
    const shot = await sb.files.read('/tmp/shot.png', { format: 'bytes' });
    const file = `e2b-${Date.now()}.png`;
    fs.writeFileSync(`${root}/data/assets/${file}`, Buffer.from(shot));
    return { ...result, screenshot: '/assets/' + file };
  } finally { await sb.kill(); log('sandbox stopped'); }
}
