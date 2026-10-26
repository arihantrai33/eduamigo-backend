/* eslint-disable no-console */
// A stand-in for the Azure OpenAI service, so the Learning AI and EduAmigo Ask can be load-tested with no real provider, no cost and no
// real student text leaving the machine. It speaks the same two shapes the application uses (streaming chat and one-shot JSON).
//   node loadtests/fake-ai.js [--port 8120] [--first-token-ms 800] [--tokens-per-sec 45] [--error-rate 0]
// Point the API at it with AZURE_OPENAI_ENDPOINT=http://127.0.0.1:8120, AZURE_OPENAI_API_KEY=x, AZURE_OPENAI_DEPLOYMENT=fake.
const http = require('http');

const WORDS = ('the force acts on the object so its speed changes; first write what is given, then pick the formula, then put in the numbers, '
  + 'and check the units at the end. For example, if a body of mass 2 kg is pushed with 10 N, the acceleration is 5 metres per second squared. '
  + 'Try one more question like this on your own and compare your steps with these.').split(' ');

function start({ port = 8120, firstTokenMs = 800, tokensPerSec = 45, errorRate = 0 } = {}) {
  const stats = { requests: 0, streams: 0, json: 0, active: 0, maxActive: 0, errors: 0 };
  const rnd = () => Math.random();
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !/\/chat\/completions/.test(req.url)) { res.writeHead(404).end(); return; }
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      stats.requests += 1; stats.active += 1; stats.maxActive = Math.max(stats.maxActive, stats.active);
      let body = {}; try { body = JSON.parse(raw); } catch (e) { /* none */ }
      const done = () => { stats.active -= 1; };
      res.on('close', done);
      if (rnd() < errorRate) { stats.errors += 1; res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' }); res.end('{"error":"rate limited (simulated)"}'); return; }
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await wait(firstTokenMs * (0.6 + rnd() * 0.9));
      const count = 120 + Math.floor(rnd() * 230);
      const promptTokens = 400 + Math.floor(rnd() * 600);
      if (body.stream) {
        stats.streams += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const per = Math.max(1, Math.round(tokensPerSec / 10)); // a chunk every 100 ms
        for (let i = 0; i < count && !res.destroyed; i += per) {
          const text = Array.from({ length: Math.min(per, count - i) }, (_, k) => WORDS[(i + k) % WORDS.length]).join(' ') + ' ';
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`);
          await wait(100);
        }
        if (!res.destroyed) { res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: count } })}\n\n`); res.write('data: [DONE]\n\n'); res.end(); }
      } else {
        stats.json += 1;
        const content = body.response_format ? JSON.stringify({ ok: true, correct: true, verdict: 'correct', questions: [], score: 1 }) : WORDS.join(' ');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: promptTokens, completion_tokens: 80 } }));
      }
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, stats, close: () => new Promise((r) => server.close(r)) })));
}

module.exports = { start };
if (require.main === module) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? Number(process.argv[i + 1]) : d; };
  start({ port: arg('port', 8120), firstTokenMs: arg('first-token-ms', 800), tokensPerSec: arg('tokens-per-sec', 45), errorRate: arg('error-rate', 0) }).then(() => console.log('Fake AI listening'));
}
