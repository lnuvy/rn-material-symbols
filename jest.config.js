const path = require('path');

module.exports = {
  projects: [
    {
      displayName: 'node',
      testEnvironment: 'node',
      // native/npm/<platform>/ are publish staging packages; Jest's haste map would otherwise resolve
      // `rn-material-symbols-scanner-native-<platform>` by package name from any directory.
      modulePathIgnorePatterns: ['<rootDir>/native/npm/', '<rootDir>/native/artifacts/'],
      testMatch: ['<rootDir>/scripts/**/*.test.ts', '<rootDir>/src/metro/**/*.test.ts', '<rootDir>/src/registry/**/*.test.ts', '<rootDir>/test/*.test.ts', '<rootDir>/test/parity/**/*.test.ts'],
      transform: { '^.+\\.[jt]sx?$': ['babel-jest', { configFile: path.join(__dirname, 'babel.node.config.js') }] },
    },
    {
      displayName: 'rn',
      preset: 'react-native',
      testMatch: ['<rootDir>/src/**/*.test.tsx', '<rootDir>/test/rn/**/*.test.tsx'],
      transformIgnorePatterns: ['node_modules/(?!(.pnpm|react-native|@react-native|react-native-svg|@react-native\\+[^/]+)/)'],
      setupFiles: ['<rootDir>/test/rn/setup.ts'],
      moduleNameMapper: { '^rn-material-symbols/registry$': '<rootDir>/test/rn/fixtureRegistry.js' },
    },
  ],
};
