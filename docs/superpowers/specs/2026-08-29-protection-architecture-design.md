# PhobiaBlocker Protection Architecture Design

**Date:** 2026-08-29  
**Status:** Approved in conversation  
**Scope:** Protection policy, storage, page analysis, visual ownership, settings, packaging, and validation

## Goal

Make PhobiaBlocker's protection behavior consistent, fail-closed, resistant to page-authored state, and efficient on dynamic real websites while preserving its page-wide detection model.

## Product contracts

### Page-wide detection

PhobiaBlocker keeps a page-wide decision. If a configured trigger is detected anywhere in the analyzed page text or title, all visual media in that page stays blurred. It will not implement semantic or per-card media scopes.

New text and media are protected before asynchronous analysis completes. A clean result may reveal content; an error, timeout, invalid response, or settings-read failure must leave it blurred.

### Protection precedence

All extension contexts use this single precedence order:

1. A matching blacklist rule selects `ALWAYS_BLUR`.
2. Otherwise, a matching whitelist rule selects `DISABLED`.
3. Otherwise, global protection being off selects `DISABLED`.
4. Otherwise, Always Blur Media selects `ALWAYS_BLUR`.
5. Otherwise, the page selects `ANALYZE`.

Blacklist therefore wins over whitelist and also remains active while global protection is off. A settings-read failure selects fail-closed `ALWAYS_BLUR`; it must not be converted into a default or clean analysis result.

### Cross-origin iframe setting

Add the following global setting, enabled by default:

**Keep unchecked embedded content blurred**

> Videos, maps, posts, and advertisements can be embedded from another website. PhobiaBlocker cannot reliably inspect what is inside them.
>
> **On:** Embedded content stays blurred until you reveal it manually. This provides stronger protection, but harmless embedded content will also be hidden.
>
> **Off:** Embedded content appears when the rest of the page is safe. This makes browsing easier, but the embed could still contain something you asked PhobiaBlocker to hide.

The stored key is `keepCrossOriginIframesBlurred`, with a default of `true` for both new and existing installations where the key is absent.

The setting only changes the result after a successful clean page analysis:

- A page-wide trigger keeps every iframe blurred.
- A failed, timed-out, or unavailable analysis keeps every iframe blurred.
- A clean result reveals same-origin iframes.
- A clean result keeps cross-origin iframes blurred when the setting is on.
- A clean result reveals cross-origin iframes when the setting is off.
- An explicit context-menu Unblur action may reveal one iframe in either mode.

An iframe is treated as cross-origin when its resolved source origin differs from the containing document. An unparseable, opaque, sandboxed, or otherwise uncertain origin is treated as cross-origin.

### Explicit user reveals

Context-menu Unblur remains a persistent exception for the selected media resource across later page analysis. The exception is owned by extension-internal state, not by a DOM class or attribute that the website can pre-create.

Use a `WeakMap<Element, MediaFingerprint>` for explicit per-element reveals. Rendering classes and attributes are outputs only; protection decisions never read them as authorization. The generic protection stylesheet must not exempt an element merely because it already has `phobia-permanent-unblur` or `phobia-noblur`.

The fingerprint includes the resource-defining state for the media type:

- Images: `src`, `srcset`, and resolved current source.
- Videos: `src`, `poster`, resolved current source, and child `<source>` values.
- Iframes: `src` and `srcdoc` state.
- CSS backgrounds: computed `background-image`.

Changing the fingerprint invalidates the exception and protects the new resource. Blur All clears all explicit exceptions. Unblur All reveals only the media that exists when the command runs; future media follows normal analysis.

## Architecture

### Shared policy module

Create `js/shared-policy.js` as a dependency-light classic script exposed through one frozen `globalThis.PhobiaBlockerPolicy` namespace. It has no DOM or Chrome API dependency.

It owns:

- `STORAGE_KEYS` and `DEFAULTS`.
- Protection modes: `DISABLED`, `ALWAYS_BLUR`, and `ANALYZE`.
- Target-word validation and normalization.
- Site-rule parsing, normalization, and URL matching.
- `resolveProtectionMode(settings, url)` implementing the precedence contract.

