/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/__tests__'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/__tests__/**',
    '!src/backtest/run.ts',
    '!src/app.ts',
  ],
  coverageReporters: ['text', 'lcov'],
  setupFiles: ['<rootDir>/src/__tests__/setup.ts'],
};
