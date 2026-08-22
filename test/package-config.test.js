'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const packageJson = require('../package.json');

test('Windows portable build excludes local state and credentials', () => {
  const files = packageJson.build.files;
  for (const pattern of [
    '!.agents{,/**}',
    '!.claude{,/**}',
    '!.codex{,/**}',
    '!.grok{,/**}',
    '!.kimi-code{,/**}',
    '!.workbuddy{,/**}',
    '!config.json',
    '!**/*.db*',
  ]) {
    assert.ok(files.includes(pattern), `missing package exclusion: ${pattern}`);
  }
  assert.deepEqual(packageJson.build.win.target, [{ target: 'portable', arch: ['x64'] }]);
});
