const {resolve} = require('node:path');

module.exports = {
  preset: 'react-native',
  testEnvironment: '@pkg-nec/jest-environment-node',
  testEnvironmentOptions: {
    customExportConditions: ['require', 'react-native'],
    globalsCleanup: 'soft',
  },
  // this is specific to the Jest repo, not generally needed (the files we ignore will be in node_modules which is ignored by default)
  transformIgnorePatterns: [resolve(__dirname, '../../packages')],
};
