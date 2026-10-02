// Starts a throwaway MongoDB for the test run.
// - If MONGO_TEST_URI is set (CI service container, FerretDB, local mongod), it is used as-is.
//   Set TEST_DB_IS_REAL_MONGO=true as well when that database is a real MongoDB.
// - Otherwise mongodb-memory-server downloads and runs a temporary mongod.
module.exports = async () => {
  if (process.env.MONGO_TEST_URI) return;
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const server = await MongoMemoryServer.create();
  globalThis.__MONGO_SERVER__ = server;
  process.env.MONGO_TEST_URI = server.getUri();
  process.env.TEST_DB_IS_REAL_MONGO = 'true'; // a real mongod, so atomicity tests can run
};
