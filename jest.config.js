module.exports = {
  restoreMocks: true,
  resetMocks: true,
  setupFilesAfterEnv: ['./test/setup.ts'],
  testEnvironment: 'node',
  testPathIgnorePatterns: ['/node_modules/'],
  testRunner: 'jest-circus/runner',
  testTimeout: 60000,
  verbose: false
};
