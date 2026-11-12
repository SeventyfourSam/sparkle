import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = 'SeventyfourSam/sparkle'
const workflow = 'custom-release.yml'
const workflowPath = `.github/workflows/${workflow}`
const workflowRuns = `repos/${repository}/actions/workflows/${workflow}/runs?branch=custom&per_page=1`

interface ReleaseRun {
  id: number
  path: string
  event: string
  head_branch: string
  head_repository: { full_name: string } | null
  status: string
  conclusion: string | null
  run_attempt: number
  created_at: string
}

interface ReleaseJob {
  id: number
  name: string
  status: string
  conclusion: string | null
  steps?: { status: string }[]
}

export interface QueueApi {
  get<T>(endpoint: string): Promise<T>
  post(endpoint: string, body?: unknown): Promise<void>
}

interface QueueResult {
  action: 'waiting' | 'finished' | 'ignored' | 'requeued' | 'renewed'
  runId?: number
  message: string
}

export async function continueReleaseQueue(
  api: QueueApi,
  requestedRunId?: number,
  now = Date.now()
): Promise<QueueResult> {
  const latest = (await api.get<{ workflow_runs: ReleaseRun[] }>(workflowRuns)).workflow_runs[0]
  if (!latest) return { action: 'ignored', message: 'No release workflow exists.' }
  const runId = latest.id
  if (requestedRunId && requestedRunId !== runId) {
    return { action: 'ignored', runId, message: 'A newer release workflow supersedes this event.' }
  }
  const endpoint = `repos/${repository}/actions/runs/${runId}`
  const run = await api.get<ReleaseRun>(endpoint)
  if (
    run.path !== workflowPath ||
    run.head_branch !== 'custom' ||
    run.head_repository?.full_name !== repository ||
    !['schedule', 'workflow_dispatch'].includes(run.event)
  ) {
    return { action: 'ignored', runId, message: 'The run is not a trusted custom release.' }
  }
  if (run.status !== 'completed') {
    return {
      action: 'waiting',
      runId,
      message: 'The release is already queued or running; leave it intact.'
    }
  }
  if (run.conclusion === 'success') {
    return { action: 'finished', runId, message: 'The release workflow succeeded.' }
  }
  if (run.conclusion !== 'failure') {
    return {
      action: 'ignored',
      runId,
      message: 'Respect manual cancellation and other terminal outcomes.'
    }
  }
  const { jobs } = await api.get<{ jobs: ReleaseJob[] }>(
    `${endpoint}/jobs?filter=latest&per_page=100`
  )
  const mac = jobs.find((job) =>
    /^build \(macos-(?:15|26|latest), arm64, build:mac\)$/.test(job.name)
  )
  const windows = jobs.find((job) => job.name === 'build (windows-latest, x64, build:win)')
  const prepared = jobs.find((job) => job.name === 'prepare')
  if (
    prepared?.conclusion !== 'success' ||
    windows?.conclusion !== 'success' ||
    mac?.conclusion !== 'cancelled' ||
    mac.steps?.some((step) => ['completed', 'in_progress'].includes(step.status))
  ) {
    return {
      action: 'ignored',
      runId,
      message: 'A build started or a real build/check failed; do not retry it.'
    }
  }
  const job = await api.get<{ check_run_url: string }>(`repos/${repository}/actions/jobs/${mac.id}`)
  const prefix = `https://api.github.com/repos/${repository}/check-runs/`
  if (!job.check_run_url.startsWith(prefix)) throw new Error('Unexpected check-run URL')
  const annotations = await api.get<{ message: string }[]>(
    `${job.check_run_url.slice('https://api.github.com/'.length)}/annotations?per_page=100`
  )
  if (!annotations.some((item) => /not acquired by (?:a )?runner/i.test(item.message))) {
    return {
      action: 'ignored',
      runId,
      message: 'No confirmed runner-allocation cancellation was found.'
    }
  }
  // Recheck immediately before writing, so a user retry or a newer release wins.
  const current = await api.get<ReleaseRun>(endpoint)
  const newest = (await api.get<{ workflow_runs: ReleaseRun[] }>(workflowRuns)).workflow_runs[0]
  if (
    current.status !== 'completed' ||
    current.run_attempt !== run.run_attempt ||
    newest?.id !== runId
  ) {
    return {
      action: 'waiting',
      runId,
      message: 'Another action already resumed or superseded this release.'
    }
  }
  const age = now - Date.parse(run.created_at)
  if (run.run_attempt >= 50 || age >= 29 * 24 * 60 * 60_000) {
    // GitHub limits reruns and the lifetime of a single run. A fresh round uses
    // the normal unpublished-version reuse logic and builds a consistent pair.
    const runner = mac.name.includes('macos-15,') ? 'macos-15' : 'macos-26'
    await api.post(`repos/${repository}/actions/workflows/${workflow}/dispatches`, {
      ref: 'custom',
      inputs: { macos_runner: runner }
    })
    return {
      action: 'renewed',
      runId,
      message: 'Started a fresh release round before GitHub rerun limits.'
    }
  }
  await api.post(`repos/${repository}/actions/jobs/${mac.id}/rerun`)
  return {
    action: 'requeued',
    runId,
    message:
      'Requeued only the unallocated macOS job; keep Windows outputs and rerun dependent publishing.'
  }
}

export function createQueueApi(token: string, fetcher: typeof fetch = fetch): QueueApi {
  const request = async <T>(
    method: 'GET' | 'POST',
    endpoint: string,
    body?: unknown
  ): Promise<T> => {
    const response = await fetcher(`https://api.github.com/${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Sparkle-Release-Queue',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) {
      const detail = await response
        .json()
        .then((value: { message?: string }) => value.message)
        .catch(() => '')
      throw new Error(`GitHub API ${response.status}: ${detail || endpoint}`)
    }
    return method === 'POST' || response.status === 204
      ? (undefined as T)
      : ((await response.json()) as T)
  }
  return {
    get: (endpoint) => request('GET', endpoint),
    post: async (endpoint, body) => {
      await request('POST', endpoint, body)
    }
  }
}

async function main(): Promise<void> {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!token || process.env.GITHUB_REPOSITORY !== repository)
    throw new Error('Expected repository token is missing')
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH || '', 'utf8'))
  const rawId =
    process.env.GITHUB_EVENT_NAME === 'workflow_run' ? event.workflow_run?.id : event.inputs?.run_id
  const runId = rawId ? Number(rawId) : undefined
  if (runId !== undefined && (!Number.isSafeInteger(runId) || runId <= 0))
    throw new Error('Invalid run ID')
  const result = await continueReleaseQueue(createQueueApi(token), runId)
  console.log(JSON.stringify(result))
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `${result.message}\n\n${result.runId ? `Release run: https://github.com/${repository}/actions/runs/${result.runId}\n` : ''}`
    )
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
