/* eslint-env node */
'use strict'

// Uploads the ZIP verified by prepare-store-release.cjs to the existing store item
// and optionally submits it for review. Runs in the CI job that holds the publisher
// credentials, so every error path reports only fixed text plus an HTTP status:
// never response bodies, error causes or header values, which may echo secrets.
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { validateReleaseVersion } = require('./prepare-store-release.cjs')

// API contracts: support_documents/CHROME_WEB_STORE_AUTOMATION.md#api-references
const API = 'https://chromewebstore.googleapis.com'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
// ItemState values that mean the store accepted the submission. PENDING_REVIEW is
// accepted but not yet live. Any other value, including ones this script does not
// recognise, fails the run so a bad submission is never reported as done.
const ACCEPTED_SUBMISSIONS = new Set(['PENDING_REVIEW', 'PUBLISHED', 'PUBLISHED_TO_TESTERS'])

// Every store call goes through here so the no-leak rule is enforced in one place.
async function requestJSON(fetchImpl, url, options, stage, timeout = 30000) {
    let response
    try {
        // redirect: 'error' so a reply can only come from the URL this script addressed:
        // following one would re-send the token (same origin) or the ZIP body (307/308)
        // to an endpoint chosen by the response. The timeout bounds a hung connection so
        // the job fails by itself instead of hitting the runner limit.
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
    // Callers read named fields; null, a scalar or an array would surface later as a
    // TypeError or a missing field, so reject it here with the stage name and nothing
    // from the body.
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${stage} returned an invalid response`)
    return data
}

// Every response must name the item we targeted; a mismatch means a misconfigured
// publisher/extension pair or a response for another item, and continuing could
// upload or publish against the wrong listing. `name` is absent from the publish
// response, hence the undefined check.
function checkItem(data, extensionId, name, stage) {
    if (data.itemId !== extensionId || (data.name !== undefined && data.name !== name)) {
        throw new Error(`${stage} returned an unexpected item identity; refusing to continue`)
    }
}

// fetch, sleep and the poll limits are injectable so the unit suite drives the state
// machine without network or real timers. 60 x 5 s is the five-minute wait for an
// asynchronous upload documented in support_documents/CHROME_WEB_STORE_AUTOMATION.md.
async function uploadToWebStore(config, {
    fetchImpl = globalThis.fetch,
    sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    pollAttempts = 60,
    pollIntervalMs = 5000,
} = {}) {
    const { archive, version, extensionId, publisherId, clientId, clientSecret, refreshToken, submitForReview = false } = config
    // All input checks run before the first request so bad configuration never
    // reaches Google. Extension IDs are 32 letters a-p (Chrome's hex-in-letters
    // encoding); the publisher ID is interpolated into the URL path, so the character
    // whitelist also blocks path traversal to another publisher's item.
    validateReleaseVersion(version)
    if (!Buffer.isBuffer(archive) || archive.length === 0) throw new Error('A nonempty ZIP archive is required')
    if (typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId)) throw new Error('A valid CWS_EXTENSION_ID is required')
    if (typeof publisherId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(publisherId)) throw new Error('A valid CWS_PUBLISHER_ID is required')
    for (const [key, value] of Object.entries({ clientId, clientSecret, refreshToken })) {
        if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing OAuth ${key}`)
    }
    if (typeof submitForReview !== 'boolean') throw new Error('submitForReview must be a boolean')

    // The long-lived refresh token is exchanged for a short-lived access token that
    // lives only in this process; neither is ever written to the result file or logs.
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
    // The media endpoint takes the raw ZIP bytes; the longer timeout covers the body
    // transfer, which the 30 s default for the JSON calls would not.
    const uploaded = await requestJSON(fetchImpl, `${API}/upload/v2/${name}:upload`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/zip' }, body: archive,
    }, 'Upload', 120000)
    checkItem(uploaded, extensionId, name, 'Upload')
    let state = uploaded.uploadState
    // crxVersion is the version the store parsed out of the uploaded manifest. If it
    // differs from the verified release version the wrong bytes were sent, and that
    // draft must not be submitted.
    if (state === 'SUCCEEDED' && uploaded.crxVersion !== version) {
        throw new Error('Upload returned an unexpected or missing version; refusing to submit')
    }
    // The store may finish processing asynchronously; its result is then exposed
    // through fetchStatus as lastAsyncUploadState. Polling is bounded on purpose and a
    // request is never retried: a write may already have reached Google.
    for (let attempt = 0; state === 'IN_PROGRESS' && attempt < pollAttempts; attempt++) {
        await sleep(pollIntervalMs)
        const status = await requestJSON(fetchImpl, `${API}/v2/${name}:fetchStatus`, { method: 'GET', headers }, 'Upload status')
        checkItem(status, extensionId, name, 'Upload status')
        // fetchStatus reports only the outcome (lastAsyncUploadState), not the parsed
        // version, so the crxVersion check above cannot be repeated here; on this path the
        // version guarantee rests on loadRelease having verified the ZIP before upload.
        state = status.lastAsyncUploadState
    }
    if (state === 'IN_PROGRESS') throw new Error('Upload is still in progress after polling. Check the dashboard before retrying.')
    // Only the exact SUCCEEDED string proceeds; the unknown value itself is not
    // echoed into the message because it came from the network.
    if (state !== 'SUCCEEDED') throw new Error('Upload failed or returned an unknown state; no review submission was made')

    const result = { version, extensionId, uploadState: 'SUCCEEDED', publishState: null }
    if (submitForReview) {
        // blockOnWarnings: a package the store flags with warnings stays a draft to be
        // inspected in the dashboard rather than entering review automatically.
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

// The release directory arrives through an artifact download from another job, so
// nothing in it is trusted: the metadata, the checksum, the ZIP structure and the
// packaged manifest are all re-verified before the credentials are used.
function loadRelease(directory) {
    const release = JSON.parse(fs.readFileSync(path.join(directory, 'release.json'), 'utf8'))
    validateReleaseVersion(release.version)
    // The archive name in the metadata must equal the one derived from the version, so
    // release.json cannot point at another file (e.g. "../other.zip").
    if (release.archive !== `phobiablur-v${release.version}.zip` || !/^[a-f0-9]{64}$/.test(release.sha256)) {
        throw new Error('Invalid release archive metadata')
    }
    const filename = path.join(directory, release.archive)
    const archive = fs.readFileSync(filename)
    if (createHash('sha256').update(archive).digest('hex') !== release.sha256) throw new Error('Release archive checksum mismatch')
    // A matching checksum only proves release.json and the ZIP agree with each other,
    // not that the ZIP is a sound archive; unzip -t re-reads every entry's CRC. stdout
    // is captured by default; stdio 'pipe' also captures stderr so unzip's diagnostics
    // on a bad archive stay out of the job log.
    execFileSync('unzip', ['-t', filename], { stdio: 'pipe' })
    const manifest = JSON.parse(execFileSync('unzip', ['-p', filename, 'manifest.json'], { encoding: 'utf8' }))
    if (manifest.version !== release.version) throw new Error('Release archive manifest version mismatch')
    return { archive, version: release.version }
}

async function main() {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/upload-webstore.cjs build/store-release')
    const directory = path.resolve(process.argv[2])
    // Remove a previous run's result first so a failed run cannot leave a stale
    // success record for the artifact step to pick up.
    fs.rmSync(path.join(directory, 'store-result.json'), { force: true })
    const release = loadRelease(directory)
    // The workflow's boolean input reaches the environment as the strings "true" or
    // "false"; anything else is a wiring mistake and must not default either way.
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
    // The result file and the summary carry only version, item ID and state names;
    // store-result.json becomes a downloadable artifact, so no token may land in it.
    fs.writeFileSync(path.join(directory, 'store-result.json'), `${JSON.stringify(result, null, 2)}\n`)
    const state = result.publishState || 'Draft uploaded; review not requested'
    console.log(`Chrome Web Store version ${result.version}: ${state}`)
    // GITHUB_STEP_SUMMARY is the file GitHub Actions renders as the job summary.
    if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
            `## Chrome Web Store\n\n- Version: ${result.version}\n- Item: ${result.extensionId}\n- Upload: ${result.uploadState}\n- Submission: ${state}\n`)
    }
}

if (require.main === module) {
    // Print only the message, never the error object: a stack or cause could carry
    // request details into the job log.
    main().catch(error => {
        console.error(`Store release failed: ${error.message}`)
        process.exitCode = 1
    })
}

module.exports = { uploadToWebStore, loadRelease }
