import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const rootDir = resolve('.')
const distDir = resolve(rootDir, 'dist')
const releaseDir = resolve(rootDir, 'release')

if (!existsSync(distDir)) {
  console.error('Build output not found. Run "pnpm build" before packaging the extension.')
  process.exit(1)
}

const packageJson = JSON.parse(await BunCompatReadFile(resolve(rootDir, 'package.json')))
const version = packageJson.version ?? '0.0.0'
const archiveBaseName = `api-debugger-overlay-v${version}`
const archivePath = resolve(releaseDir, `${archiveBaseName}.zip`)

mkdirSync(releaseDir, { recursive: true })
rmSync(archivePath, { force: true })

if (process.platform === 'win32') {
  const command = [
    'Compress-Archive',
    '-Path',
    `"${join(distDir, '*')}"`,
    '-DestinationPath',
    `"${archivePath}"`,
    '-CompressionLevel',
    'Optimal',
  ].join(' ')

  const result = spawnSync('powershell', ['-NoProfile', '-Command', command], {
    stdio: 'inherit',
    cwd: rootDir,
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
} else {
  const entries = readdirSync(distDir)

  if (entries.length === 0) {
    console.error('Build output is empty. Run "pnpm build" before packaging the extension.')
    process.exit(1)
  }

  const result = spawnSync('zip', ['-qr', archivePath, ...entries], {
    stdio: 'inherit',
    cwd: distDir,
  })

  if (result.status !== 0) {
    console.error('Failed to create zip archive. Ensure the "zip" command is available.')
    process.exit(result.status ?? 1)
  }
}

const archiveSize = formatBytes(statSync(archivePath).size)
console.log(`Created ${archivePath} (${archiveSize})`)

async function BunCompatReadFile(filePath) {
  const { readFile } = await import('node:fs/promises')
  return readFile(filePath, 'utf8')
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
