// Smoke run on this machine: an in-memory MongoDB, a small seed, the server on :8100. For checking that the scripts work.
// Numbers from this are NOT capacity figures (one laptop, no network, no real database).
//   node loadtests/local.js [--students 100]        then, in another terminal:  BASE_URL=http://localhost:8100 k6 run loadtests/k6/<script>.js
const { spawn } = require('child_process');
const path = require('path');

async function main() {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongo = await MongoMemoryServer.create();
  const uri = `${mongo.getUri()}smoke_loadtest`;
  const students = process.argv.includes('--students') ? process.argv[process.argv.indexOf('--students') + 1] : '100';
  const env = {
    ...process.env, MONGO_URI: uri, NODE_ENV: 'development', PORT: '8100', LOADTEST_SEED_OK: 'yes', BCRYPT_ROUNDS: '4',
    JWT_SECRET: process.env.JWT_SECRET || 'smoke-test-secret-that-is-long-enough-123456', DISABLE_JOBS: 'true',
    // No AI provider is configured here, so a smoke run never calls a paid service.
    GEMINI_API_KEY: '', AZURE_OPENAI_API_KEY: '', AZURE_OPENAI_ENDPOINT: '',
    API_ANON_PER_MINUTE: '1000000', API_USER_PER_MINUTE: '1000000', RATE_LIMIT_STORE: 'mongo',
  };
  // Asynchronously: the in-memory database is a child of this process and stops answering if this process blocks.
  const seeded = await new Promise((resolve) => spawn('node', [path.join(__dirname, 'seed.js'), '--students', students], { env, stdio: 'inherit' }).on('exit', resolve));
  if (seeded !== 0) { await mongo.stop(); process.exit(1); }
  const server = spawn('node', [path.join(__dirname, '../server.js')], { env, stdio: 'inherit' });
  const stop = async () => { server.kill(); await mongo.stop(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  console.log(`\nReady: server on http://localhost:8100, database ${uri}`);
  console.log('Verify afterwards with: MONGO_URI=' + uri + ' node loadtests/verify.js');
}

main().catch((err) => { console.error(err); process.exit(1); });
