/* eslint-env node */
'use strict'

// Builds the Chrome Web Store ZIP for one explicit version from a pristine checkout,
// using Node built-ins only (the CI package job never runs npm). Every check here
// must fail before any success metadata exists: the upload job re-verifies the ZIP
// against build/store-release/release.json but never rebuilds, so a check skipped
// here is skipped for good.
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

// Chrome's manifest version grammar: one to four integers, each 0-65535, no leading
// zeroes. `release` additionally demands exactly X.Y.Z because the same string is
// written to package.json, where npm only accepts three components.
// Missing components compare as zero in Chrome (1.3 == 1.3.0), so the result is
// always padded to four parts for isNewer.
function versionParts(version, release = false) {
    if (typeof version !== 'string' || version.trim() !== version ||
        !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/.test(version)) {
        throw new Error('Version must contain numeric components without leading zeroes')
    }
    const parts = version.split('.').map(Number)
    if ((release && parts.length !== 3) || parts.some(part => part > 65535) || parts.every(part => part === 0)) {
        throw new Error('Release version must be X.Y.Z, with components from 0 to 65535, and cannot be all zero')
    }
    return [...parts, ...Array(4 - parts.length).fill(0)]
}

// Shared with upload-webstore.cjs; this is why requiring this module has no side
// effects (the CLI entry point is guarded by require.main below).
function validateReleaseVersion(version) {
    versionParts(version, true)
    return version
}

function isNewer(candidate, current) {
    for (let index = 0; index < 4; index++) {
        if (candidate[index] !== current[index]) return candidate[index] > current[index]
    }
    return false
}

// pack.sh zips whole directories (css/, js/, icons/), so a deleted or misnamed file
// inside an existing directory would still produce a "valid" archive that breaks at
// install time. This derives the individual files the extension actually loads from
// the manifest, the three HTML pages and the worker's importScripts, so both the
// checkout and the archive can be checked file by file.
function runtimeFiles(cwd, manifest) {
    const required = new Set(['manifest.json', 'popup.html', 'settings.html', 'offscreen.html'])
    const add = (file, directory = '') => {
        // Skip references that are not packaged files: URLs with a scheme (https:,
        // data:, chrome-extension:), fragments and protocol-relative URLs.
        if (typeof file !== 'string' || !file || /^(?:[a-z]+:|#|\/\/)/i.test(file)) return
        // posix on purpose: manifest paths and ZIP entry names use forward slashes on
        // every host OS, and the normalized form is compared against `unzip -Z1` output.
        const normalized = path.posix.normalize(path.posix.join(directory, file))
        // `../` would be checked against the checkout's parent and can never be a ZIP
        // entry; a leading slash is a root-relative URL whose normalized form keeps the
        // slash and would never match `unzip -Z1`, so it is rejected instead of resolved.
        if (file.startsWith('/') || normalized.startsWith('../') || normalized === '..') {
            throw new Error(`Runtime file must stay within the extension: ${file}`)
        }
        required.add(normalized)
    }
    Object.values(manifest.icons || {}).forEach(file => add(file))
    Object.values(manifest.action?.default_icon || {}).forEach(file => add(file))
    add(manifest.action?.default_popup)
    add(manifest.options_ui?.page)
    add(manifest.background?.service_worker)
    for (const script of manifest.content_scripts || []) {
        for (const file of [...(script.js || []), ...(script.css || [])]) add(file)
    }
    // Page assets are resolved relative to the page's own directory, as the browser does.
    for (const page of ['popup.html', 'settings.html', 'offscreen.html']) {
        const html = fs.readFileSync(path.join(cwd, page), 'utf8')
        for (const [, file] of html.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)=["']([^"']+)["']/gi)) {
            add(file, path.posix.dirname(page))
        }
    }
    // An MV3 service worker cannot be listed with multiple files in the manifest; it
    // pulls shared modules in with importScripts, so those are runtime files too.
    const worker = manifest.background?.service_worker
    if (worker) {
        for (const [, list] of fs.readFileSync(path.join(cwd, worker), 'utf8').matchAll(/importScripts\(([^)]*)\)/g)) {
            for (const [, file] of list.matchAll(/["']([^"']+)["']/g)) add(file, path.posix.dirname(worker))
        }
    }
    // isFile() matters: a directory carrying the expected name would pass existsSync.
    for (const file of required) {
        if (!fs.existsSync(path.join(cwd, file)) || !fs.statSync(path.join(cwd, file)).isFile()) {
            throw new Error(`Missing required runtime file: ${file}`)
        }
    }
    return required
}

