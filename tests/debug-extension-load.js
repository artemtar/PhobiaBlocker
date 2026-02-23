const puppeteer = require('puppeteer')
const path = require('path')

const EXTENSION_PATH = path.resolve(__dirname, '..')

async function testExtensionLoad() {
    console.log('Extension path:', EXTENSION_PATH)
    console.log('Launching browser...')

    const browser = await puppeteer.launch({
        headless: false,
        args: [
            `--disable-extensions-except=${EXTENSION_PATH}`,
            `--load-extension=${EXTENSION_PATH}`,
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ]
    })

    console.log('Browser launched')

    // Wait for extension to load
    await new Promise(resolve => setTimeout(resolve, 3000))
    console.log('Waited 3 seconds')

    // Get all targets
    const targets = await browser.targets()
    console.log('\nAll targets:')
    targets.forEach(target => {
        console.log(`  - Type: ${target.type()}, URL: ${target.url()}`)
    })

    // Find extension service worker
    const extensionTarget = targets.find(target =>
        target.type() === 'service_worker' &&
        target.url().includes('chrome-extension://')
    )

    if (extensionTarget) {
        console.log('\n✓ Extension service worker found!')
        console.log('  URL:', extensionTarget.url())

        // Extract extension ID
        const match = extensionTarget.url().match(/chrome-extension:\/\/([a-z]+)/)
        const extensionId = match ? match[1] : null
        console.log('  Extension ID:', extensionId)
    } else {
        console.log('\n✗ Extension service worker NOT found')
    }

    await browser.close()
    console.log('\nBrowser closed')
}

testExtensionLoad().catch(console.error)
