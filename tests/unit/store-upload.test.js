const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { inspect } = require('node:util')
const { loadRelease, uploadToWebStore } = require('../../scripts/upload-webstore.cjs')

const extensionId = 'abcdefghijklmnopabcdefghijklmnop'
const publisherId = 'test-publisher_123'
const itemName = `publishers/${publisherId}/items/${extensionId}`
const tokenUrl = 'https://oauth2.googleapis.com/token'
const uploadUrl = `https://chromewebstore.googleapis.com/upload/v2/${itemName}:upload`
const statusUrl = `https://chromewebstore.googleapis.com/v2/${itemName}:fetchStatus`
const publishUrl = `https://chromewebstore.googleapis.com/v2/${itemName}:publish`
const accessToken = 'fake-access-token'
const config = {
    archive: Buffer.from('fake zip bytes'),
    version: '1.2.3',
    extensionId,
    publisherId,
    clientId: 'fake-client-id',
    clientSecret: 'fake-client-secret',
    refreshToken: 'fake-refresh-token',
}
const token = { access_token: accessToken, token_type: 'Bearer', expires_in: 3600 }
const uploaded = { itemId: extensionId, name: itemName, uploadState: 'SUCCEEDED', crxVersion: '1.2.3' }
const uploading = { itemId: extensionId, name: itemName, uploadState: 'IN_PROGRESS' }
const status = state => ({ itemId: extensionId, name: itemName, lastAsyncUploadState: state })
const published = state => ({ itemId: extensionId, state })

function server(...responses) {
    const calls = []
    const sleeps = []
    return {
        calls,
        sleeps,
        dependencies: {
            fetchImpl: async (url, options = {}) => {
                calls.push({ url: String(url), options })
                assert.ok(responses.length, `Unexpected request to ${url}`)
                const response = responses.shift()
                if (response instanceof Error) throw response
                return response instanceof Response ? response : Response.json(response)
            },
            sleep: async milliseconds => { sleeps.push(milliseconds) },
            pollAttempts: 3,
            pollIntervalMs: 17,
        },
    }
}

function assertRequests(fake, urls) {
    assert.deepEqual(fake.calls.map(call => call.url), urls)
}

test('uploads the archive as an authenticated ZIP and leaves the item as a draft by default', async () => {
    const fake = server(token, uploaded)
    assert.deepEqual(await uploadToWebStore(config, fake.dependencies), {
        version: '1.2.3', extensionId, uploadState: 'SUCCEEDED', publishState: null,
    })
    assertRequests(fake, [tokenUrl, uploadUrl])

    const oauth = fake.calls[0].options
    assert.equal(oauth.method, 'POST')
    assert.match(new Headers(oauth.headers).get('content-type'), /^application\/x-www-form-urlencoded(?:;|$)/)
    assert.deepEqual(Object.fromEntries(new URLSearchParams(oauth.body)), {
        grant_type: 'refresh_token',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
    })

    const upload = fake.calls[1].options
    assert.equal(upload.method, 'POST')
    assert.equal(new Headers(upload.headers).get('authorization'), `Bearer ${accessToken}`)
    assert.equal(new Headers(upload.headers).get('content-type'), 'application/zip')
    assert.ok(Buffer.isBuffer(upload.body), 'the ZIP must be sent as bytes')
    assert.deepEqual(upload.body, config.archive)
})

