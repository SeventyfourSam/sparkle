import assert from 'node:assert/strict'
import test from 'node:test'
import { continueReleaseQueue, createQueueApi, type QueueApi } from './release-queue'

const repo = 'SeventyfourSam/sparkle'
const now = Date.parse('2026-11-12T15:00:00Z')

function fixture() {
  const run = {
    id: 42,
    path: '.github/workflows/custom-release.yml',
    event: 'workflow_dispatch',
    head_branch: 'custom',
    head_repository: { full_name: repo },
    status: 'completed',
    conclusion: 'failure',
    run_attempt: 4,
    created_at: '2026-11-12T12:00:00Z'
  }
  const jobs = [
    {
      id: 1,
      name: 'prepare',
      status: 'completed',
      conclusion: 'success',
      steps: [] as { status: string }[]
    },
    {
      id: 2,
      name: 'build (windows-latest, x64, build:win)',
      status: 'completed',
      conclusion: 'success',
      steps: [] as { status: string }[]
    },
    {
      id: 3,
      name: 'build (macos-26, arm64, build:mac)',
      status: 'completed',
      conclusion: 'cancelled',
      steps: [] as { status: string }[]
    }
  ]
  const annotations = [
    { message: 'The job was not acquired by Runner of type hosted even after multiple attempts' }
  ]
  const writes: { endpoint: string; body: unknown }[] = []
  const reads: string[] = []
  let newestId = 42
  let supersededId: number | undefined
  let refreshedRun: Partial<typeof run> = {}
  let listReads = 0
  let runReads = 0
  const api: QueueApi = {
    get: async <T>(endpoint: string): Promise<T> => {
      reads.push(endpoint)
      let value: unknown
      if (endpoint.includes('/workflows/custom-release.yml/runs?')) {
        listReads++
        value = {
          workflow_runs: [{ ...run, id: listReads > 1 ? (supersededId ?? newestId) : newestId }]
        }
      } else if (endpoint === `repos/${repo}/actions/runs/42`) {
        runReads++
        value = runReads > 1 ? { ...run, ...refreshedRun } : run
      } else if (endpoint.endsWith('/jobs?filter=latest&per_page=100')) value = { jobs }
      else if (endpoint.endsWith('/actions/jobs/3')) {
        value = { check_run_url: `https://api.github.com/repos/${repo}/check-runs/3` }
      } else if (endpoint.endsWith('/check-runs/3/annotations?per_page=100')) value = annotations
      else throw new Error(`Unexpected request: ${endpoint}`)
      return structuredClone(value) as T
    },
    post: async (endpoint, body) => {
      writes.push({ endpoint, body })
    }
  }
  return {
    run,
    jobs,
    annotations,
    writes,
    reads,
    api,
    set newestId(value: number) {
      newestId = value
    },
    set supersededId(value: number) {
      supersededId = value
    },
    set refreshedRun(value: Partial<typeof run>) {
      refreshedRun = value
    }
  }
}

test('an allocation timeout requeues only macOS and preserves successful Windows outputs', async () => {
  const f = fixture()
  const result = await continueReleaseQueue(f.api, 42, now)
  assert.equal(result.action, 'requeued')
  assert.deepEqual(f.writes, [{ endpoint: `repos/${repo}/actions/jobs/3/rerun`, body: undefined }])
})

test('waiting and running jobs are left in the queue without cancellation or restart', async () => {
  for (const status of ['queued', 'waiting', 'in_progress']) {
    const f = fixture()
    f.run.status = status
    assert.equal((await continueReleaseQueue(f.api, undefined, now)).action, 'waiting')
    assert.equal(f.writes.length, 0)
    assert.equal(f.reads.length, 2)
  }
})

test('repeated capacity timeouts do not stop after three attempts', async () => {
  for (const attempt of [4, 10, 49]) {
    const f = fixture()
    f.run.run_attempt = attempt
    assert.equal((await continueReleaseQueue(f.api, 42, now)).action, 'requeued')
  }
})

test('GitHub rerun and age limits renew the release round instead of abandoning it', async () => {
  for (const expired of ['attempts', 'age']) {
    const f = fixture()
    if (expired === 'attempts') f.run.run_attempt = 50
    else f.run.created_at = new Date(now - 30 * 24 * 60 * 60_000).toISOString()
    f.jobs[2].name = 'build (macos-15, arm64, build:mac)'
    assert.equal((await continueReleaseQueue(f.api, 42, now)).action, 'renewed')
    assert.deepEqual(f.writes, [
      {
        endpoint: `repos/${repo}/actions/workflows/custom-release.yml/dispatches`,
        body: { ref: 'custom', inputs: { macos_runner: 'macos-15' } }
      }
    ])
  }
})