All background, content, popup, settings, early-protection, and offscreen code consumes this module instead of declaring independent defaults or matchers.

Site matching preserves the current enforcement behavior: a plain base domain matches that domain and its subdomains. Hostnames are normalized to lowercase. URL paths retain case and match the named path plus descendants. Settings copy must describe this behavior rather than calling a base domain an exact-only match.

### Storage module

Create `js/storage.js` as the only callback/error adapter for `chrome.storage.sync`, exposed through `globalThis.PhobiaBlockerStorage`.

Its promise-based operations must distinguish these cases:

- Missing key: return the shared default when the caller requests defaults.
- Present key: return the stored value after type validation.
- Chrome API failure: reject with the `chrome.runtime.lastError` message.

Failed reads never write defaults. Failed writes reject. UI state changes only after a write succeeds; failures retain the prior UI value and display a clear error.

Only `background.js` initializes missing keys during `runtime.onInstalled`. Other reads may use defaults without writing them back.

`chrome.storage.onChanged` is the post-commit event bus. Content scripts reevaluate the current page in place after committed changes. Popup and settings code will not broadcast speculative messages or reload tabs.

### Protection controller

`js/js.js` owns one page state rather than multiple semantic scope states. The state contains:

- Current protection mode and a monotonically increasing generation.
- The current page-wide text index and analysis result.
- Registered visual nodes and computed-background nodes.
- Extension-owned explicit reveal fingerprints.
- Pending analysis and mutation work.

Every settings or target-word change increments the generation. Results from an older generation are discarded, preventing a stale clean result from revealing content after a blacklist or setting change.

Mode transitions happen without navigation:

- `DISABLED`: cancel analysis, stop protection observers and word covers, reveal content, and mark the document disabled.
- `ALWAYS_BLUR`: cancel analysis, enable observers, discover visual content, and keep everything blurred.
- `ANALYZE`: protect pending content, enable observers, refresh the page-wide text state, and analyze it.

### Page-wide incremental text index

Remove semantic-scope resolution and repeated whole-page `body.innerText` hashing. Build one page-wide index of eligible rendered text nodes at initialization and maintain it from `childList`, `characterData`, and relevant attribute mutations.

The index excludes hidden content, scripts, styles, form controls, editable regions, extension-created word covers, and other existing excluded content. It records normalized text fragments or tokens per source node so additions, changes, and removals update only affected entries. Title changes update the same page-wide input. Visibility-affecting `class`, `style`, `hidden`, and `aria-hidden` changes invalidate the affected subtree.

Target-word changes may rebuild normalization artifacts and re-evaluate the existing index; ordinary page mutations must not force a new layout-dependent whole-body `innerText` scan.

Mutation handling has two stages:

1. In the observer turn, synchronously protect newly discovered media/backgrounds and immediately cover direct target-word matches in changed text.
2. Coalesce the affected text-index changes into one asynchronous NLP request for the current generation.

This removes the existing stacked mutation and word-cover delays that can expose newly inserted target text for hundreds of milliseconds. Internal DOM changes made while applying covers are marked and ignored by the observer to prevent feedback loops.

### Visual and CSS-background protection

Use one static protection stylesheet as the source of shared blur, preview, word-cover, disabled-state, and pending-state rules. Remove the duplicated rules from `css/early-blur.css`, `css/style.css`, and the JavaScript CSS string in `js/early-blur.js`. Component-specific CSS remains separate only when it is not protection state.

At document start, a pending background rule suppresses CSS background images until the initial computed-background discovery has registered and protected them. The discovery checks computed styles, not only inline `style` attributes or a fixed list of element names.

The mutation observer checks added elements and `class`/`style` changes before the next asynchronous analysis. Adding or changing a stylesheet invalidates computed-background discovery so stylesheet-defined images are registered. Removed elements are pruned from the registry. These rules cover ordinary elements such as `<p class="hero">` whose background comes from a stylesheet.

Pseudo-element, browser-internal, fenced-frame, and closed-shadow-root rendering cannot be reliably inspected through the current Chrome extension APIs. Those limitations must be stated rather than represented as covered.

