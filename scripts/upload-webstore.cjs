/* eslint-env node */
'use strict'

const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { validateReleaseVersion } = require('./prepare-store-release.cjs')

// API contracts: support_documents/CHROME_WEB_STORE_AUTOMATION.md#api-references
const API = 'https://chromewebstore.googleapis.com'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const ACCEPTED_SUBMISSIONS = new Set(['PENDING_REVIEW', 'PUBLISHED', 'PUBLISHED_TO_TESTERS'])

async function requestJSON(fetchImpl, url, options, stage, timeout = 30000) {
    let response
    try {
        response = await fetchImpl(url, {
            ...options,
            redirect: 'error',
            signal: globalThis.AbortSignal.timeout(timeout),
        })
    } catch (_) {
        // Do not forward error causes or request/response bodies: libraries and
        // remote services can include credentials in their error text.
        throw new Error(`${stage} request failed or timed out. Check the store dashboard before retrying a write.`)
    }
    if (!response.ok) throw new Error(`${stage} request failed (HTTP ${response.status}). Check the API configuration and dashboard.`)
    let data
    try {
        data = await response.json()
    } catch (_) {
        throw new Error(`${stage} returned invalid JSON. Check the store dashboard before retrying a write.`)
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${stage} returned an invalid response`)
    return data
}

function checkItem(data, extensionId, name, stage) {
    if (data.itemId !== extensionId || (data.name !== undefined && data.name !== name)) {
        throw new Error(`${stage} returned an unexpected item identity; refusing to continue`)
    }
}

async function uploadToWebStore(config, {
    fetchImpl = globalThis.fetch,
    sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    pollAttempts = 60,
    pollIntervalMs = 5000,
} = {}) {
    const { archive, version, extensionId, publisherId, clientId, clientSecret, refreshToken, submitForReview = false } = config
    validateReleaseVersion(version)
    if (!Buffer.isBuffer(archive) || archive.length === 0) throw new Error('A nonempty ZIP archive is required')
    if (typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId)) throw new Error('A valid CWS_EXTENSION_ID is required')
    if (typeof publisherId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(publisherId)) throw new Error('A valid CWS_PUBLISHER_ID is required')
    for (const [key, value] of Object.entries({ clientId, clientSecret, refreshToken })) {
        if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing OAuth ${key}`)
    }
    if (typeof submitForReview !== 'boolean') throw new Error('submitForReview must be a boolean')

    const token = await requestJSON(fetchImpl, TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken,
        }),
    }, 'OAuth')
    if (typeof token.access_token !== 'string' || !token.access_token.trim()) throw new Error('OAuth returned no access token')

    const name = `publishers/${publisherId}/items/${extensionId}`
    const headers = { Authorization: `Bearer ${token.access_token}` }
    const uploaded = await requestJSON(fetchImpl, `${API}/upload/v2/${name}:upload`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/zip' }, body: archive,
    }, 'Upload', 120000)
    checkItem(uploaded, extensionId, name, 'Upload')
    let state = uploaded.uploadState
    if (state === 'SUCCEEDED' && uploaded.crxVersion !== version) {
        throw new Error('Upload returned an unexpected or missing version; refusing to submit')
    }
    for (let attempt = 0; state === 'IN_PROGRESS' && attempt < pollAttempts; attempt++) {
        await sleep(pollIntervalMs)
        const status = await requestJSON(fetchImpl, `${API}/v2/${name}:fetchStatus`, { method: 'GET', headers }, 'Upload status')
        checkItem(status, extensionId, name, 'Upload status')
        state = status.lastAsyncUploadState
    }
    if (state === 'IN_PROGRESS') throw new Error('Upload is still in progress after polling. Check the dashboard before retrying.')
    if (state !== 'SUCCEEDED') throw new Error('Upload failed or returned an unknown state; no review submission was made')

    const result = { version, extensionId, uploadState: 'SUCCEEDED', publishState: null }
    if (submitForReview) {
        const published = await requestJSON(fetchImpl, `${API}/v2/${name}:publish`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH', blockOnWarnings: true }),
        }, 'Review submission')
        checkItem(published, extensionId, name, 'Review submission')
        if (!ACCEPTED_SUBMISSIONS.has(published.state)) {
            throw new Error('Review submission returned an unsuccessful or unknown state. Inspect the uploaded draft in the dashboard.')
        }
        result.publishState = published.state
    }
    return result
}

function loadRelease(directory) {
    const release = JSON.parse(fs.readFileSync(path.join(directory, 'release.json'), 'utf8'))
    validateReleaseVersion(release.version)
    if (release.archive !== `phobiablur-v${release.version}.zip` || !/^[a-f0-9]{64}$/.test(release.sha256)) {
        throw new Error('Invalid release archive metadata')
    }
    const filename = path.join(directory, release.archive)
    const archive = fs.readFileSync(filename)
    if (createHash('sha256').update(archive).digest('hex') !== release.sha256) throw new Error('Release archive checksum mismatch')
    execFileSync('unzip', ['-t', filename], { stdio: 'pipe' })
    const manifest = JSON.parse(execFileSync('unzip', ['-p', filename, 'manifest.json'], { encoding: 'utf8' }))
    if (manifest.version !== release.version) throw new Error('Release archive manifest version mismatch')
    return { archive, version: release.version }
}

async function main() {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/upload-webstore.cjs build/store-release')
    const directory = path.resolve(process.argv[2])
    fs.rmSync(path.join(directory, 'store-result.json'), { force: true })
    const release = loadRelease(directory)
    const submit = process.env.CWS_SUBMIT_FOR_REVIEW || 'false'
    if (submit !== 'true' && submit !== 'false') throw new Error('CWS_SUBMIT_FOR_REVIEW must be true or false')
    const result = await uploadToWebStore({
        ...release,
        extensionId: process.env.CWS_EXTENSION_ID,
        publisherId: process.env.CWS_PUBLISHER_ID,
        clientId: process.env.CWS_CLIENT_ID,
        clientSecret: process.env.CWS_CLIENT_SECRET,
        refreshToken: process.env.CWS_REFRESH_TOKEN,
        submitForReview: submit === 'true',
    })
    fs.writeFileSync(path.join(directory, 'store-result.json'), `${JSON.stringify(result, null, 2)}\n`)
    const state = result.publishState || 'Draft uploaded; review not requested'
    console.log(`Chrome Web Store version ${result.version}: ${state}`)
    if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
            `## Chrome Web Store\n\n- Version: ${result.version}\n- Item: ${result.extensionId}\n- Upload: ${result.uploadState}\n- Submission: ${state}\n`)
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(`Store release failed: ${error.message}`)
        process.exitCode = 1
    })
}

module.exports = { uploadToWebStore, loadRelease }