test('manual cancellation and successful completion stop automatic continuation', async () => {
  for (const conclusion of ['cancelled', 'success']) {
    const f = fixture()
    f.run.conclusion = conclusion
    const result = await continueReleaseQueue(f.api, 42, now)
    assert.equal(result.action, conclusion === 'success' ? 'finished' : 'ignored')
    assert.equal(f.writes.length, 0)
  }
})

test('compiler/test failures and jobs that started execution are never blindly retried', async () => {
  for (const failure of ['mac', 'windows', 'prepare', 'started', 'in-progress']) {
    const f = fixture()
    if (failure === 'mac') f.jobs[2].conclusion = 'failure'
    if (failure === 'windows') f.jobs[1].conclusion = 'failure'
    if (failure === 'prepare') f.jobs[0].conclusion = 'failure'
    if (failure === 'started') f.jobs[2].steps = [{ status: 'completed' }]
    if (failure === 'in-progress') f.jobs[2].steps = [{ status: 'in_progress' }]
    assert.equal((await continueReleaseQueue(f.api, 42, now)).action, 'ignored')
    assert.equal(f.writes.length, 0)
  }
})

test('a generic capacity warning alone is insufficient to retry a cancelled job', async () => {
  const f = fixture()
  f.annotations[0].message = 'Due to capacity constraints, jobs may experience longer queue times.'
  assert.equal((await continueReleaseQueue(f.api, 42, now)).action, 'ignored')
  assert.equal(f.writes.length, 0)
})

test('completion events from older releases cannot resurrect superseded runs', async () => {
  const f = fixture()
  f.newestId = 43
  assert.equal((await continueReleaseQueue(f.api, 42, now)).action, 'ignored')
  assert.equal(f.writes.length, 0)
  assert.equal(f.reads.length, 1)
})

test('new releases or manual retries that win a race are respected before mutation', async () => {
  for (const change of ['new-release', 'active', 'attempt']) {
    const f = fixture()
    if (change === 'new-release') f.supersededId = 43
    if (change === 'active') f.refreshedRun = { status: 'queued' }
    if (change === 'attempt') f.refreshedRun = { run_attempt: 5 }
    assert.equal((await continueReleaseQueue(f.api, 42, now)).action, 'waiting')
    assert.equal(f.writes.length, 0)
  }
})

test('foreign branches, forks, events and workflow files cannot trigger privileged continuation', async () => {
  for (const change of ['branch', 'fork', 'event', 'workflow']) {
    const f = fixture()
    if (change === 'branch') f.run.head_branch = 'pull-request'
    if (change === 'fork') f.run.head_repository.full_name = 'someone/fork'
    if (change === 'event') f.run.event = 'pull_request'
    if (change === 'workflow') f.run.path = '.github/workflows/something-else.yml'
    assert.equal((await continueReleaseQueue(f.api, 42, now)).action, 'ignored')
    assert.equal(f.writes.length, 0)
  }
})

test('GitHub accepts rerun requests without returning a JSON body', async () => {
  for (const status of [201, 202, 204]) {
    const api = createQueueApi('test-token', async (url, init) => {
      assert.equal(
        String(url),
        'https://api.github.com/repos/SeventyfourSam/sparkle/actions/jobs/3/rerun'
      )
      assert.equal(init?.method, 'POST')
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-token')
      return new Response(null, { status })
    })
    await api.post(`repos/${repo}/actions/jobs/3/rerun`)
  }
})

test('the cloud client reads job metadata and retains actionable API failure messages', async () => {
  const api = createQueueApi('test-token', async (_url, init) => {
    if (init?.method === 'GET') return new Response('{"run_attempt":4}')
    return new Response('{"message":"Resource not accessible by integration"}', { status: 403 })
  })
  assert.deepEqual(await api.get(`repos/${repo}/actions/runs/42`), { run_attempt: 4 })
  await assert.rejects(
    api.post(`repos/${repo}/actions/jobs/3/rerun`),
    /403.*Resource not accessible/
  )
})