### Target words

Popup and analyzer use the same validator. A new trigger must:

- Contain at least three Unicode letters and no more than 30 total characters.
- Be one word, with hyphens permitted only between letter groups.
- Contain no whitespace, digits, or other punctuation.
- Not duplicate an existing normalized word.
- Respect the existing maximum of 20 stored triggers.

Examples rejected before persistence include `ox`, `spider man`, and `snake2`. The popup explains the rule instead of silently ignoring input.

Existing invalid stored entries are displayed with an invalid warning and excluded from analysis. They are not silently deleted. The user may remove them explicitly.

### Settings UI

Add a Protection section to `settings.html` for **Keep unchecked embedded content blurred**, using the approved plain-language description and consequences. The switch reads and writes `keepCrossOriginIframesBlurred` through the shared storage module.

Site-rule add/remove operations await storage success before updating their rendered lists. Popup site status uses the same resolver as enforcement, including blacklist-first precedence and path-aware matches.

## Background and offscreen behavior

`background.js` imports the shared policy and storage scripts. It caches target words only after a successful, validated read. If the cache is unavailable because storage failed, analysis requests immediately return the fail-closed result.

The offscreen analyzer validates inputs defensively with the shared target-word contract. It returns structured failure rather than turning an invalid request into a clean page. Callers convert unavailable, malformed, or timed-out responses to the fail-closed result.

## Packaging

`pack.sh` must never update an existing release ZIP in place.

For the selected version it will:

1. Keep the existing explicit production allowlist.
2. Create a unique temporary directory beside the destination archive.
3. Build a brand-new ZIP inside that directory.
4. Run `unzip -t` and verify that the archived `manifest.json` contains the selected version.
5. Atomically replace `phobiablocker-v<version>.zip` only after validation succeeds.
6. Remove the exact temporary directory through a trap.

A failed build leaves any existing release ZIP untouched. Rebuilding the same version cannot retain a file that is no longer in the allowlist.

## Validation policy

For this change, synthetic/local browser fixtures and automated behavior suites are quarantined: they remain in the repository for later repair but are not run and are not represented as current proof of behavior. Default and named package test commands that run those suites are disabled with an explicit quarantine message. Documentation and the testing charter must stop claiming coverage that is not behaviorally asserted.

Functional validation uses natural content on live public websites through the connected Chrome browser. No local fixture server and no injected trigger/media DOM are used. The live report records URL, timestamp, settings, observed state, console/runtime errors, and screenshots where useful.

Live scenarios cover:

- A naturally occurring trigger causes page-wide visual protection.
- A live page with stylesheet-defined backgrounds is protected.
- Naturally loaded dynamic content does not expose matching target text while pending.
- Blacklist wins over whitelist and global disable.
- Editing a site rule changes protection without navigation or losing a form value.
- The cross-origin iframe switch exhibits both documented modes on a live embedded-content page.
- Context-menu Unblur survives reanalysis for the same resource but not a changed resource.
- Invalid target words are rejected with an explanation.

Lint, manifest parsing, shell syntax checks, fresh-archive inspection, and code review may still run because they are static/build validation, not synthetic website behavior tests. Failures that cannot be safely forced on a live website, especially `chrome.storage` API errors, are reported as code-reviewed but not runtime-injected.

## Documentation consistency

Update `AGENTS.md`, README/user help, the testing charter, and the bug-fix log to match these contracts:

- Detection is page-wide, not semantic-local.
- Cross-origin iframe handling is user-configurable and defaults to safer permanent blur.
- Blacklist precedence is authoritative.
- Base domain rules include subdomains.
- Automated fixture tests are quarantined and are not current proof.
- Known browser/API visibility limits are explicit.

## Non-goals

- Semantic or per-media text scopes.
- A bundler or migration to JavaScript modules.
- A service-worker-owned RPC layer for every settings operation.
- Deleting the quarantined synthetic test files.
- Silently cleaning existing invalid trigger words.
- Claiming complete coverage of inaccessible rendering surfaces.