test('waits for asynchronous upload success before submitting for review', async () => {
    const fake = server(token, uploading, status('IN_PROGRESS'), status('SUCCEEDED'), published('PENDING_REVIEW'))
    assert.deepEqual(await uploadToWebStore({ ...config, submitForReview: true }, fake.dependencies), {
        version: '1.2.3', extensionId, uploadState: 'SUCCEEDED', publishState: 'PENDING_REVIEW',
    })
    assertRequests(fake, [tokenUrl, uploadUrl, statusUrl, statusUrl, publishUrl])
    for (const call of fake.calls.slice(2, 4)) {
        assert.equal(call.options.method || 'GET', 'GET')
        assert.equal(new Headers(call.options.headers).get('authorization'), `Bearer ${accessToken}`)
    }
    assert.ok(fake.sleeps.length > 0, 'pending uploads must wait between status checks')
    assert.ok(fake.sleeps.every(milliseconds => milliseconds === 17))
    const publish = fake.calls[4].options
    assert.equal(publish.method, 'POST')
    assert.equal(new Headers(publish.headers).get('authorization'), `Bearer ${accessToken}`)
    assert.match(new Headers(publish.headers).get('content-type'), /^application\/json(?:;|$)/)
    assert.deepEqual(JSON.parse(publish.body), { publishType: 'DEFAULT_PUBLISH', blockOnWarnings: true })
})

test('reports each accepted publication result without claiming pending review is published', async t => {
    for (const state of ['PENDING_REVIEW', 'PUBLISHED', 'PUBLISHED_TO_TESTERS']) {
        await t.test(state, async () => {
            const fake = server(token, uploaded, published(state))
            const result = await uploadToWebStore({ ...config, submitForReview: true }, fake.dependencies)
            assert.equal(result.publishState, state)
            assertRequests(fake, [tokenUrl, uploadUrl, publishUrl])
        })
    }
})

test('never publishes after a failed or unrecognized upload result', async t => {
    for (const state of ['FAILED', 'NOT_FOUND', 'UPLOAD_STATE_UNSPECIFIED', 'UNRECOGNIZED_STATE']) {
        await t.test(state, async () => {
            const fake = server(token, { ...uploaded, uploadState: state })
            await assert.rejects(uploadToWebStore({ ...config, submitForReview: true }, fake.dependencies))
            assertRequests(fake, [tokenUrl, uploadUrl])
        })
    }
})

test('never publishes after asynchronous upload failure or an unrecognized status', async t => {
    for (const state of ['FAILED', 'UNRECOGNIZED_STATE']) {
        await t.test(state, async () => {
            const fake = server(token, uploading, status(state))
            await assert.rejects(uploadToWebStore({ ...config, submitForReview: true }, fake.dependencies))
            assertRequests(fake, [tokenUrl, uploadUrl, statusUrl])
        })
    }
})

test('stops polling at the configured attempt limit without publishing', async () => {
    const fake = server(token, uploading, status('IN_PROGRESS'), status('IN_PROGRESS'), status('IN_PROGRESS'))
    await assert.rejects(uploadToWebStore({ ...config, submitForReview: true }, fake.dependencies))
    assertRequests(fake, [tokenUrl, uploadUrl, statusUrl, statusUrl, statusUrl])
    assert.ok(fake.sleeps.length <= 3, 'polling must stay bounded')
})

test('rejects an uploaded version different from the archive version without publishing', async () => {
    const fake = server(token, { ...uploaded, crxVersion: '9.9.9' })
    await assert.rejects(uploadToWebStore({ ...config, submitForReview: true }, fake.dependencies))
    assertRequests(fake, [tokenUrl, uploadUrl])
})

test('rejects a different item identity returned by upload, polling, or publication', async t => {
    const wrongItem = 'pppppppppppppppppppppppppppppppp'
    const cases = [
        { stage: 'upload', responses: [token, { ...uploaded, itemId: wrongItem }], urls: [tokenUrl, uploadUrl] },
        { stage: 'polling', responses: [token, uploading, { ...status('SUCCEEDED'), itemId: wrongItem }], urls: [tokenUrl, uploadUrl, statusUrl] },
        { stage: 'publication', responses: [token, uploaded, { ...published('PENDING_REVIEW'), itemId: wrongItem }], urls: [tokenUrl, uploadUrl, publishUrl] },
    ]
    for (const { stage, responses, urls } of cases) {
        await t.test(stage, async () => {
            const fake = server(...responses)
            await assert.rejects(uploadToWebStore({ ...config, submitForReview: true }, fake.dependencies))
            assertRequests(fake, urls)
        })
    }
})

