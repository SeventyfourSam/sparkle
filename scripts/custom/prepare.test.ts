import assert from 'node:assert/strict'
import test from 'node:test'
import { customizePrepareTasks } from './prepare.ts'

test('custom preparation replaces both upstream core downloads and preserves resource tasks', () => {
  const officialDownload = async (): Promise<void> => {
    throw new Error('upstream must not run')
  }
  const resource = { name: 'geoip', func: async () => {}, retry: 5, winOnly: true }
  const tasks = [
    { name: 'mihomo-alpha', func: officialDownload, retry: 5 },
    { name: 'mihomo', func: officialDownload, retry: 5 },
    resource
  ]
  customizePrepareTasks(tasks, process.arch)
  assert.equal(tasks.filter((task) => task.name === 'mihomo').length, 1)
  assert.equal(
    tasks.some((task) => task.name === 'mihomo-alpha'),
    false
  )
  assert.equal(
    tasks.some((task) => task.func === officialDownload),
    false
  )
  assert.equal(tasks.at(-1), resource)
  assert.equal(
    tasks.some((task) => task.name === 'dns-helper'),
    process.platform === 'darwin'
  )
})

test('system-core-only builds do not gain a bundled core download', () => {
  const tasks = [{ name: 'geoip', func: async () => {}, retry: 5 }]
  customizePrepareTasks(tasks, process.arch)
  assert.equal(
    tasks.some((task) => task.name.startsWith('mihomo')),
    false
  )
  assert.equal(
    tasks.some((task) => task.name === 'dns-helper'),
    process.platform === 'darwin'
  )
})
