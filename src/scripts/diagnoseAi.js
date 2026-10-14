// Why does the AI sometimes fail on this machine? Measures the phases of reaching the Azure OpenAI endpoint one by one, so a DNS
// problem, a connection timeout, a TLS error, a wrong key and a rate limit are not confused with each other.
//
//   node src/scripts/diagnoseAi.js            DNS, TCP, TLS (no AI call, no cost)
//   node src/scripts/diagnoseAi.js --call     plus one tiny real request (about 10 tokens) to see the HTTP result
//   node src/scripts/diagnoseAi.js --tries 8  repeat each phase 8 times (default 5)
//
// It reads AZURE_OPENAI_* from backend/.env. Keys and the endpoint's address are never printed; only the host name, timings and
// the kind of failure. It changes nothing on the machine (no DNS or network settings).

const dns = require('dns');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

const env = (() => {
  const file = path.join(__dirname, '../../.env');
  return fs.existsSync(file) ? require('dotenv').parse(fs.readFileSync(file)) : {};
})();
const cfg = (k) => process.env[k] || env[k] || '';
const ENDPOINT = cfg('AZURE_OPENAI_ENDPOINT').replace(/\/+$/, '');
const args = process.argv.slice(2);
const TRIES = Number(args[args.indexOf('--tries') + 1]) || 5;
const DO_CALL = args.includes('--call');
const LIMIT = 8000;

if (!ENDPOINT) { console.log('AZURE_OPENAI_ENDPOINT is not set (variable name only). Nothing to test.'); process.exit(0); }
const HOST = new URL(ENDPOINT).hostname;

const timed = async (fn) => {
  const t = Date.now();
  try { const value = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timed out'), { code: 'ETIMEOUT' })), LIMIT))]); return { ok: true, ms: Date.now() - t, value }; }
  catch (err) { return { ok: false, ms: Date.now() - t, code: err.code || err.name || 'ERROR' }; }
};
const summary = (label, runs) => {
  const ok = runs.filter((r) => r.ok); const bad = runs.filter((r) => !r.ok);
  const ms = ok.map((r) => r.ms).sort((a, b) => a - b);
  const codes = [...new Set(bad.map((r) => r.code))];
  console.log(`${label.padEnd(34)} ok ${ok.length}/${runs.length}${ms.length ? `  median ${ms[Math.floor(ms.length / 2)]} ms  max ${ms[ms.length - 1]} ms` : ''}${bad.length ? `  FAILED: ${codes.join(', ')}` : ''}`);
};
const repeat = async (n, fn) => { const out = []; for (let i = 0; i < n; i += 1) out.push(await timed(fn)); return out; };
const resolverAt = (server) => { const r = new dns.promises.Resolver({ timeout: 3000, tries: 1 }); r.setServers([server]); return r; };

(async () => {
  console.log(`Host: ${HOST}   (${new Date().toISOString()})`);
  const system = dns.getServers();
  console.log(`Resolvers this machine is configured with: ${system.join(', ') || '(none)'}\n`);

  console.log('1. DNS (resolving the host name)');
  summary('system lookup (what the app uses)', await repeat(TRIES, () => dns.promises.lookup(HOST)));
  for (const s of system.slice(0, 2)) summary(`configured resolver ${s}`, await repeat(TRIES, () => resolverAt(s).resolve4(HOST)));
  for (const s of ['8.8.8.8', '1.1.1.1']) summary(`public resolver ${s}`, await repeat(TRIES, () => resolverAt(s).resolve4(HOST)));

  // An address to test the next phases with, from whichever resolver works.
  let ip = null;
  for (const s of ['8.8.8.8', '1.1.1.1', ...system]) { const r = await timed(() => resolverAt(s).resolve4(HOST)); if (r.ok && r.value?.[0]) { ip = r.value[0]; break; } }
  if (!ip) { console.log('\nNo resolver could resolve the host: the machine has no working internet or DNS at this moment.'); return; }

  console.log('\n2. TCP connect to port 443 (address from a working resolver)');
  summary('tcp connect', await repeat(TRIES, () => new Promise((res, rej) => { const s = net.connect({ host: ip, port: 443 }); s.once('connect', () => { s.destroy(); res(); }); s.once('error', rej); })));

  console.log('\n3. TLS handshake (certificate check)');
  summary('tls handshake', await repeat(TRIES, () => new Promise((res, rej) => { const s = tls.connect({ host: ip, port: 443, servername: HOST }, () => { const ok = s.authorized; s.destroy(); ok ? res() : rej(Object.assign(new Error('bad cert'), { code: s.authorizationError || 'CERT' })); }); s.once('error', rej); })));

  console.log('\n4. HTTPS request through the same path the app uses (system DNS)');
  const reach = await repeat(TRIES, async () => { const r = await fetch(`${ENDPOINT}/openai/models?api-version=${cfg('AZURE_OPENAI_API_VERSION') || '2024-10-21'}`, { signal: AbortSignal.timeout(LIMIT) }); return r.status; });
  summary('GET (no key: 401/404 = reachable)', reach);
  console.log(`   statuses seen: ${[...new Set(reach.filter((r) => r.ok).map((r) => r.value))].join(', ') || 'none'}`);

  if (DO_CALL) {
    console.log('\n5. One tiny real request (about 10 tokens, paid)');
    const dep = cfg('AZURE_OPENAI_DEPLOYMENT'); const key = cfg('AZURE_OPENAI_API_KEY');
    if (!dep || !key) { console.log(`   Missing: ${!dep ? 'AZURE_OPENAI_DEPLOYMENT ' : ''}${!key ? 'AZURE_OPENAI_API_KEY' : ''}`); return; }
    const t = Date.now();
    try {
      const r = await fetch(`${ENDPOINT}/openai/deployments/${encodeURIComponent(dep)}/chat/completions?api-version=${cfg('AZURE_OPENAI_API_VERSION') || '2024-10-21'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'api-key': key }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 5 }), signal: AbortSignal.timeout(15000),
      });
      const kind = r.status === 200 ? 'success' : r.status === 401 || r.status === 403 ? 'authentication/permission (check the key)' : r.status === 404 ? 'deployment or endpoint not found (check the configuration)' : r.status === 429 ? `rate limited (retry-after: ${r.headers.get('retry-after') || 'n/a'})` : r.status >= 500 ? 'provider error' : 'rejected request';
      console.log(`   HTTP ${r.status} in ${Date.now() - t} ms: ${kind}`);
    } catch (err) {
      console.log(`   FAILED after ${Date.now() - t} ms: ${err.cause?.code || err.code || err.name} (${err.message})`);
    }
  }
})();
