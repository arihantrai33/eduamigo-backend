process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
process.env.BCRYPT_ROUNDS = '4'; // fast hashing for tests; production uses 10

require('../src/config/tenantGuard'); // register before test files compile any model
