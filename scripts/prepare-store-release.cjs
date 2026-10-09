/* eslint-env node */
'use strict'

const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

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

function runtimeFiles(cwd, manifest) {
    const required = new Set(['manifest.json', 'popup.html', 'settings.html', 'offscreen.html'])
    const add = (file, directory = '') => {
        if (typeof file !== 'string' || !file || /^(?:[a-z]+:|#|\/\/)/i.test(file)) return
        const normalized = path.posix.normalize(path.posix.join(directory, file))
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
    for (const page of ['popup.html', 'settings.html', 'offscreen.html']) {
        const html = fs.readFileSync(path.join(cwd, page), 'utf8')
        for (const [, file] of html.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)=["']([^"']+)["']/gi)) {
            add(file, path.posix.dirname(page))
        }
    }
    const worker = manifest.background?.service_worker
    if (worker) {
        for (const [, list] of fs.readFileSync(path.join(cwd, worker), 'utf8').matchAll(/importScripts\(([^)]*)\)/g)) {
            for (const [, file] of list.matchAll(/["']([^"']+)["']/g)) add(file, path.posix.dirname(worker))
        }
    }
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
    const original = new Map()
    const records = new Map()
    for (const file of ['manifest.json', 'package.json', 'package-lock.json']) {
        const filename = path.join(cwd, file)
        if (file === 'package-lock.json' && !fs.existsSync(filename)) continue
        const contents = fs.readFileSync(filename, 'utf8')
        original.set(file, contents)
        records.set(file, JSON.parse(contents))
    }
    const manifest = records.get('manifest.json')
    const packageJson = records.get('package.json')
    if (manifest.version !== packageJson.version) {
        throw new Error('Source manifest.json and package.json versions must match')
    }
    if (!isNewer(candidate, versionParts(manifest.version))) {
        throw new Error(`Release version ${version} must be greater than the source version ${manifest.version}`)
    }

    const archive = `phobiablur-v${version}.zip`
    const rootArchive = path.join(cwd, archive)
    fs.rmSync(rootArchive, { force: true })
    const required = runtimeFiles(cwd, manifest)
    let staging
    try {
        for (const [file, record] of records) {
            record.version = version
            if (file === 'package-lock.json' && record.packages?.['']) record.packages[''].version = version
            fs.writeFileSync(path.join(cwd, file), `${JSON.stringify(record, null, file === 'manifest.json' ? 4 : 2)}\n`)
        }
        execFileSync('bash', ['pack.sh', version], { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
        execFileSync('unzip', ['-t', rootArchive], { encoding: 'utf8' })
        const archivedManifest = JSON.parse(execFileSync('unzip', ['-p', rootArchive, 'manifest.json'], { encoding: 'utf8' }))
        if (archivedManifest.version !== version) throw new Error('Packaged manifest version does not match the release version')
        const entries = new Set(execFileSync('unzip', ['-Z1', rootArchive], { encoding: 'utf8' }).trim().split('\n'))
        for (const file of required) {
            if (!entries.has(file)) throw new Error(`Archive is missing required runtime file: ${file}`)
        }
        const metadata = {
            version,
            archive,
            sha256: createHash('sha256').update(fs.readFileSync(rootArchive)).digest('hex')
        }
        fs.mkdirSync(path.dirname(output), { recursive: true })
        staging = fs.mkdtempSync(path.join(path.dirname(output), '.store-release-'))
        fs.renameSync(rootArchive, path.join(staging, archive))
        for (const file of ['manifest.json', 'package.json']) fs.copyFileSync(path.join(cwd, file), path.join(staging, file))
        fs.writeFileSync(path.join(staging, 'release.json'), `${JSON.stringify(metadata, null, 2)}\n`)
        fs.renameSync(staging, output)
        return metadata
    } catch (error) {
        for (const [file, contents] of original) fs.writeFileSync(path.join(cwd, file), contents)
        fs.rmSync(rootArchive, { force: true })
        if (staging) fs.rmSync(staging, { recursive: true, force: true })
        throw error
    }
}

if (require.main === module) {
    try {
        if (process.argv.length !== 3) throw new Error('Usage: node scripts/prepare-store-release.cjs X.Y.Z')
        const metadata = prepareStoreRelease({ version: process.argv[2] })
        console.log(`Prepared build/store-release/${metadata.archive} (SHA-256 ${metadata.sha256})`)
    } catch (error) {
        console.error(`Release build failed: ${error.message}`)
        process.exitCode = 1
    }
}

module.exports = { prepareStoreRelease, validateReleaseVersion }