test('rejects unsuccessful or unknown publication states', async t => {
    for (const state of ['FAILED', 'STATE_UNSPECIFIED', 'UNRECOGNIZED_STATE']) {
        await t.test(state, async () => {
            const fake = server(token, uploaded, published(state))
            await assert.rejects(uploadToWebStore({ ...config, submitForReview: true }, fake.dependencies))
            assertRequests(fake, [tokenUrl, uploadUrl, publishUrl])
        })
    }
})

test('rejects malformed API responses instead of treating them as success', async t => {
    const cases = [
        { name: 'missing OAuth access token', responses: [{}], urls: [tokenUrl] },
        { name: 'invalid upload JSON', responses: [token, new Response('not JSON')], urls: [tokenUrl, uploadUrl] },
        { name: 'missing upload state', responses: [token, { itemId: extensionId }], urls: [tokenUrl, uploadUrl] },
        { name: 'missing synchronous version', responses: [token, { ...uploading, uploadState: 'SUCCEEDED' }], urls: [tokenUrl, uploadUrl] },
        { name: 'missing async state', responses: [token, uploading, {}], urls: [tokenUrl, uploadUrl, statusUrl] },
        { name: 'missing publication state', responses: [token, uploaded, { itemId: extensionId }], urls: [tokenUrl, uploadUrl, publishUrl] },
    ]
    for (const { name, responses, urls } of cases) {
        await t.test(name, async () => {
            const fake = server(...responses)
            await assert.rejects(uploadToWebStore({ ...config, submitForReview: true }, fake.dependencies))
            assertRequests(fake, urls)
        })
    }
})

test('rejects HTTP errors without leaking credentials echoed by the server', async t => {
    const secrets = [config.clientId, config.clientSecret, config.refreshToken, accessToken]
    const echoed = { error: { message: secrets.join(' ') } }
    const cases = [
        { stage: 'OAuth', prefix: [], urls: [tokenUrl] },
        { stage: 'upload', prefix: [token], urls: [tokenUrl, uploadUrl] },
        { stage: 'polling', prefix: [token, uploading], urls: [tokenUrl, uploadUrl, statusUrl] },
        { stage: 'publication', prefix: [token, uploaded], urls: [tokenUrl, uploadUrl, publishUrl] },
    ]
    for (const { stage, prefix, urls } of cases) {
        await t.test(stage, async () => {
            const fake = server(...prefix, Response.json(echoed, { status: 403 }))
            await assert.rejects(uploadToWebStore({ ...config, submitForReview: true }, fake.dependencies), error => {
                assert.match(error.message, /403|HTTP|request|failed/i)
                for (const secret of secrets) assert.ok(!inspect(error).includes(secret), 'errors must not expose credentials')
                return true
            })
            assertRequests(fake, urls)
        })
    }
})

test('does not expose credentials from network exceptions or malformed response values', async t => {
    const secrets = [config.clientId, config.clientSecret, config.refreshToken, accessToken]
    const echoed = secrets.join(' ')
    const cases = [
        { name: 'network exception and cause', response: new Error(echoed, { cause: new Error(echoed) }) },
        { name: 'JSON scalar', response: echoed },
        { name: 'unexpected upload state', response: { ...uploaded, uploadState: echoed } },
        { name: 'unexpected uploaded version', response: { ...uploaded, crxVersion: echoed } },
    ]
    for (const { name, response } of cases) {
        await t.test(name, async () => {
            const fake = server(token, response)
            await assert.rejects(uploadToWebStore({ ...config, submitForReview: true }, fake.dependencies), error => {
                for (const secret of secrets) assert.ok(!inspect(error).includes(secret), 'errors must not expose credentials')
                return true
            })
            assertRequests(fake, [tokenUrl, uploadUrl])
        })
    }
})

