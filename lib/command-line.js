'use strict';

function parseCommandLine(command) {
  const text = String(command || '').trim();
  if (!text) throw new Error('command is empty');

  const args = [];
  let value = '';
  let quote = null;
  let started = false;

  const push = () => {
    if (!started) return;
    args.push(value);
    value = '';
    started = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === '\\' && text[index + 1] === quote) {
        value += quote;
        started = true;
        index += 1;
      } else if (character === quote) {
        quote = null;
      } else {
        value += character;
        started = true;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      push();
    } else if (character === '|' || character === '&' || character === ';' || character === '<' || character === '>') {
      throw new Error(`shell operator "${character}" requires --allow-shell`);
    } else {
      value += character;
      started = true;
    }
  }

  if (quote) throw new Error('unterminated quoted argument');
  push();
  if (!args.length || !args[0]) throw new Error('command executable is empty');
  return args;
}

module.exports = { parseCommandLine };
