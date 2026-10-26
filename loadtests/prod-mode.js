/* eslint-disable no-console */
// The API exactly as it runs in production (NODE_ENV=production, production rate limits, error masking, strict CORS), on a throwaway
// in-memory database with synthetic schools, so the production build of the website can be tested against it on this machine.
//   node loadtests/prod-mode.js [--port 8111] [--web-origin http://127.0.0.1:4173]       (stop with Ctrl-C; everything is deleted)
// Sign-in details are written to loadtests/data/prodmode-seed.json (git-ignored). Nothing external is contacted: e-mail goes to the log,
// photos to a local folder, AI/payment/storage keys are blank, background jobs are off.
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const PORT = arg('port', '8111');
const ORIGIN = arg('web-origin', 'http://127.0.0.1:4173');
const SEED = path.join(__dirname, 'data/prodmode-seed.json');
const AI_URL = arg('ai-url', ''); // e.g. http://127.0.0.1:8120 (loadtests/fake-ai.js); empty keeps the AI switched off

async function main() {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongo = await MongoMemoryServer.create();
  const uri = `${mongo.getUri()}prodmode_loadtest`;
  const env = {
    ...process.env, MONGO_URI: uri, NODE_ENV: 'production', PORT, DISABLE_JOBS: 'true', LOADTEST_SEED_OK: 'yes', BCRYPT_ROUNDS: '10',
    JWT_SECRET: crypto.randomBytes(32).toString('hex'), DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    CORS_ORIGINS: ORIGIN, PUBLIC_API_URL: `http://127.0.0.1:${PORT}`, EMAIL_PROVIDER: 'log', PHOTO_STORAGE: 'local', SMS_PROVIDER: 'off',
    GEMINI_API_KEY: '', AZURE_OPENAI_API_KEY: '', AZURE_OPENAI_ENDPOINT: '', AZURE_SPEECH_KEY: '', ASSISTANT_PROVIDERS: '',
    CLOUDINARY_CLOUD_NAME: '', CLOUDINARY_API_KEY: '', CLOUDINARY_API_SECRET: '', RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '',
    RATE_LIMIT_STORE: 'mongo', ROUTING_URL: 'off',
    ...(AI_URL ? { AZURE_OPENAI_ENDPOINT: AI_URL, AZURE_OPENAI_API_KEY: 'fake', AZURE_OPENAI_DEPLOYMENT: 'fake', ASSISTANT_PROVIDERS: 'azure', LEARNING_VECTOR_SEARCH: 'off' } : {}),
  };
  const seeded = await new Promise((resolve) => spawn('node', [path.join(__dirname, 'seed.js'), '--schools', '2', '--students', '100', '--out', SEED], { env, stdio: 'inherit' }).on('exit', resolve));
  if (seeded !== 0) { await mongo.stop(); process.exit(1); }
  const server = spawn('node', [path.join(__dirname, '../server.js')], { env, stdio: 'inherit' });
  const stop = async () => { server.kill(); await mongo.stop(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  console.log(`\nProduction-mode API on http://127.0.0.1:${PORT} (allowed website: ${ORIGIN}). Sign-ins: ${SEED}. Ctrl-C to stop.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
