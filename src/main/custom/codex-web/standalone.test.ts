import assert from 'node:assert/strict'
import test from 'node:test'
import { standaloneOptions } from './standalone'

test('standalone uses separate default ports and accepts explicit or shared ports', () => {
  assert.deepEqual(standaloneOptions([]), { port: 38471, webPort: 38472 })
  assert.deepEqual(standaloneOptions(['--', '--port', '40000', '--web-port', '40001']), {
    port: 40000,
    webPort: 40001
  })
  assert.deepEqual(standaloneOptions(['--port', '38472']), { port: 38472, webPort: 38472 })
})

test('standalone rejects unknown flags, missing values and unusable ports', () => {
  for (const args of [
    ['--unknown'],
    ['--port'],
    ['--web-port', '--port'],
    ['--port', '0'],
    ['--port', '1023'],
    ['--port', '65536'],
    ['--web-port', '3.5'],
    ['--port', '-1'],
    ['--web-port', '999999999999999999999']
  ])
    assert.throws(() => standaloneOptions(args))
})
