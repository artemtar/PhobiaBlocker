# PhobiaBlocker

A Chrome Extension that automatically blurs supported visual media on web pages if they might contain content related to your specific phobias. Using Natural Language Processing (NLP), PhobiaBlocker analyzes eligible page text and the title as one page-wide input. A trigger anywhere in that input keeps all supported media blurred.

## Features

- **Page-Wide Text Analysis**: Uses NLP (compromise.js) to detect phobia-related words and their variations (plurals, verb forms, etc.) across eligible page text and the title
- **Custom Word List**: Define phobia-related words that should keep supported media blurred
- **Real-Time Processing**: Continuously monitors pages as they load, including infinite scroll content
- **Manual Controls**: Blur or unblur all currently discovered supported media with keyboard shortcuts or buttons
- **Adjustable Blur Intensity**: Customize blur strength from 0% to 100%
- **Always-On Mode**: Option to blur supported media without running text analysis
- **Embedded-Content Safety**: Keeps unchecked cross-origin iframes blurred by default, with an option to reveal them after a clean page analysis
- **Context Menu Integration**: Keep one selected media resource revealed through later analysis; a resource change restores protection
- **Lightweight**: Custom-built tag management system, optimized for performance

## Installation

### From Source (Developer Mode)

1. Clone or download this repository to your local machine
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" using the toggle in the top right corner
4. Click "Load unpacked" and select the PhobiaBlocker directory
5. The extension icon should appear in your Chrome toolbar

### Configuration

1. Click the PhobiaBlocker icon in your Chrome toolbar to open the popup
2. The extension comes with example words (clown, mice, spider) - remove or keep them as needed
3. Add your own phobia-related words in the "Your Words" section
4. Adjust settings as desired (see Usage section below)

## Usage

### Adding Phobia Words

1. Open the extension popup by clicking the PhobiaBlocker icon
2. Expand the "Your Words" section if collapsed
3. Type a word in the input field and press Enter or click the + button
4. Remove words by clicking the × button on any tag
5. Limit: 20 words, 30 characters per word

The extension automatically handles word variations:
- **Plurals**: "spider" also matches "spiders"
- **Verb forms**: "crawl" also matches "crawling", "crawled", "crawls"
- **Irregular forms**: "mouse" also matches "mice"

### Controls

**Text Analyzer Toggle**
- Enable/disable the automatic text analysis feature
- When disabled, normal analysis does not run, but a matching blacklist rule still keeps supported media blurred

**Blur Always On Toggle**
- When enabled, supported media is blurred without text analysis unless a matching whitelist rule disables protection; blacklist still has highest priority
- Useful for maximum protection when browsing sensitive topics

**Blur ALL / Unblur ALL Buttons**
- Manually blur or unblur all currently discovered supported media on the page
- Works independently of the text analyzer

**Blur Amount Slider**
- Adjust blur intensity from 0% (no blur) to 100% (maximum blur)
- A committed change is applied in place to open tabs without reloading them

### Protection Rules

- A matching blacklist rule always wins, including over a matching whitelist rule and while global protection is off
- A plain domain rule includes that domain and all of its subdomains
- URL path rules include the named path and its descendants
- **Keep unchecked embedded content blurred** is on by default. When on, cross-origin or uncertain-origin iframes stay blurred after a clean page analysis; when off, they may reveal with the rest of a clean page
- Page-wide triggers and analysis failures keep every iframe blurred in either setting; right-click **Unblur** can explicitly reveal one iframe

### Keyboard Shortcuts

- **Alt + Shift + B**: Blur currently discovered supported media on the page
- **Alt + Shift + U**: Unblur currently discovered supported media on the page

### Context Menu

- **Right-click on blurred media** and select "Unblur" to keep that specific media resource revealed through later analysis. If the element changes to a different resource, protection applies again

## How It Works

1. **Page Load**: When you visit a webpage, PhobiaBlocker protects supported media while it discovers image tags, videos, iframes, and ordinary computed CSS backgrounds
2. **Text Extraction**: The extension maintains one page-wide input from eligible page text and the title
3. **NLP Analysis**: Text is tokenized, normalized, and compared against your phobia word list
4. **Smart Matching**: Only words with matching first two letters are compared (performance optimization)
5. **Blur Decision**: A trigger anywhere in the page-wide input keeps all supported media blurred; only a successful clean result may reveal content
6. **Continuous Monitoring**: A MutationObserver watches for dynamically loaded content (infinite scroll, lazy loading, etc.)

### Visibility Limits

PhobiaBlocker covers ordinary elements with computed CSS background images, not only inline backgrounds. Current Chrome extension APIs cannot guarantee inspection of pseudo-elements, browser-internal surfaces, fenced frames, or closed shadow roots. Backgrounds introduced only by transient CSS states such as `:hover`, `:focus`, or `:checked`, without a DOM, class, style, or stylesheet mutation, also cannot be guaranteed. Ordinary computed stylesheet backgrounds remain supported. Do not assume every visual surface rendered by a browser is inspectable.

## Testing

The repository's synthetic browser tests are quarantined historical assets. They remain available for later repair, but they are not runnable through package scripts and are not current proof of browser behavior.

### Validation

Functional behavior is validated against natural content on live public websites. Do not use local fixture servers or inject trigger text or media into pages. Record URL, Asia/Tokyo timestamp, settings, actions, expected and observed state, console/runtime errors, and evidence in [docs/live-site-validation.md](docs/live-site-validation.md).

Static checks such as linting, manifest parsing, shell syntax checks, archive inspection, and code review remain valid. Storage API failure handling has been reviewed through static/code-path validation, but has not been runtime-injected.

Source-string assertions, fixed sleeps, and external iframe fixtures do not prove browser behavior. Follow the [live-site testing charter](tests/agent-testing-charter.md) for the required scenarios and evidence standard. `npm test` intentionally exits with a quarantine message.
