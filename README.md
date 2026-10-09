# PhobiaBlur

A Chrome extension for more control over phobia triggers while browsing. Add trigger words, adjust the blur, and choose when to preview or reveal media.

PhobiaBlur analyzes page text. When it finds one of your words or a supported word variation, it keeps the page's supported images, videos, backgrounds, and embedded frames blurred. It does not recognize what is inside an image or video, and it cannot guarantee a trigger-free experience.

## Controls

- **Smart detection** checks page text for your trigger words and supported English word forms, such as "mouse" and "mice".
- **Always blur** keeps supported media blurred regardless of text matches while protection is enabled.
- **Cover words** visually covers literal matching trigger words in page text. It does not inspect text inside images or cover every NLP word variation.
- **Blur all / Unblur all** changes the current page manually. Right-click **Unblur** reveals an individual item; reveal state is not permanent across page reloads or media changes.
- **Blur amount** adjusts the popup slider from 0 to 100. This controls blur strength, not a percentage of guaranteed protection.
- **Hover preview** temporarily reduces the blur. Choose the remaining blur strength in Settings; moving away restores the normal blur.
- **Site rules** pause automatic protection on whitelisted sites or keep media blurred on blacklisted sites. Rules support domains, subdomains, and paths; the blacklist takes precedence.

Protection follows media, text, and embedded frames inside open shadow roots used by web components. Closed shadow roots are not inspected. Debug logging is off by default; Settings can enable diagnostic counts and state changes without logging page text, trigger words, or URLs.

After Smart detection clears a page, unchanged media stays visible while newly displayed text is analyzed. New or changed media remains protected during that analysis. A newly added literal trigger re-blurs the page immediately; a match found only through word-form analysis re-blurs it when the result returns. Navigation, protection-setting changes, and failed analysis do not retain automatic clearance.

Editable text is excluded from word covering. Background images on controls and containers holding editors are hidden separately so their text stays readable. Same-origin editor frames are released only after their content controller confirms protection of the media inside; other frames retain the usual conservative handling.

## Install and configure

1. Clone or download this repository.
2. Open `chrome://extensions/` and enable **Developer mode**.
3. Select **Load unpacked** and choose the repository directory.
4. Open the PhobiaBlur popup and review the default trigger words (`clown`, `mice`, `spider`).
5. Add or remove entries in **Trigger words**, then adjust blur and site preferences.

You can save up to 20 trigger words. Each entry must be a single word of 3–30 characters; internal hyphens are supported.

Default shortcuts are `Alt+Shift+B` for Blur all, `Alt+Shift+U` for Unblur all, and `Alt+Shift+W` for word covers. Chrome may assign different shortcuts; inspect or change them at `chrome://extensions/shortcuts`.

## Privacy

Page-text analysis runs in the browser using bundled code. Trigger words and preferences use `chrome.storage.sync` and may sync through Chrome when enabled. See the [privacy policy](support_documents/PRIVACY_POLICY.md).

The source repository remains [artemtar/PhobiaBlocker](https://github.com/artemtar/PhobiaBlocker). Internal preference keys and extension identifiers are preserved through the product rename.

## Submission assets

The [submission package](store-assets/refresh-2026-09-22/REVIEW.md) contains the approved PhobiaBlur branding, five cat-meme screenshots, promotional images, final listing text, and the release candidate. The fifth screenshot demonstrates word covers.

Use the [canonical listing](store-assets/STORE_LISTING.md) and [publishing guide](support_documents/PUBLISHING_GUIDE.md) for submission. Update the existing Chrome Web Store item to preserve its extension ID and installed users.

## Validation and packaging

Run the supported checks from the repository root:

```sh
npm run test:unit
npm run lint
bash -n pack.sh pack-dev.sh
```

The unit suite includes archive-content checks. Root `npm test` and the historical synthetic browser suites are quarantined; they are not a release gate. Validate UI and media behavior with the loaded extension in Chrome. See [tests/README.md](tests/README.md).

Create a release archive with an explicit version:

```sh
npm run prod -- 1.3.1
```

This updates `manifest.json` and creates `phobiablur-v1.3.1.zip` containing runtime files only. Check all pending working-tree changes before packaging. A version submitted to the existing Web Store item must exceed its latest uploaded version, including unpublished drafts. Use a new explicit version for a subsequent release.

`npm run dev` creates a local DEV build; it is not the submission artifact.

## Automated store updates

The **Release to Chrome Web Store** GitHub Actions workflow accepts a new version, runs the supported checks, builds a verified ZIP, and uploads it to the existing store item. Uploading a draft is the default; review submission is an explicit workflow option.

See the [automation setup guide](support_documents/CHROME_WEB_STORE_AUTOMATION.md) for the required GitHub environment, variables, OAuth secrets, and release steps. The workflow builds committed code from the default branch; local changes must be committed and pushed before they can be released.
