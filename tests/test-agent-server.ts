// Agent Server 集成测试 — 启动后验证所有端点
import * as http from 'http';

const PORT = 19701;
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0, failed = 0;

function ok(name: string, detail?: string) { passed++; console.log('  ✓', name + (detail ? ' (' + detail + ')' : '')); }
function fail(name: string, detail?: string) { failed++; console.log('  ✗', name + (detail ? ': ' + detail : '')); }

function get(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(BASE + path, { timeout: 10000 }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    }).on('error', reject).on('timeout', function(this: any) { this.destroy(); reject(new Error('timeout')); });
  });
}

function post(path: string, data: any): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const req = http.request(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 30000,
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('error', reject);
    req.on('timeout', function(this: any) { this.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('\n═══════════════════════════════════');
  console.log('  Agent Server 集成测试');
  console.log('═══════════════════════════════════\n');

  // 1. GET / (HTML page)
  console.log('── 1. Static page ──');
  try {
    const r = await get('/');
    r.status === 200 ? ok('GET /', r.body.length + 'B') : fail('GET /', 'HTTP ' + r.status);
    r.body.includes('Agent Chat') ? ok('HTML contains title') : fail('HTML title');
    r.body.includes('/api/chat') ? ok('HTML has /api/chat') : fail('HTML missing /api/chat');
    r.body.includes('/api/events') ? ok('HTML has SSE') : fail('HTML missing SSE');
  } catch (e: any) { fail('GET /', e.message); }

  // 2. GET /api/status (should work even during init)
  console.log('\n── 2. Status API ──');
  try {
    const r = await get('/api/status');
    const j = JSON.parse(r.body);
    r.status === 200 ? ok('GET /api/status', j.status) : fail('status', 'HTTP ' + r.status);
    typeof j.ready === 'boolean' ? ok('ready field', String(j.ready)) : fail('no ready field');
  } catch (e: any) { fail('status', e.message); }

  // 3. POST /api/chat during init (should return 503)
  console.log('\n── 3. Chat during init ──');
  try {
    const r = await post('/api/chat', { message: '/status' });
    if (r.status === 503) {
      ok('503 during init', JSON.parse(r.body).reply);
    } else if (r.status === 200) {
      const j = JSON.parse(r.body);
      ok('Agent already ready', j.reply.slice(0, 60));
    } else {
      fail('chat', 'HTTP ' + r.status);
    }
  } catch (e: any) { fail('chat', e.message); }

  // 4. Wait for agent to be ready, then test full chat
  console.log('\n── 4. Wait for ready ──');
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await get('/api/status');
      const j = JSON.parse(r.body);
      if (j.ready) { ready = true; console.log('  Agent ready after ' + (i + 1) * 2 + 's'); break; }
    } catch {}
    await sleep(2000);
  }
  if (!ready) { fail('Agent never ready'); console.log('  (model likely dead, tests continue)'); }

  // 5. POST /api/chat with /status command
  console.log('\n── 5. Chat /status ──');
  try {
    const r = await post('/api/chat', { message: '/status' });
    const j = JSON.parse(r.body);
    if (r.status === 200) {
      ok('POST /api/chat', j.reply.split('\n')[0] + ' (' + j.duration + 'ms)');
      j.reply.includes('Agent') ? ok('reply has Agent') : fail('reply missing Agent');
    } else if (r.status === 503) {
      ok('Still initializing (503)', j.reply);
    } else {
      fail('chat /status', 'HTTP ' + r.status + ' ' + (j.error || ''));
    }
  } catch (e: any) { fail('chat /status', e.message); }

  // 6. POST with missing message field
  console.log('\n── 6. Error handling ──');
  try {
    const r = await post('/api/chat', {});
    r.status === 400 ? ok('400 on missing message') : fail('expected 400, got ' + r.status);
  } catch (e: any) { fail('error handling', e.message); }

  // 7. CORS headers
  console.log('\n── 7. CORS ──');
  try {
    const r = await get('/api/status');
    ok('CORS GET works', 'HTTP ' + r.status);
    // OPTIONS preflight
    const ro = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(BASE + '/api/chat', { method: 'OPTIONS', timeout: 5000 }, resolve);
      req.on('error', reject);
      req.end();
    });
    const acao = ro.headers['access-control-allow-origin'];
    acao === '*' ? ok('CORS Allow-Origin: *') : fail('CORS', 'Allow-Origin=' + acao);
  } catch (e: any) { fail('CORS', e.message); }

  console.log('\n═══════════════════════════════════');
  const tot = passed + failed;
  console.log('  Result: ' + passed + '/' + tot + ' (' + Math.round(passed / tot * 100) + '%)');
  console.log('═══════════════════════════════════');
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
