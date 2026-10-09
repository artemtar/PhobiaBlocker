const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const repoRoot = path.resolve(__dirname, '../..')
const ROOT_PAGES = ['popup.html', 'settings.html', 'offscreen.html']
const read = file => fs.readFileSync(path.join(repoRoot, file), 'utf8')

// Every file the installed extension loads, derived from the manifest, the
// extension pages and the service worker instead of a hand-kept list.
function extensionFiles() {
    const manifest = JSON.parse(read('manifest.json'))
    const files = new Set(['manifest.json', ...ROOT_PAGES])
    const add = (file) => {
        if (typeof file === 'string' && file && !/^(?:https?:|chrome)/.test(file)) files.add(file.replace(/^\.?\//, ''))
    }

    Object.values(manifest.icons || {}).forEach(add)
    Object.values(manifest.action?.default_icon || {}).forEach(add)
    add(manifest.action?.default_popup)
    add(manifest.options_ui?.page)
    add(manifest.background?.service_worker)
    for (const script of manifest.content_scripts || []) {
        ;(script.js || []).forEach(add)
        ;(script.css || []).forEach(add)
    }
    for (const page of ROOT_PAGES) {
        const html = read(page)
        for (const [, src] of html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) add(src)
        for (const [, href] of html.matchAll(/<link[^>]*\bhref="([^"]+)"/g)) add(href)
    }
    const worker = manifest.background?.service_worker
    if (worker) {
        for (const [, list] of read(worker).matchAll(/importScripts\(([^)]*)\)/g)) {
            list.split(',')
                .map(item => item.trim().replace(/^['"]|['"]$/g, ''))
                .filter(Boolean)
                .forEach(file => add(path.posix.join(path.posix.dirname(worker), file)))
        }
    }
    return [...files].sort()
}

function writeFile(filePath, contents) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, contents)
}

// A copy of the real extension files plus decoys, so the zip can be checked
// against what the extension actually references.
function createFixture(referenced) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phobiablocker-pack-'))
    fs.copyFileSync(path.join(repoRoot, 'pack.sh'), path.join(dir, 'pack.sh'))
    for (const file of referenced) {
        if (file === 'manifest.json') continue
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
        fs.copyFileSync(path.join(repoRoot, file), path.join(dir, file))
    }
    // pack.sh rewrites the version, so the fixture gets its own manifest copy.
    const manifest = { ...JSON.parse(read('manifest.json')), version: '0.1.0' }
    writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 4))

    writeFile(path.join(dir, 'screenshot.png'), 'screenshot')
    writeFile(path.join(dir, 'css/dev-only.css'), 'dev css')
    writeFile(path.join(dir, 'js/dev-only.js'), 'dev js')
    writeFile(path.join(dir, 'icons/main.png'), 'unused icon')
    writeFile(path.join(dir, '.mcp.json'), '{}')
    writeFile(path.join(dir, 'playwright.mcp.config.json'), '{}')
    writeFile(path.join(dir, '.codex/config.toml'), 'model = "test"')
    return dir
}

function runPack(dir, version) {
    execFileSync('bash', version ? ['pack.sh', version] : ['pack.sh'], { cwd: dir, encoding: 'utf8' })
}

function listZipEntries(zipPath) {
    return execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
}

const referenced = extensionFiles()

test('every file the extension references exists in the repository', () => {
    const missing = referenced.filter(file => !fs.existsSync(path.join(repoRoot, file)))
    assert.deepEqual(missing, [])
    // Sanity check that the derivation sees the shared modules the pages throw without.
    for (const file of ['js/shared-policy.js', 'js/storage.js', 'js/page-text-index.js', 'js/settings-ui.js', 'css/protection.css']) {
        assert.ok(referenced.includes(file), `${file} must be discovered as a referenced file`)
    }
})

test('the lint script covers every hand-written script the extension loads', () => {
    const lintScript = JSON.parse(read('package.json')).scripts.lint
    const linted = new Set(lintScript.split(/\s+/).filter(argument => argument.endsWith('.js')))
    const bundledLibraries = new Set(['js/compromise.min.js'])

    const unlinted = referenced.filter(file => file.endsWith('.js') && !bundledLibraries.has(file) && !linted.has(file))

    assert.deepEqual(unlinted, [], 'every shipped script must be part of the lint gate')
})

test('pack.sh uses an explicit version when one is provided', () => {
    const dir = createFixture(referenced)
    try {
        runPack(dir, '2.3.4')
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
        assert.equal(manifest.version, '2.3.4')
        assert.ok(fs.existsSync(path.join(dir, 'phobiablur-v2.3.4.zip')))
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('pack.sh packages every referenced file and whole asset folders, never local tooling', () => {
    const dir = createFixture(referenced)
    try {
        runPack(dir)
        const entries = new Set(listZipEntries(path.join(dir, 'phobiablur-v0.1.1.zip')))
        const missing = referenced.filter(file => !entries.has(file))
        assert.deepEqual(missing, [], 'the zip must contain every file the extension loads')
        for (const bundled of ['css/dev-only.css', 'js/dev-only.js', 'icons/main.png']) {
            assert.ok(entries.has(bundled), `${bundled}: asset folders are packaged whole`)
        }
        for (const excluded of ['screenshot.png', '.mcp.json', 'playwright.mcp.config.json', '.codex/config.toml']) {
            assert.ok(!entries.has(excluded), `${excluded} should not be packaged`)
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
