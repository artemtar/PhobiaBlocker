# PhobiaBlocker Live-Site Testing Charter

## Mission

Validate PhobiaBlocker behavior on natural content from live public websites without substituting synthetic fixtures, injected trigger text, injected media, or source inspection for browser evidence.

The approved behavior contract is `docs/superpowers/specs/2026-08-29-protection-architecture-design.md`. Record every functional run in `docs/live-site-validation.md`.

## Validation Status

- Existing automated browser suites, local pages, and fixtures are quarantined historical assets. They remain in the repository for later repair but are not current proof of browser behavior.
- `npm test` is intentionally non-runnable and exits with the quarantine message. Do not invoke individual historical suites through alternate commands.
- Source-string assertions, fixed sleeps, and external iframe fixtures do not prove browser behavior.
- Storage API failure handling has received static/code-path validation only. It has not been runtime-injected, and documentation must not claim otherwise.
- Static and build checks remain useful: lint, JSON and manifest parsing, shell syntax, fresh-archive inspection, and code review.

## Behavior Contracts Under Validation

### Page-Wide Detection

The extension makes one page-wide decision from eligible page text and the title. A configured trigger anywhere in that input keeps all supported media blurred. There are no semantic, per-card, or per-media text scopes.

New text and media stay protected while analysis is pending. Only a successful clean result may reveal content. An error, timeout, malformed response, unavailable analyzer, or settings-read failure leaves content blurred.

### Policy Precedence

Validate this order:

1. A matching blacklist rule selects `ALWAYS_BLUR`.
2. Otherwise, a matching whitelist rule selects `DISABLED`.
3. Otherwise, global protection being off selects `DISABLED`.
4. Otherwise, Always Blur Media selects `ALWAYS_BLUR`.
5. Otherwise, the page selects `ANALYZE`.

Blacklist therefore wins over whitelist and remains active while global protection is off. A plain domain rule matches the named domain and its subdomains. A URL path rule matches the named path and its descendants.

### Cross-Origin Iframes

`keepCrossOriginIframesBlurred` is enabled by default for both new and existing installations where the key is absent.

- A page-wide trigger or analysis failure keeps every iframe blurred.
- A successful clean result reveals same-origin iframes.
- A successful clean result keeps cross-origin and uncertain-origin iframes blurred when the setting is on.
- A successful clean result allows cross-origin iframes to reveal when the setting is off.
- Explicit context-menu **Unblur** may reveal one iframe in either mode.

### Explicit Reveals

Context-menu **Unblur** persists for the selected media resource across later analysis. The exception must not authorize a different resource that later reuses the same DOM element. **Blur All** clears explicit exceptions. **Unblur All** affects only media present when the command runs; future media follows normal policy.

### Supported and Inaccessible Surfaces

Validate ordinary images, videos, iframes, and elements whose computed `background-image` comes from a stylesheet. Do not generalize that evidence to every browser-rendered surface. Pseudo-elements, browser-internal surfaces, fenced frames, and closed shadow roots cannot be guaranteed through current Chrome extension APIs. Backgrounds introduced only by transient CSS states such as `:hover`, `:focus`, or `:checked`, without a DOM, class, style, or stylesheet mutation, also cannot be guaranteed. Ordinary computed stylesheet backgrounds remain supported.

## Live-Site Rules

1. Use the connected Chrome browser with the unpacked extension under test.
2. Use natural content already present or naturally loaded by the public site.
3. Do not run a local fixture server.
4. Do not inject target text, media elements, mutations, errors, or replacement resources into the page.
5. Record the exact URL, Asia/Tokyo timestamp, relevant settings, action, expected result, observed result, console/runtime errors, and evidence.
6. Prefer screenshots plus computed-style/DOM inspection where each is available. DOM classes are rendering outputs, not authoritative proof of extension-owned policy state.
7. Wait for an observable state transition with a bounded timeout. Do not treat an arbitrary sleep as proof that processing completed.
8. Do not pre-fill observations. Record only what was actually observed during the run.

## Required Live Scenarios

### 1. Page-Wide Trigger

Use a live page that naturally contains a configured valid trigger and supported media in more than one page region. Confirm that media outside the trigger's immediate section remains protected, demonstrating the page-wide decision.

### 2. Stylesheet Background

Use a live page with an ordinary element whose visible background comes from a stylesheet rather than an inline `style` attribute. Confirm it is protected when page policy requires blur.

### 3. Dynamic Content

Use a page that naturally loads additional content through scrolling, pagination, or client-side navigation. Confirm newly loaded media is protected before pending analysis can produce a clean result, and that naturally added matching text causes the page-wide result to be reevaluated.

### 4. Policy Precedence

For one live URL, create matching blacklist and whitelist rules, then turn global protection off. Confirm the blacklist still selects blur. Remove only the blacklist and confirm the whitelist can disable protection. Also verify that a plain base-domain rule applies on a naturally visited subdomain.

### 5. No-Reload Settings

Change a site rule or protection setting while a live page contains an in-progress form value. Confirm protection updates without navigation and the form value remains intact.

### 6. Iframe Setting On and Off

Use a live page with naturally embedded cross-origin content and a clean page-wide analysis result. With **Keep unchecked embedded content blurred** on, confirm the embed stays blurred. Turn the setting off and confirm the clean embed may reveal without requiring navigation. Re-enable it and confirm protection returns.

### 7. Explicit Reveal Fingerprint

On a live page that naturally reanalyzes and later changes a media resource, use context-menu **Unblur** on one item. Confirm the same resource remains revealed through reanalysis, then confirm a naturally changed resource in the reused element is protected again.

### 8. Invalid Word Validation

Through the popup, attempt `ox`, `spider man`, and `snake2`. Confirm each is rejected before persistence with an explanation. Confirm a valid Unicode-letter word is accepted, duplicate normalized words are rejected, and existing invalid stored entries are shown as invalid without silent deletion.

## Evidence Procedure

For each scenario:

1. Record the initial URL and settings.
2. Capture a baseline screenshot and relevant console/runtime state.
3. Perform only the user action required by the scenario.
4. Wait for a specific observable state transition with a bounded timeout.
5. Capture the resulting screenshot and relevant computed style or DOM output.
6. Record unexpected console/runtime errors verbatim.
7. Add one or more rows to `docs/live-site-validation.md`; link screenshots or other artifacts in the Evidence column.

## Stop Conditions

Stop and report rather than substituting another method when:

- A CAPTCHA, anti-bot wall, authentication requirement, or consent flow prevents the natural scenario.
- The extension or required connected Chrome session is unavailable.
- The site no longer naturally exposes the content needed for the scenario.
- A required error condition cannot be safely produced on a live website.
- Expected behavior is ambiguous under the approved architecture.

## Failure Report

```markdown
### Failure Report
- Time (Asia/Tokyo):
- URL:
- Scenario:
- Settings:
- Action:
- Expected:
- Observed:
- Console/runtime errors:
- Evidence:
- Reproducible:
- Blocker or remaining uncertainty:
```

Live-site variability is evidence context, not permission to replace the scenario with injected or local-fixture behavior.
