require('dotenv').config({ quiet: true });
require('./src/config/tenantGuard'); // must run before any model is compiled
const mongoose = require('mongoose');
const { assertEnv } = require('./src/config/env');
const buildApp = require('./src/app');

async function start() {
  assertEnv();
  if (!require('./src/services/email').isConfigured()) {
    console.warn('Email is not configured (EMAIL_PROVIDER): password reset codes will not be sent.');
  }
  await mongoose.connect(process.env.MONGO_URI);
  console.log('MongoDB connected');

  if (process.env.DISABLE_JOBS !== 'true') {
    require('./src/jobs/feeReminder')();
    require('./src/jobs/noteProcessingJob')();
    require('./src/jobs/busTrips')();
  }

  const port = process.env.PORT || 5000;
  const server = buildApp().listen(port, () => console.log(`Server running on port ${port}`));

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close(() => mongoose.connection.close().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
