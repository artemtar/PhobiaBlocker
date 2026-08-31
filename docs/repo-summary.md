# Repository Summary

Created: 2026-05-06
Updated: 2026-08-29 for the approved protection architecture

This summary was written after reading all Markdown files currently in the repo. It is meant to be a practical working reference for future coding sessions.

## What This Repo Is

This repository is for **PhobiaBlocker**, a Chrome/Chromium Manifest V3 extension that protects users from phobia-triggering visual content while browsing.

The core product idea is:

- Blur visual content first
- Analyze eligible page text and the title as one page-wide input
- Keep all supported visual content blurred when that input matches
- Unblur content only when it appears safe
- Fall back to "stay blurred" when anything fails

The repo includes the extension itself, design and support documentation, Chrome Web Store publishing materials, quarantined historical browser fixtures, and a live-public-site validation charter.

## Product Model

Across the docs, PhobiaBlocker is described as supporting:

- Regular images
- Background images
- Videos
- Iframes and embedded media
- Dynamic/infinite-scroll content

Users can configure:

- Trigger words / phobia words
- Blur intensity
- Extension enabled state
- "Blur always on" mode
- Manual blur/unblur controls
- Keyboard shortcuts
- Per-item unblur via context menu

Newer docs also strongly suggest the product has expanded beyond the original popup-only model to include or plan:

- Site whitelist / blacklist rules
- Hover preview
- Detected-word counters or richer status reporting
- Debug mode
- A fuller settings surface

## Core Engineering Themes

The docs consistently frame the extension around four big ideas:

### 1. Safety-first fail-closed behavior

The most important design principle is: **if anything is uncertain or broken, blur wins**.

Supporting docs describe a multi-layer fail-safe system:

- A static manifest-injected protection stylesheet at `document_start`
- Early direct-word covering while the document and settings load
- Protected defaults in visual-node initialization
- Defensive settings loading
- Error-tolerant main execution
- Defensive DOM operations
- Conservative unblur conditions
- MutationObserver guards

This is one of the clearest through-lines in the repo.

### 2. NLP-based trigger detection

The extension uses NLP normalization to match variations of trigger words, including:

- plurals
- verb forms
- irregular forms like `mouse` / `mice`

Multiple docs mention compromise.js and normalization parameters as a core part of the implementation.

### 3. Real-world web compatibility

A lot of the documentation is about surviving modern web apps:

- React / Next.js / Vue compatibility
- dynamic content
- infinite scroll
- lazy loading
- cross-origin iframe behavior
- configurable fail-closed cross-origin iframe behavior
- form and editable-text exclusion from text indexing

### 4. Performance and memory discipline

Recent documentation focuses heavily on:

- jQuery removal
- mutation-driven incremental text indexing
- avoiding observer feedback loops
- pruning detached nodes
- replacing strong DOM caches with `WeakMap` / `WeakSet`
- reducing typing lag in editors

## Architecture Snapshot From Docs

At a high level, the repo is described as having:

- a **content script** that does the heavy lifting
- a **background/service worker** for context menu and install/update logic
- a **popup UI** for core controls
- newer settings-related surfaces implied by current docs and open files

Commonly referenced internal concepts include:

- `VisualNode` and `VisualRegistry`
- `PhobiaBlockerPageTextIndex`
- `WordCoverManager`
- `Controller`
- `MutationObserver`-driven updates
- shared `PhobiaBlockerPolicy` and `PhobiaBlockerStorage` namespaces

## Important History Captured In Docs

The Markdown set documents a lot of recent stabilization work. The most important themes are:

### Data safety

- A critical storage reset bug was fixed so user trigger words are not overwritten during updates or sync delays.
- Storage initialization was moved away from content scripts and handled more carefully in background/popup flows.

### Page compatibility

- Early blur injection was changed to be less disruptive to framework-managed pages.
- Defensive null checks and try/catch protection were added around observer and DOM logic.

### Memory and state correctness

- Detached node accumulation and listener leaks were fixed.
- Generation counters were added for race conditions during async analysis or toggle changes.
- Background-image and iframe edge cases were tightened up.

### Input/editor protection

- Form controls and editable text are excluded from the text index. Iframes remain visual content and follow the page-wide result plus the cross-origin safety switch.

## Testing Story

The Puppeteer/Playwright fixture files remain in the repository as quarantined historical assets. Package scripts intentionally do not run them, and source-string checks, external iframe fixtures, or fixed sleeps are not current proof of browser behavior.

Functional validation uses natural content on live public websites under `tests/agent-testing-charter.md`. Evidence belongs in `docs/live-site-validation.md` and must record the URL, settings, actions, observed behavior, runtime errors, and supporting screenshots where useful. Linting, JSON parsing, shell syntax, isolated archive inspection, and code review remain allowed static/build checks.

## Publishing / Productization

The repo is not just engineering code. It also contains:

- privacy policy copy
- Chrome Web Store listing drafts
- screenshot and promo asset guidance
- publishing checklist docs

The store materials suggest the project is being positioned as:

- accessibility / well-being tooling
- privacy-first
- local-only processing
- broader than simple keyword matching

## Doc Freshness Notes

The Markdown files do **not** all describe the same product moment. There is clear evolution.

### Likely older / partially stale docs

- `README.md`
- `CLAUDE.md`
- parts of `support_documents/VIDEO_SUPPORT.md`
- parts of the older store listing and publishing docs

These describe an earlier state where the extension was more popup-centric and the behavior was simpler.

### Current source documents

- `docs/superpowers/specs/2026-08-29-protection-architecture-design.md`
- `docs/live-site-validation.md`
- `docs/bugfix-log.md`
- `tests/agent-testing-charter.md`

These are more specific, more defensive, and better reflect recent engineering concerns.

## Biggest Inconsistencies To Remember

When working in this repo later, assume the docs may disagree until verified against code.

The main remaining risk is historical material that describes superseded classes, fixture-test claims, editor exclusions, or unconditional iframe behavior. Verify behavior against the 2026-08-29 approved spec and production source before relying on older support or store-listing text.

## Practical Working Summary

If I had to keep one short mental model:

**PhobiaBlocker is a safety-first Chrome extension that protects supported visual media by default, makes one local page-wide NLP decision, applies committed settings without navigation, keeps explicit reveals in extension-owned state, and currently relies on live-public-site functional validation plus static/build checks.**

## Suggested Source-of-Truth Order

When future work needs context, start here:

1. `docs/superpowers/specs/2026-08-29-protection-architecture-design.md`
2. production source (`js/shared-policy.js`, `js/storage.js`, `js/js.js`, and `js/offscreen.js`)
3. `tests/agent-testing-charter.md` and `docs/live-site-validation.md`
4. `docs/bugfix-log.md` for explicitly historical context
5. targeted support docs only after checking whether the approved spec supersedes them
