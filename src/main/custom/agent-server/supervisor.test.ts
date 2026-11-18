import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AgentServerSupervisor } from './supervisor'
import { defaultAgentServerOptions, validateAgentServerOptions } from '../../../shared/agent-server'

const delay = (ms = 10) => new Promise((done) => setTimeout(done, ms))
async function waitFor(predicate: () => boolean): Promise<void> {
  const until = Date.now() + 6000
  while (!predicate()) {
    assert(Date.now() < until, 'Supervisor state timed out')
    await delay()
  }
}
const program = `
const fs = require('node:fs');
const args = process.argv.slice(2), log = __LOG_FILE__;
fs.writeFileSync(log, JSON.stringify(args));
const port = Number(args[args.indexOf('--port') + 1]);
const webPort = Number(args[args.indexOf('--web-port') + 1]);
process.stdin.resume();
process.stdin.on('end', () => { fs.writeFileSync(log + '.exit-' + process.pid, 'graceful'); process.exit(0) });
__READY__
`
const ready = `console.log('AGENT_SERVER_READY ' + JSON.stringify({protocolVersion:1,pid:process.pid,port,webPort}));`

async function fixture(
  body = ready,
  extra: ConstructorParameters<typeof AgentServerSupervisor>[0] = {}
) {
  const directory = await mkdtemp(join(tmpdir(), 'agent supervisor '))
  const file = join(directory, 'fixture.cjs'),
    log = join(directory, 'args.json')
  await writeFile(
    file,
    program.replace('__LOG_FILE__', JSON.stringify(log)).replace('__READY__', body)
  )
  let starts = 0
  const supervisor = new AgentServerSupervisor({
    startupMs: 500,
    stopMs: 300,
    retryMs: 10,
    maxRetries: 2,
    launch: (executable, args, env) => {
      starts++
      assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
      assert.equal(env.NODE_OPTIONS, undefined)
      return spawn(executable, [file, ...args], {
        env,
        cwd: directory,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    },
    ...extra
  })
  return {
    directory,
    log,
    supervisor,
    starts: () => starts,
    options: { ...defaultAgentServerOptions(), enabled: true, executable: process.execPath },
    close: async () => {
      await supervisor.stop()
      await rm(directory, { recursive: true, force: true })
    }
  }
}

test('managed startup passes separate ports, reuses a child, restarts on edits and shuts down by EOF', async () => {
  const f = await fixture()
  try {
    await f.supervisor.configure(f.options)
    await waitFor(() => f.supervisor.snapshot().state === 'running')
    const original = f.supervisor.snapshot().pid!
    assert.deepEqual(JSON.parse(await readFile(f.log, 'utf8')), [
      '--managed',
      '--port',
      '38471',
      '--web-port',
      '38472'
    ])
    await f.supervisor.configure(f.options)
    assert.equal(f.starts(), 1)
    await f.supervisor.configure({ ...f.options, webPort: 39002 })
    await waitFor(() => f.supervisor.snapshot().state === 'running')
    assert.equal(await readFile(f.log + '.exit-' + original, 'utf8'), 'graceful')
    assert.notEqual(f.supervisor.snapshot().pid, original)
    assert.equal(f.starts(), 2)
    const current = f.supervisor.snapshot().pid!
    await f.supervisor.configure({ ...f.options, enabled: false })
    assert.equal(f.supervisor.snapshot().state, 'stopped')
    assert.equal(await readFile(f.log + '.exit-' + current, 'utf8'), 'graceful')
  } finally {
    await f.close()
  }
})

test('invalid paths and failed persistence preserve the old running process and ports', async () => {
  let refuse = false
  const f = await fixture(ready, {
    save: async () => {
      if (refuse) throw new Error('disk failed')
    }
  })
  try {
    await f.supervisor.configure(f.options)
    await waitFor(() => f.supervisor.snapshot().state === 'running')
    const pid = f.supervisor.snapshot().pid!
    refuse = true
    await assert.rejects(f.supervisor.configure({ ...f.options, port: 39001 }), /disk failed/)
    await assert.rejects(
      f.supervisor.configure({ ...f.options, executable: join(f.directory, 'missing.exe') })
    )
    assert.equal(f.supervisor.snapshot().pid, pid)
    assert.equal(f.supervisor.snapshot().options.port, f.options.port)
    await assert.rejects(access(f.log + '.exit-' + pid))
  } finally {
    await f.close()
  }
})

test('unexpected exits retry with a budget; disabling cancels pending retries', async () => {
  const f = await fixture(ready + '\nsetTimeout(() => process.exit(9), 30)')
  try {
    await f.supervisor.configure(f.options)
    await waitFor(() => f.supervisor.snapshot().state === 'error')
    assert.equal(f.starts(), 3)
    assert.match(f.supervisor.snapshot().error!, /9/)
    await f.supervisor.configure({ ...f.options, enabled: false })
    await delay(100)
    assert.equal(f.starts(), 3)
    assert.equal(f.supervisor.snapshot().state, 'stopped')
  } finally {
    await f.close()
  }
})

test('a process without the managed ready handshake times out and is closed gracefully', async () => {
  const f = await fixture('', { maxRetries: 0, startupMs: 100 })
  try {
    await f.supervisor.configure(f.options)
    await waitFor(() => f.supervisor.snapshot().state === 'error')
    assert.match(f.supervisor.snapshot().error!, /启动超时/)
    assert.equal(f.supervisor.snapshot().pid, undefined)
  } finally {
    await f.close()
  }
})

test('stopping during a pending save cannot launch a child afterwards', async () => {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((done) => {
    enter = done
  })
  const gate = new Promise<void>((done) => {
    release = done
  })
  const f = await fixture(ready, {
    save: async () => {
      enter()
      await gate
    }
  })
  try {
    const starting = f.supervisor.configure(f.options)
    const rejected = assert.rejects(starting, /退出/)
    await entered
    const stopping = f.supervisor.stop()
    release()
    await rejected
    await stopping
    assert.equal(f.starts(), 0)
  } finally {
    await f.close()
  }
})

test('external settings reject invalid ports, shared ports and missing executables', async () => {
  assert.throws(() => validateAgentServerOptions({ ...defaultAgentServerOptions(), enabled: true }))
  assert.throws(() => validateAgentServerOptions({ ...defaultAgentServerOptions(), port: 0 }))
  assert.throws(() =>
    validateAgentServerOptions({ ...defaultAgentServerOptions(), webPort: 38471 })
  )
  const supervisor = new AgentServerSupervisor()
  try {
    await assert.rejects(
      supervisor.configure(
        {
          ...defaultAgentServerOptions(),
          enabled: true,
          executable: join(tmpdir(), 'nonexistent-agent-server.exe')
        },
        false
      )
    )
    assert.equal(supervisor.snapshot().state, 'error')
    assert.match(supervisor.snapshot().error!, /ENOENT/)
  } finally {
    await supervisor.stop()
  }
})

test('restart queued behind a configuration change uses the latest committed ports', async () => {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((done) => {
    enter = done
  })
  const gate = new Promise<void>((done) => {
    release = done
  })
  const f = await fixture(ready, {
    save: async () => {
      enter()
      await gate
    }
  })
  try {
    const changed = f.supervisor.configure({ ...f.options, port: 39005 })
    await entered
    const restarted = f.supervisor.restart()
    release()
    await changed
    await restarted
    await waitFor(() => f.supervisor.snapshot().state === 'running')
    assert.equal(f.supervisor.snapshot().options.port, 39005)
    const args = JSON.parse(await readFile(f.log, 'utf8'))
    assert.equal(args[args.indexOf('--port') + 1], '39005')
  } finally {
    await f.close()
  }
})
