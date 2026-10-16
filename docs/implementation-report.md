# From feature list to verified behavior

[Русский](implementation-report.ru.md) · [Feature contracts](roadmap-delivery.md) · [Size evidence](roadmap-size.md)

This report records the implementation and hardening process, not a release
announcement. The measured player snapshot is `652726f8`; the separately built
native Android snapshot is `be0d800`. CI, merge and release promotion remain
separate gates. Later documentation or test-only commits do not turn a local
check into proof that an installed device has been updated.

![Implementation process and its acceptance gates](diagrams/implementation-process.svg)

## How the work was checked

The initial request was split into 13 usable feature slices across the classic
player, control service/CLI and independent native Android application.
Ownership was assigned by component so simultaneous changes could be reviewed
and integrated without replacing another component's work. New UI reused
existing translated labels or added catalog entries across all 88 languages;
full engineering guides were written in English and Russian.

Implementation was followed by independent cross-review and executable
regressions. A reported problem was checked against the actual callback,
decoder, storage or focus path before changing code. Test failures were separated
into behavior regressions and obsolete test selectors. For example, switching
classic rows from `button` to `option` required updating selectors; it did not
justify weakening the expected click behavior.

Clean production builds then checked the emitted ES5 artifacts and the full
JavaScript cost, including optional provider modules. Targeted browser tests used
the shipped loader, bundle and device adapters. Native Android received a
separate Gradle test, lint and package run. PR checks and review threads are
checked again after pushing; passing a local build is not a substitute.

## What changed during review

![Five corrected behaviors and the measured JavaScript cost](diagrams/implementation-results.svg)

- **HLS parsing and retries:** parsing failures initially shared the generic
  network classification. They now get at most one same-URL reconnect, inside
  the two-transient-retry budget; new decoders and backup URLs do not reset it.
  A terminal auth/DRM failure also cancels an already queued transient retry.
- **Native Auto fallback:** native-error handling could retire the request while
  Auto already owned a fallback. The existing owner now retains that transition;
  cancellation still invalidates its delayed callbacks.
- **Modal Enter:** automatically focusing the first Cancel button turned Enter
  in a Plex waiting dialog into cancellation. Dialogs now start with focus on
  the dialog itself. Tab reaches their buttons explicitly; ordinary information
  and confirmation dialogs retain Enter and Escape/Back behavior.
- **PC pointer selection:** mouse focus changed selection before the click
  handler, turning the first click into activation. Pointer-induced focus no
  longer pre-selects the row. PC still selects, then activates; LG retains its
  one-click behavior. Keyboard focus still follows selection.
- **Android tracks:** an unlabelled current-item selection could be erased by
  its own Auto acknowledgement or a subtitle preference update, or leak into
  another item with an equal `TrackGroup`. It now survives delayed writes only
  for its current item. Semantic preferences use language/role/label; the
  ViewModel owns persistence so closing the pane does not cancel the write.

The 13 delivered slices are: A/V sample; resumable Local/Home setup; bounded
recovery; quality ceilings; Android track preferences; scoped control keys;
XMLTV bindings; Xtream movies/series; classic accessibility; durable command
outcomes; explicit handoff; backup streams; recoverable settings batches.
The [feature guide](roadmap-delivery.md) defines each scope and limitation.

## Evidence and remaining gates

For `652726f8`, the five focused browser scenarios passed: LG webOS pointer
navigation, LG NetCast pointer navigation, PC two-click behavior, dialog keyboard
semantics, and Plex collection/resolution/cancel/retry. TypeScript, the
accessibility unit fixture, scoped lint, ES5 and bundle-budget checks passed.
The complete browser run against this build finished with **194 passed and
one skipped**: native HLS requires WebKit, while this run used Chromium.
Hosted CI and the agreed merge sequence remain separate gates.

For Android `be0d800`, **101 app tests and 62 shared-core tests** passed locally,
as did debug/release lint, Debug/Release/Full APK assembly, the release bundle and
androidTest APK compilation. Compilation of the instrumented-test APK is not
execution on a device. The three confirmed review findings were answered and
resolved in [Android PR 68](https://github.com/open-ott-play/ottplay-android/pull/68);
the diagram deliberately leaves the CI/release gate pending.

The complete web JavaScript total changed from **964,459 / 305,344** raw/gzip
bytes to **995,858 / 315,207**: **+31,399 / +9,863 bytes** (about 3.26% / 3.23%).
The feature candidate was 995,587 / 315,103; subsequent hardening added 271 / 104.
The final main entry is 875,197 / 270,425. See the
[baseline measurement](evidence/roadmap-size-20261015.json),
[final artifact measurement](evidence/roadmap-final-size-20261015.json) and
[measurement method](roadmap-size.md).

These are byte costs, **not measured speed improvements**. Totals exclude media
engines, dictionaries, CSS, images and video. The explicit A/V sample adds
464,652 packaged bytes separately. Startup time, frame pacing, memory use,
screen-reader experience, real HDMI audio and provider behavior require their
own measurements on target devices. No new physical-device result or beta
release is asserted by this report. The [physical acceptance list](roadmap-delivery.md#physical-acceptance-before-promotion)
and [release strategy](../RELEASING.md) remain the promotion criteria.

## Delivery

- [Player, documentation and i18n — PR 781](https://github.com/open-ott-play/ottplay-foss/pull/781).
- [Control server and CLI — PR 106](https://github.com/open-ott-play/ottplay-control-server/pull/106).
- [Android track preferences — PR 68](https://github.com/open-ott-play/ottplay-android/pull/68).

These PRs carry the current CI and merge state. The player change follows the
agreed current Plex fixes and their beta release as a separate delivery wave.
