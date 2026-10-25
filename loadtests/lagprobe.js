// Preloaded into the test server by stage.js (node --require). Records how late the event loop runs, every 2 seconds, into $LAG_FILE.
// A request handled while the loop is blocked waits at least that long, so this shows blocking that CPU figures alone cannot.
const { monitorEventLoopDelay } = require('perf_hooks');
const fs = require('fs');

if (process.env.LAG_FILE) {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const rows = [];
  let t = 0;
  setInterval(() => {
    t += 2;
    rows.push({ t, p50: +(h.percentile(50) / 1e6).toFixed(1), p99: +(h.percentile(99) / 1e6).toFixed(1), max: +(h.max / 1e6).toFixed(1) });
    h.reset();
    try { fs.writeFileSync(process.env.LAG_FILE, JSON.stringify(rows)); } catch (e) { /* the run folder is gone */ }
  }, 2000).unref();
}
