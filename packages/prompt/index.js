'use strict';

const { createInterface } = require('node:readline/promises');

async function question(message) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question(message)).trim();
  } finally {
    prompt.close();
  }
}

module.exports = { question };
