const assert = require('node:assert/strict')
const { spawnSync, execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const repoRoot = path.resolve(__dirname, '../..')
const script = path.join(repoRoot, 'scripts/prepare-store-release.cjs')
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)

function fixture(t, version = '1.3.1') {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'phobiablur-store-release-'))
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
    for (const file of ['manifest.json', 'package.json', 'popup.html', 'settings.html', 'offscreen.html', 'pack.sh', 'css', 'js', 'icons']) {
        fs.cpSync(path.join(repoRoot, file), path.join(cwd, file), { recursive: true })
    }
    for (const file of ['manifest.json', 'package.json']) {
        writeJson(path.join(cwd, file), { ...json(path.join(cwd, file)), version })
    }
    return cwd
}

function run(cwd, ...args) {
    return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
}

function assertFailed(result, pattern) {
    assert.notEqual(result.status, 0, result.stdout)
    assert.match(result.stderr, pattern)
}

test('release validation is safe to import and returns the original valid version', () => {
    const { validateReleaseVersion } = require('../../scripts/prepare-store-release.cjs')
    assert.equal(validateReleaseVersion('1.3.2'), '1.3.2')
    assert.throws(() => validateReleaseVersion('1.3'), /version/i)
})

test('release build creates a verified runtime ZIP and synchronized version records', t => {
    const cwd = fixture(t)
    const lock = {
        name: 'phobiablur', version: '1.3.1', lockfileVersion: 3,
        packages: { '': { name: 'phobiablur', version: '1.3.1' }, 'node_modules/example': { version: '9.8.7' } }
    }
    writeJson(path.join(cwd, 'package-lock.json'), lock)
    const result = run(cwd, '1.3.2')
    assert.equal(result.status, 0, result.stderr)
    const output = path.join(cwd, 'build/store-release')
    const archive = path.join(output, 'phobiablur-v1.3.2.zip')
    const manifest = JSON.parse(execFileSync('unzip', ['-p', archive, 'manifest.json'], { encoding: 'utf8' }))
    assert.equal(manifest.version, '1.3.2')
    const entries = new Set(execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n'))
    for (const file of [
        'popup.html', 'settings.html', 'offscreen.html', 'css/protection.css',
        'js/background.js', 'js/shared-policy.js', 'js/editor-frames.js',
        'js/shadow-root-notifier.js', 'js/settings-ui.js', 'icons/icon24.png'
    ]) assert.ok(entries.has(file), `missing runtime file: ${file}`)
    assert.ok(!entries.has('package.json'))
    assert.ok(!fs.existsSync(path.join(cwd, 'phobiablur-v1.3.2.zip')), 'only the artifact directory retains the ZIP')
    for (const file of ['manifest.json', 'package.json']) {
        assert.equal(json(path.join(cwd, file)).version, '1.3.2')
        assert.deepEqual(json(path.join(output, file)), json(path.join(cwd, file)))
    }
    const updatedLock = json(path.join(cwd, 'package-lock.json'))
    assert.equal(updatedLock.version, '1.3.2')
    assert.equal(updatedLock.packages[''].version, '1.3.2')
    assert.equal(updatedLock.packages['node_modules/example'].version, '9.8.7')
    assert.deepEqual(json(path.join(output, 'release.json')), {
        version: '1.3.2',
        archive: 'phobiablur-v1.3.2.zip',
        sha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
    })
})

test('release version validation rejects malformed and out-of-range inputs without changing source versions', t => {
    const cwd = fixture(t)
    const originalManifest = fs.readFileSync(path.join(cwd, 'manifest.json'), 'utf8')
    const originalPackage = fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')
    for (const version of ['1', '1.3', '1.3.2.0', '01.3.2', '1.03.2', '1.3.02', '65536.0.0', '1.65536.0', '1.0.65536', '0.0.0', 'v1.3.2', '1.3.2-beta', '1.3.2\n', '1.3.2; touch injected']) {
        assertFailed(run(cwd, version), /version/i)
    }
    assert.equal(fs.readFileSync(path.join(cwd, 'manifest.json'), 'utf8'), originalManifest)
    assert.equal(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'), originalPackage)
    assert.ok(!fs.existsSync(path.join(cwd, 'injected')))
    assert.ok(!fs.existsSync(path.join(cwd, 'build/store-release/release.json')))
})

test('release CLI requires exactly one explicit version', t => {
    const cwd = fixture(t)
    assertFailed(run(cwd), /usage|version/i)
    assertFailed(run(cwd, '1.3.2', '1.3.3'), /usage|version/i)
})

test('release build rejects equal or older versions using numeric component ordering', t => {
    const cwd = fixture(t, '1.10.0')
    for (const version of ['1.10.0', '1.9.65535', '0.65535.65535']) {
        assertFailed(run(cwd, version), /greater|newer/i)
    }
    assert.equal(json(path.join(cwd, 'manifest.json')).version, '1.10.0')
})

test('release build compares missing source version components as zero', t => {
    const cwd = fixture(t, '1.3')
    assertFailed(run(cwd, '1.3.0'), /greater|newer/i)
    const result = run(cwd, '1.3.1')
    assert.equal(result.status, 0, result.stderr)
})

test('release build accepts the largest valid numeric components', t => {
    const cwd = fixture(t)
    const result = run(cwd, '65535.65535.65535')
    assert.equal(result.status, 0, result.stderr)
    assert.equal(json(path.join(cwd, 'build/store-release/release.json')).version, '65535.65535.65535')
})

test('release build rejects inconsistent source version records before changing files', t => {
    const cwd = fixture(t)
    writeJson(path.join(cwd, 'package.json'), { ...json(path.join(cwd, 'package.json')), version: '1.3.0' })
    assertFailed(run(cwd, '1.3.2'), /manifest.*package|package.*manifest/i)
    assert.equal(json(path.join(cwd, 'manifest.json')).version, '1.3.1')
    assert.equal(json(path.join(cwd, 'package.json')).version, '1.3.0')
    assert.ok(!fs.existsSync(path.join(cwd, 'build/store-release/release.json')))
})

test('release build refuses a missing manifest-referenced runtime file and emits no success metadata', t => {
    const cwd = fixture(t)
    fs.unlinkSync(path.join(cwd, 'js/editor-frames.js'))
    const output = path.join(cwd, 'build/store-release')
    fs.mkdirSync(output, { recursive: true })
    writeJson(path.join(output, 'release.json'), { version: '1.0.0', archive: 'stale.zip', sha256: 'stale' })
    fs.writeFileSync(path.join(output, 'stale.zip'), 'old archive')
    assertFailed(run(cwd, '1.3.2'), /js\/editor-frames\.js/)
    assert.ok(!fs.existsSync(path.join(output, 'release.json')))
    assert.ok(!fs.existsSync(path.join(output, 'stale.zip')))
    assert.ok(!fs.existsSync(path.join(cwd, 'phobiablur-v1.3.2.zip')))
})

test('release build refuses missing HTML dependencies even when their asset directory exists', t => {
    const cwd = fixture(t)
    fs.unlinkSync(path.join(cwd, 'js/settings-ui.js'))
    assertFailed(run(cwd, '1.3.2'), /js\/settings-ui\.js/)
    assert.ok(!fs.existsSync(path.join(cwd, 'build/store-release/release.json')))
})

const releaseWorkflowText = () => fs.readFileSync(path.join(repoRoot, '.github/workflows/chrome-web-store.yml'), 'utf8')

// Minimal reading of the release workflow: job name -> the lines of that job.
function releaseWorkflowJobs() {
    const text = releaseWorkflowText()
    const jobsStart = text.indexOf('\njobs:\n')
    assert.notEqual(jobsStart, -1, 'the workflow must define jobs')
    const jobs = new Map()
    let current = null
    for (const line of text.slice(jobsStart + '\njobs:\n'.length).split('\n')) {
        const header = line.match(/^ {2}([\w-]+):\s*$/)
        if (header) {
            current = []
            jobs.set(header[1], current)
        } else if (current) {
            current.push(line)
        }
    }
    return jobs
}

function jobRunning(jobs, command) {
    const matches = [...jobs].filter(([, lines]) => lines.some(line => line.includes(command)))
    assert.equal(matches.length, 1, `exactly one job must run ${command}`)
    return matches[0]
}

function jobNeeds(lines) {
    const needs = lines.map(line => line.match(/^\s+needs:\s*(.+?)\s*$/)).find(Boolean)
    if (!needs) return []
    return needs[1].replace(/^\[|\]$/g, '').split(',').map(name => name.trim()).filter(Boolean)
}

test('the release ZIP is packaged in a job that never installs or runs npm packages', () => {
    const jobs = releaseWorkflowJobs()
    const [, packageLines] = jobRunning(jobs, 'prepare-store-release.cjs')

    const thirdPartyCode = packageLines.filter(line => /\bnpm\b|\bnpx\b|node_modules/.test(line))

    assert.deepEqual(thirdPartyCode, [], 'the packaging job must build from the pristine checkout with Node built-ins only')
})

test('the upload job is gated by both the validation job and the packaging job', () => {
    const jobs = releaseWorkflowJobs()
    const [packageJob] = jobRunning(jobs, 'prepare-store-release.cjs')
    const [validateJob, validateLines] = jobRunning(jobs, 'npm run lint')
    const [, uploadLines] = jobRunning(jobs, 'upload-webstore.cjs')

    assert.ok(validateLines.some(line => line.includes('npm run test:unit')), 'the validation job must run the unit suite')
    assert.notEqual(validateJob, packageJob, 'validation and packaging must not share a checkout')
    const needs = jobNeeds(uploadLines)
    assert.ok(needs.includes(validateJob), `upload must need ${validateJob}, got ${needs}`)
    assert.ok(needs.includes(packageJob), `upload must need ${packageJob}, got ${needs}`)
})

// A mutable tag such as @v4 can be moved to run different code under the
// publisher credentials; only a full commit SHA names one immutable revision.
const PINNED_ACTION = /^\s*-?\s*uses:\s*[\w.-]+\/[\w.-]+@[0-9a-f]{40}\s+#\s*v\d+\.\d+\.\d+\s*$/

test('every action the release workflow uses is pinned to a full commit SHA with a version comment', () => {
    const usesLines = releaseWorkflowText().split('\n').filter(line => /^\s*-?\s*uses:/.test(line))

    const unpinned = usesLines.filter(line => !PINNED_ACTION.test(line)).map(line => line.trim())

    assert.ok(usesLines.length >= 3, 'the workflow must use checkout, artifact upload and download actions')
    assert.deepEqual(unpinned, [], 'every uses: line must be `owner/repo@<40-hex-sha> # vX.Y.Z`')
})

const PUBLIC_REGISTRY = 'https://registry.npmjs.org/'

test('the validation job installs the committed lockfile, which resolves every package from the public registry', () => {
    const jobs = releaseWorkflowJobs()
    const [, validateLines] = jobRunning(jobs, 'npm run lint')
    const lockPath = path.join(repoRoot, 'package-lock.json')
    const pkg = json(path.join(repoRoot, 'package.json'))

    assert.ok(validateLines.some(line => /\bnpm ci\b/.test(line)), 'validation must install with npm ci, never npm install')
    assert.ok(fs.existsSync(lockPath), 'npm ci needs a committed root package-lock.json')
    const lock = json(lockPath)
    assert.ok(lock.lockfileVersion >= 2, 'the lockfile must carry the packages map npm ci reads')
    assert.equal(lock.name, pkg.name)
    assert.equal(lock.version, pkg.version)
    assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies, 'the lockfile must be in sync with package.json')
    const privateResolutions = Object.entries(lock.packages)
        .filter(([, entry]) => entry.resolved && !entry.resolved.startsWith(PUBLIC_REGISTRY))
        .map(([name, entry]) => `${name} -> ${entry.resolved}`)
    assert.deepEqual(privateResolutions, [], 'every package must resolve from the public registry')
    assert.ok(Object.keys(lock.packages).length > 1, 'the lockfile must pin the toolchain, not only the root package')
})

test('a failed pack command restores source versions and never retains a stale archive', t => {
    const cwd = fixture(t)
    fs.writeFileSync(path.join(cwd, 'pack.sh'), '#!/bin/bash\nexit 8\n')
    fs.writeFileSync(path.join(cwd, 'phobiablur-v1.3.2.zip'), 'stale archive')
    assertFailed(run(cwd, '1.3.2'), /pack|failed/i)
    assert.equal(json(path.join(cwd, 'manifest.json')).version, '1.3.1')
    assert.equal(json(path.join(cwd, 'package.json')).version, '1.3.1')
    assert.ok(!fs.existsSync(path.join(cwd, 'phobiablur-v1.3.2.zip')))
    assert.ok(!fs.existsSync(path.join(cwd, 'build/store-release/release.json')))
})
