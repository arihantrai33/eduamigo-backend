// npm run assistant:eval              keyword router only (free, no network)
// npm run assistant:eval -- --model   also asks the configured model for low-confidence questions
// npm run assistant:eval -- --model --save   also keep the result for the admin dashboard
// npm run assistant:eval -- --json    full report as JSON
require('dotenv').config();
const { evaluate } = require('../assistant/eval');

(async () => {
  const useModel = process.argv.includes('--model');
  const report = await evaluate({ useModel });
  // --save keeps a model run as the report the admin dashboard shows (it matches how the live assistant works).
  if (useModel && process.argv.includes('--save')) {
    const file = require('path').join(__dirname, '../assistant/eval/last-model-report.json');
    require('fs').writeFileSync(file, JSON.stringify({ ...report, savedAt: new Date().toISOString() }, null, 2));
    console.log(`Saved ${file}`);
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const line = (name, s) => console.log(`${name.padEnd(9)} ${String(s.questions).padStart(4)} questions | routing ${s.routingAccuracy}% | action ${s.actionAccuracy}% | both ${s.fullyCorrect}%`);
  console.log(`\nEduAmigo Ask routing evaluation (${report.mode}; answer >= ${report.thresholds.answer}, clarify >= ${report.thresholds.clarify})`);
  if (report.skipped) console.log(`${report.skipped} questions need a language model and were skipped (run with --model).`);
  line('Overall', report.overall);
  line('Dev', report.dev);
  line('Holdout', report.holdout);
  if (report.unseen.questions) line('Unseen', report.unseen);
  if (report.fresh.questions) line('Fresh', report.fresh);
  console.log('\nPer topic (all questions):');
  for (const [k, v] of Object.entries(report.overall.perTopic)) {
    console.log(`  ${k.padEnd(13)} precision ${v.precision.toFixed(2)}  recall ${v.recall.toFixed(2)}  F1 ${v.f1.toFixed(2)}  (${v.support})`);
  }
  if (report.overall.mistakes.length) {
    console.log('\nMistakes:');
    for (const m of report.overall.mistakes) {
      console.log(`  #${m.id} [${m.role}] "${m.q}" -> expected ${JSON.stringify(m.expected)}/${m.expectedAction}, got ${JSON.stringify(m.got)}/${m.gotAction} (${m.confidence})`);
    }
  }
})().catch((err) => { console.error(err); process.exit(1); });
