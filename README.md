# PhobiaBlocker

A Chrome Extension that automatically blurs images on web pages if they might contain content related to your specific phobias. Using Natural Language Processing (NLP), PhobiaBlocker analyzes text around images to intelligently determine which images should be blurred, helping you browse the web with confidence.

## Features

- **Intelligent Text Analysis**: Uses NLP (compromise.js) to analyze text content around images, detecting phobia-related words and their variations (plurals, verb forms, etc.)
- **Custom Word List**: Define your own list of phobia-related words that should trigger image blurring
- **Real-Time Processing**: Continuously monitors pages as they load, including infinite scroll content
- **Manual Controls**: Blur or unblur all images instantly with keyboard shortcuts or buttons
- **Adjustable Blur Intensity**: Customize how much images are blurred (0-7 levels)
- **Always-On Mode**: Option to blur all images by default, bypassing text analysis
- **Context Menu Integration**: Right-click any blurred image to unblur it permanently
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
- When disabled, images won't be analyzed or blurred automatically

**Blur Always On Toggle**
- When enabled, all images are blurred by default regardless of content
- Useful for maximum protection when browsing sensitive topics

**Blur ALL / Unblur ALL Buttons**
- Manually blur or unblur all images on the current page
- Works independently of the text analyzer

**Blur Amount Slider**
- Adjust blur intensity from 0 (no blur) to 7 (maximum blur)
- Changes apply to all tabs immediately

### Keyboard Shortcuts

- **Alt + Shift + B**: Blur all images on the current page
- **Alt + Shift + U**: Unblur all images on the current page

### Context Menu

- **Right-click on any blurred image** and select "Unblur" to permanently unblur that specific image

## How It Works

1. **Page Load**: When you visit a webpage, PhobiaBlocker scans for all images (both `<img>` tags and background images)
2. **Text Extraction**: The extension extracts text from the page body and title
3. **NLP Analysis**: Text is tokenized, normalized, and compared against your phobia word list
4. **Smart Matching**: Only words with matching first two letters are compared (performance optimization)
5. **Blur Decision**: Images are blurred if phobia-related words are detected nearby
6. **Continuous Monitoring**: A MutationObserver watches for dynamically loaded content (infinite scroll, lazy loading, etc.)

## Testing

PhobiaBlocker includes a comprehensive end-to-end test suite that verifies all functionality. The tests run separately from the extension using Puppeteer to automate Chrome with the extension loaded.

### Running Tests

```bash
cd tests
npm install
npm test
```

Or use the quick-start script:

```bash
cd tests
./run-tests.sh
```

### Test Coverage

- **Basic Functionality**: Enable/disable, blur/unblur, settings persistence
- **NLP Analysis**: Word normalization, plurals, verb forms, case insensitivity
- **Visual Content**: Images, videos, iframes, background images, dynamic content

For detailed testing documentation, see [tests/README.md](tests/README.md).
