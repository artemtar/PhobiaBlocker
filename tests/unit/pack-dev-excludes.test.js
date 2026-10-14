const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const repoRoot = path.resolve(__dirname, '../..')
// The runtime set pack.sh ships; the dev build must contain exactly this.
const RUNTIME_ENTRIES = ['manifest.json', 'popup.html', 'settings.html', 'offscreen.html', 'css', 'js', 'icons']
// Working-tree contents that must never reach the unpacked dev extension.
const SCRATCH_FILES = {
    'popup-screenshot.png': 'png',
    '.mcp.json': '{}',
    'playwright.mcp.config.json': '{}',
    '.codex/config.toml': 'model = "test"',
    '.playwright-mcp/console-2026-09-30.log': 'console trace',
    '.claude/worktrees/review/js/js.js': 'stale worktree copy',
    '.superpowers/sdd/plan.md': 'plan',
    'docs/notes.md': 'notes',
    'scripts/prepare-store-release.cjs': '// release tooling',
    'tests/unit/example.test.js': '// test',
    'store-assets/listing.png': 'png',
    'README.md': 'readme',
    'package.json': '{}',
    'pack.sh': '#!/bin/bash\n'
}
const hasJq = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0

function walk(root, directory = root) {
    const files = []
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name)
        if (entry.isDirectory()) files.push(...walk(root, full))
        else files.push(path.relative(root, full).split(path.sep).join('/'))
    }
    return files.sort()
}

function writeFile(filePath, contents) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, contents)
}

function createFixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phobiablocker-pack-dev-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    fs.copyFileSync(path.join(repoRoot, 'pack-dev.sh'), path.join(dir, 'pack-dev.sh'))
    for (const entry of RUNTIME_ENTRIES) {
        fs.cpSync(path.join(repoRoot, entry), path.join(dir, entry), { recursive: true })
    }
    for (const [file, contents] of Object.entries(SCRATCH_FILES)) writeFile(path.join(dir, file), contents)
    return dir
}

function runtimeFilesOf(dir) {
    return RUNTIME_ENTRIES.flatMap(entry => {
        const full = path.join(dir, entry)
        return fs.statSync(full).isDirectory() ? walk(dir, full) : [entry]
    }).sort()
}

test('pack-dev.sh copies only the runtime set pack.sh ships and rewrites the manifest for development', { skip: !hasJq && 'jq is not installed' }, t => {
    const dir = createFixture(t)
    const sourceManifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))

    const result = spawnSync('bash', ['pack-dev.sh'], { cwd: dir, encoding: 'utf8' })

    assert.equal(result.status, 0, result.stderr)
    const buildDir = path.join(dir, 'build/dev')
    assert.deepEqual(walk(buildDir), runtimeFilesOf(dir), 'build/dev must hold exactly the runtime files')
    for (const scratch of Object.keys(SCRATCH_FILES)) {
        assert.ok(!fs.existsSync(path.join(buildDir, scratch)), `${scratch} must not be copied into the dev build`)
    }
    const devManifest = JSON.parse(fs.readFileSync(path.join(buildDir, 'manifest.json'), 'utf8'))
    assert.equal(devManifest.name, 'PhobiaBlur DEV')
    assert.equal(devManifest.version, sourceManifest.version)
    assert.equal(devManifest.version_name, `${sourceManifest.version}-dev`)
    assert.equal(devManifest.description, `[DEV BUILD] ${sourceManifest.description}`)
    assert.equal(devManifest.action.default_title, 'PhobiaBlur DEV')
    assert.deepEqual(devManifest.content_scripts, sourceManifest.content_scripts)
})

// A PATH holding only the utilities pack-dev.sh needs besides jq, so the test
// observes a missing jq regardless of where the host installs it.
function pathWithoutJq(t) {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'phobiablocker-no-jq-'))
    t.after(() => fs.rmSync(bin, { recursive: true, force: true }))
    for (const tool of ['grep', 'rm', 'mkdir', 'cp']) {
        const lookup = spawnSync('which', [tool], { encoding: 'utf8' })
        assert.equal(lookup.status, 0, `${tool} must be available to build the fixture PATH`)
        fs.symlinkSync(lookup.stdout.trim(), path.join(bin, tool))
    }
    return bin
}

test('pack-dev.sh fails loudly instead of producing a half-built extension when jq is missing', t => {
    const dir = createFixture(t)

    // bash is addressed by absolute path because the stripped PATH hides it too.
    const result = spawnSync('/bin/bash', ['pack-dev.sh'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, PATH: pathWithoutJq(t) }
    })

    assert.notEqual(result.status, 0, 'a missing jq must fail the build')
    assert.match(result.stderr, /jq/, 'the error must name the missing tool')
})

// The repository ignore rules are evaluated with git itself in a throwaway
// repository so the user's global excludes cannot mask a missing rule.
function createIgnoreRepo(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phobiablocker-ignore-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const init = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' })
    assert.equal(init.status, 0, init.stderr)
    fs.copyFileSync(path.join(repoRoot, '.gitignore'), path.join(dir, '.gitignore'))
    return dir
}

function isIgnored(dir, file) {
    const result = spawnSync('git', ['-c', 'core.excludesFile=/dev/null', 'check-ignore', '-q', '--no-index', '--', file], { cwd: dir, encoding: 'utf8' })
    if (result.status !== 0 && result.status !== 1) throw new Error(`git check-ignore failed for ${file}: ${result.stderr}`)
    return result.status === 0
}

test('.gitignore keeps agent scratch, captures and installers out of the repository', t => {
    const dir = createIgnoreRepo(t)
    const scratch = [
        '.playwright-mcp/console-2026-09-30T05-20-09-528Z.log',
        '.playwright-mcp/chromium-profile/Default/Cookies',
        '.superpowers/sdd/plan.md',
        '.claude/settings.local.json',
        '.codex/config.toml',
        '.mcp.json',
        'playwright.mcp.config.json',
        'tests/.cc-writes/pending.json',
        'store-assets/OpenCode Desktop.dmg',
        'popup-screenshot.png',
        'store-assets/v2/raw/manifest.json',
        'store-assets/v2/capture.log',
        'build/dev/manifest.json',
        'phobiablur-v1.3.1.zip',
        // The quarantined Puppeteer suite's lockfile resolves from an internal mirror.
        'tests/package-lock.json'
    ]
    const tracked = [
        'package-lock.json',
        'manifest.json',
        'js/js.js',
        'icons/icon16.png',
        'store-assets/screenshot-1.png',
        '.github/workflows/chrome-web-store.yml',
        'tests/unit/pack-dev-excludes.test.js'
    ]

    const leaked = scratch.filter(file => !isIgnored(dir, file))
    const hidden = tracked.filter(file => isIgnored(dir, file))

    assert.deepEqual(leaked, [], 'these paths must be ignored')
    assert.deepEqual(hidden, [], 'these paths must stay trackable')
})