function prepareStoreRelease({ cwd = process.cwd(), version }) {
    const output = path.join(cwd, 'build/store-release')
    // This directory is exclusively generated output. Invalidate previous success
    // metadata before doing work so a failed rerun cannot expose a stale release.
    fs.rmSync(output, { recursive: true, force: true })
    const candidate = versionParts(validateReleaseVersion(version))
    // `original` keeps the exact source text so a failure can restore the files
    // byte for byte instead of re-serializing them.
    const original = new Map()
    const records = new Map()
    for (const file of ['manifest.json', 'package.json', 'package-lock.json']) {
        const filename = path.join(cwd, file)
        // The lockfile is optional so the script also works on a checkout without one.
        if (file === 'package-lock.json' && !fs.existsSync(filename)) continue
        const contents = fs.readFileSync(filename, 'utf8')
        original.set(file, contents)
        records.set(file, JSON.parse(contents))
    }
    const manifest = records.get('manifest.json')
    const packageJson = records.get('package.json')
    // Both source records must already agree before either is rewritten; otherwise a
    // half-bumped checkout would be silently "repaired" by the release.
    if (manifest.version !== packageJson.version) {
        throw new Error('Source manifest.json and package.json versions must match')
    }
    if (!isNewer(candidate, versionParts(manifest.version))) {
        throw new Error(`Release version ${version} must be greater than the source version ${manifest.version}`)
    }

    const archive = `phobiablur-v${version}.zip`
    const rootArchive = path.join(cwd, archive)
    // pack.sh writes the ZIP into the repo root; a leftover from an earlier run must
    // not be mistaken for this run's output if pack.sh fails before producing one.
    fs.rmSync(rootArchive, { force: true })
    // Resolved before any file is modified so a missing runtime file aborts with the
    // source records untouched.
    const required = runtimeFiles(cwd, manifest)
    let staging
    try {
        // All version records are rewritten here, together, so they cannot drift.
        // pack.sh would also sed the manifest, but by now it already holds the new
        // version, so its own bump is a no-op. The indent unit follows each file (manifest
        // 4 spaces, npm files 2); JSON.stringify still reflows manifest.json's one-line
        // arrays, which is why the rollback below restores `original` byte for byte.
        // packages[''] is the root entry of a lockfileVersion 2/3 lockfile.
        for (const [file, record] of records) {
            record.version = version
            if (file === 'package-lock.json' && record.packages?.['']) record.packages[''].version = version
            fs.writeFileSync(path.join(cwd, file), `${JSON.stringify(record, null, file === 'manifest.json' ? 4 : 2)}\n`)
        }
        // zip -r and unzip -t print one line per entry; exceeding maxBuffer would kill
        // the child and fail the build, so leave headroom over the 1 MiB default.
        execFileSync('bash', ['pack.sh', version], { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
        // Verify the archive independently of pack.sh's own checks: integrity (-t),
        // the packaged manifest version (-p), and the per-file entry list (-Z1).
        execFileSync('unzip', ['-t', rootArchive], { encoding: 'utf8' })
        const archivedManifest = JSON.parse(execFileSync('unzip', ['-p', rootArchive, 'manifest.json'], { encoding: 'utf8' }))
        if (archivedManifest.version !== version) throw new Error('Packaged manifest version does not match the release version')
        const entries = new Set(execFileSync('unzip', ['-Z1', rootArchive], { encoding: 'utf8' }).trim().split('\n'))
        for (const file of required) {
            if (!entries.has(file)) throw new Error(`Archive is missing required runtime file: ${file}`)
        }
        // The upload job re-checks this digest after the artifact crosses the job
        // boundary, so the hash must be taken from the final bytes, after all checks.
        const metadata = {
            version,
            archive,
            sha256: createHash('sha256').update(fs.readFileSync(rootArchive)).digest('hex')
        }
        // Assemble in a sibling temp directory and rename it into place last, so
        // build/store-release either exists complete or not at all. The ZIP is moved,
        // not copied: the artifact directory is meant to be the only copy.
        fs.mkdirSync(path.dirname(output), { recursive: true })
        staging = fs.mkdtempSync(path.join(path.dirname(output), '.store-release-'))
        fs.renameSync(rootArchive, path.join(staging, archive))
        // The workflow never commits the bump back to the branch; the rewritten records
        // travel in the artifact so the maintainer can apply them to the source by hand.
        for (const file of ['manifest.json', 'package.json']) fs.copyFileSync(path.join(cwd, file), path.join(staging, file))
        fs.writeFileSync(path.join(staging, 'release.json'), `${JSON.stringify(metadata, null, 2)}\n`)
        fs.renameSync(staging, output)
        return metadata
    } catch (error) {
        // Roll back everything this run touched; the output directory was already
        // removed up front, so no release.json can survive a failure.
        for (const [file, contents] of original) fs.writeFileSync(path.join(cwd, file), contents)
        fs.rmSync(rootArchive, { force: true })
        if (staging) fs.rmSync(staging, { recursive: true, force: true })
        throw error
    }
}

if (require.main === module) {
    try {
        // Exactly one explicit version: there is no implicit patch bump in CI.
        if (process.argv.length !== 3) throw new Error('Usage: node scripts/prepare-store-release.cjs X.Y.Z')
        const metadata = prepareStoreRelease({ version: process.argv[2] })
        console.log(`Prepared build/store-release/${metadata.archive} (SHA-256 ${metadata.sha256})`)
    } catch (error) {
        console.error(`Release build failed: ${error.message}`)
        process.exitCode = 1
    }
}

module.exports = { prepareStoreRelease, validateReleaseVersion }