test('rejects missing credentials and invalid item inputs before any HTTP request', async t => {
    const cases = [
        { name: 'missing client ID', change: { clientId: '' }, error: /client.?id/i },
        { name: 'missing client secret', change: { clientSecret: undefined }, error: /client.?secret/i },
        { name: 'missing refresh token', change: { refreshToken: ' ' }, error: /refresh.?token/i },
        { name: 'publisher path injection', change: { publisherId: '../other/items' }, error: /publisher/i },
        { name: 'invalid extension ID', change: { extensionId: 'not-an-extension-id' }, error: /extension/i },
        { name: 'invalid version', change: { version: '1.2' }, error: /version/i },
        { name: 'empty archive', change: { archive: Buffer.alloc(0) }, error: /archive/i },
    ]
    for (const { name, change, error } of cases) {
        await t.test(name, async () => {
            const fake = server()
            await assert.rejects(uploadToWebStore({ ...config, ...change }, fake.dependencies), error)
            assertRequests(fake, [])
        })
    }
})

function releaseFixture(t, manifestVersion = '1.2.3') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phobiablur-store-upload-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const directory = path.join(root, 'release')
    const source = path.join(root, 'source')
    fs.mkdirSync(directory)
    fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({
        manifest_version: 3, name: 'Release validation fixture', version: manifestVersion,
    }))
    const payload = 'intact packaged asset contents'
    fs.writeFileSync(path.join(source, 'payload.txt'), payload)
    const archivePath = path.join(directory, 'phobiablur-v1.2.3.zip')
    // Store uncompressed so the corruption test can damage an asset while
    // leaving manifest.json readable and the archive directory intact.
    execFileSync('zip', ['-q', '-0', archivePath, 'manifest.json', 'payload.txt'], { cwd: source })
    const archive = fs.readFileSync(archivePath)
    const metadata = {
        version: '1.2.3',
        archive: 'phobiablur-v1.2.3.zip',
        sha256: createHash('sha256').update(archive).digest('hex'),
    }
    const metadataPath = path.join(directory, 'release.json')
    fs.writeFileSync(metadataPath, JSON.stringify(metadata))
    return { root, directory, source, archivePath, archive, metadata, metadataPath, payload }
}

test('loadRelease returns the verified archive bytes and release version', t => {
    const fixture = releaseFixture(t)
    const result = loadRelease(fixture.directory)
    assert.ok(Buffer.isBuffer(result.archive))
    assert.deepEqual(result, { archive: fixture.archive, version: '1.2.3' })
})

test('loadRelease rejects a valid ZIP changed after the release checksum was recorded', t => {
    const fixture = releaseFixture(t)
    fs.writeFileSync(path.join(fixture.source, 'payload.txt'), 'changed packaged asset contents')
    execFileSync('zip', ['-q', '-0', fixture.archivePath, 'payload.txt'], { cwd: fixture.source })
    assert.throws(() => loadRelease(fixture.directory), /checksum/i)
})

test('loadRelease rejects a matching checksum when the manifest version differs', t => {
    const fixture = releaseFixture(t, '9.9.9')
    assert.throws(() => loadRelease(fixture.directory), /manifest.*version/i)
})

test('loadRelease refuses metadata that points to a valid archive outside its directory', t => {
    const fixture = releaseFixture(t)
    fs.renameSync(fixture.archivePath, path.join(fixture.root, fixture.metadata.archive))
    fs.writeFileSync(fixture.metadataPath, JSON.stringify({
        ...fixture.metadata, archive: `../${fixture.metadata.archive}`,
    }))
    assert.throws(() => loadRelease(fixture.directory), /archive.*metadata|metadata.*archive/i)
})

test('loadRelease checks ZIP integrity even when the recorded checksum matches corrupted bytes', t => {
    const fixture = releaseFixture(t)
    const corrupted = Buffer.from(fixture.archive)
    const payloadOffset = corrupted.indexOf(fixture.payload)
    assert.notEqual(payloadOffset, -1, 'the stored ZIP must contain the fixture asset')
    corrupted[payloadOffset] ^= 0xff
    fs.writeFileSync(fixture.archivePath, corrupted)
    fs.writeFileSync(fixture.metadataPath, JSON.stringify({
        ...fixture.metadata, sha256: createHash('sha256').update(corrupted).digest('hex'),
    }))
    assert.throws(() => loadRelease(fixture.directory))
})
