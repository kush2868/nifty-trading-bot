// Jest setup file — runs before each test file
// Mock environment variables required by config/index.ts
process.env.KITE_API_KEY = 'test_api_key';
process.env.KITE_API_SECRET = 'test_api_secret';
process.env.MONGO_URI = 'mongodb://localhost:27017/nifty_bot_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
