# Live-site validation

| Time (Asia/Tokyo) | URL | Settings | Action | Expected | Observed | Console/runtime errors | Evidence |
|---|---|---|---|---|---|---|---|

Do not add a result until the scenario has been run against natural content on a live public website. Do not use local fixtures or injected trigger text, media, mutations, errors, or replacement resources.

## Page-wide trigger

Record evidence that a naturally occurring configured trigger keeps supported media blurred across distinct regions of the page, not only near the trigger.

## Stylesheet background

Record evidence for an ordinary element whose computed `background-image` comes from a stylesheet rather than an inline style.

## Dynamic content

Record naturally loaded content and whether new media remains protected while pending and follows the updated page-wide result.

## Policy precedence

Record blacklist-over-whitelist behavior, blacklist behavior while global protection is off, and a plain-domain rule applying to a naturally visited subdomain.

## No-reload settings

Record an in-place settings or site-rule change and evidence that the page did not navigate or lose an existing form value.

## Iframe setting on/off

Record the same live cross-origin embed after a successful clean analysis with **Keep unchecked embedded content blurred** enabled and disabled.

## Explicit reveal fingerprint

Record context-menu **Unblur** surviving reanalysis for the same resource and expiring after the live page naturally changes that resource.

## Invalid word validation

Record rejection explanations for invalid target words and confirmation that they were not persisted. Include valid-word, normalized-duplicate, and existing-invalid-entry checks where available.
