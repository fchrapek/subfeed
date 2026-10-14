#!/usr/bin/env node
// Turn a password into the SUBFEED_PASSWORD_HASH value. The password is typed
// without echo (or piped on stdin) and never stored anywhere.
//
//   npm run hash-password
//   docker run --rm -it subfeed node scripts/hash-password.mjs
//
// Output format: scrypt:<N>:<r>:<p>:<salt hex>:<key hex> (parsed in server/auth.ts).

import { randomBytes, scryptSync } from 'node:crypto'
import { createInterface } from 'node:readline'

const N = 2 ** 15
const r = 8
const p = 1
const MIN_LENGTH = 12

async function readPassword() {
  if (!process.stdin.isTTY) {
    let input = ''
    for await (const chunk of process.stdin) input += chunk
    return input.replace(/\r?\n$/, '')
  }
  const ask = (prompt) =>
    new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
      // Hide what is typed: print the prompt once, swallow the echo.
      rl._writeToOutput = (s) => {
        if (s.includes(prompt)) process.stdout.write(prompt)
      }
      rl.question(prompt, (answer) => {
        rl.close()
        process.stdout.write('\n')
        resolve(answer)
      })
    })
  const first = await ask('Password: ')
  const second = await ask('Again: ')
  if (first !== second) {
    console.error('The two passwords differ.')
    process.exit(1)
  }
  return first
}

const password = await readPassword()
if (password.length < MIN_LENGTH) {
  console.error(`Use at least ${MIN_LENGTH} characters. A few random words work well.`)
  process.exit(1)
}
const salt = randomBytes(16)
const key = scryptSync(password, salt, 32, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 })
console.log(`SUBFEED_PASSWORD_HASH=scrypt:${N}:${r}:${p}:${salt.toString('hex')}:${key.toString('hex')}`)
