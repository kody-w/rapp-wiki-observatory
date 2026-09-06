# RAPP Wiki Observatory

[Open the observatory](https://kody-w.github.io/rapp-wiki-observatory/) | [Source repository](https://github.com/kody-w/rapp-wiki-observatory) | [Methods](METHODS.md)

An original, offline-first evidence explorer inspired by [collusion.wiki](https://collusion.wiki/), built from the archive supplied by the operator. It is a separate project, not an AIBAST feature or an addition to the Omarchy workbench.

**This site observes records. It does not run agents, write to wikis, execute recorded commands, follow recorded URLs, or establish who operated a handle.**

## Two deliberately separate views

The bundled public view contains pseudonymous identifiers, timestamps, event types, counts, hashes, source-line references and derived relationships. Original bodies, page titles, handles, IP prefixes, request parameters and recorded URLs are omitted.

For full-text inspection, load `full-wiki-logs.zip` in the browser. Decompression, checksum verification, search and inspection happen locally. The original archive is not uploaded or added to this repository. Private text and names live only in browser memory; unloading the archive restores the metadata-only view.

Selections export metadata only, even while a private archive is loaded. That is not a promise of irreversible anonymization: timestamps, hashes and source-line references intentionally remain linkable to the original archive. Review an export before sharing it.

## What the supplied archive contains

The supplied files match the checksums published on [the original download page](https://collusion.wiki/explorer/download.html). The export was generated on 3 September 2026 and uses a `revision.write_date >= 2026-05-01` cut.

| Observed item | Count |
| --- | ---: |
| Events | 19,913 |
| Retained saved revisions | 14,591 |
| Delete events | 5,217 |
| Revert events | 4 |
| Probe events | 101 |
| Held pages | 4,579 |
| Referenced pages, including unheld pages | 5,825 |
| Published handles, including unattributed/human flags | 3,103 |
| Repeated-text groups meeting this project's stated threshold | 215 |

The peak saved-revision day is 18 June 2026, with 6,543 retained revisions. These numbers describe this archive, not all activity discussed in the source article.

## Evidence, not attribution

- A saved revision is a full page snapshot, not necessarily a distinct message.
- A handle is an unverified label, not a unique process, person, model or authenticated agent.
- Co-editing a page demonstrates overlap, not direct communication or coordinated intent.
- Repeated text means identical verified bytes of at least 160 bytes across at least two distinct, nonhuman-flagged, nonblank handles. Templates and boilerplate can explain repetition.
- Keyword lenses are mention detectors. Negation and context can reverse their apparent meaning.
- `success_observed: false` means success was not observed, not that failure was proved.
- The 101 probe events have no page/wiki attribution in this export. Unheld pages and missing predecessors remain missing; the explorer does not invent their content.
- Request-log, recent-change-log and write-date timestamps retain their source grade and available uncertainty. Display formatting does not add timing precision.
- The archive does not contain private model reasoning or all underlying request logs. This project cannot independently establish provider ownership or unseen conduct.

See [METHODS.md](METHODS.md) for the parser, privacy projection and reproducibility boundaries.

## Build

Node 20 or later is sufficient for the data pipeline and build. There are no browser runtime packages, CDNs, external fonts or analytics.

```bash
npm test
npm run build
```

The default build uses the checked-in, metadata-only `data/public.json.gz`. It writes `docs/index.html`, with the application, styles and compressed metadata embedded. Open that file directly, or serve `docs/` as static files.

To reproduce the public projection from the original archive:

```bash
node scripts/build.cjs --archive /private/path/full-wiki-logs.zip
```

Public builds refuse an archive whose five expanded file hashes differ from the known published source. The browser can inspect other structurally valid archives locally, but identifies their origin as unverified.

The built artifact uses a content security policy with exact script hashes and `connect-src 'none'`. Historical text is data, not HTML or instructions.

## Browser exercise

The browser runner uses Playwright with Chromium's sandbox enabled. It exercises the built file offline, light/dark themes at desktop/mobile sizes, filtering, pagination, keyboard navigation, source inspection, overlap/reuse, pinning, metadata exports, a synthetic hostile-text fixture, malformed input and unload behavior.

```bash
npm ci
npx playwright install chromium
npm run test:browser
```

Set `CHROME_PATH` to an existing Chrome executable instead of installing Chromium if desired. Set `WIKI_ARCHIVE` to the private original ZIP to additionally exercise the real 14,591-body import, a complete full-text scan and changed-range inspection. Proof files go to the ignored `artifacts/browser/` directory unless `OBSERVATORY_PROOF_DIR` is set.

The compact mobile view uses an accessible edge table instead of squeezing the full network into an unreadable diagram. Modern browser decompression and Web Crypto APIs are required. No browser compatibility beyond the exercised Chrome runtime is implied.

## Repository layout

- `web/data.js`: shared Node/browser ZIP validation, byte decoding, joins, projection and safe export.
- `web/index.template.html`, `web/app.js`: original interface.
- `scripts/build.cjs`: reproducible, single-file build.
- `data/public.json.gz`, `data/summary.json`: content-free public projection and its receipt.
- `tests/`: bounded archive and privacy regression fixtures, never the supplied raw archive.
- `docs/index.html`: the delivered artifact.

## Source and licensing

Credit for collecting and publishing the source material belongs to the researchers at [collusion.wiki](https://collusion.wiki/). This is an independent analysis tool, not their site or their endorsement. Their article, graphics and original post bodies are not reproduced in the public artifact.

[MIT](LICENSE) covers this project's original code. It does not relicense the source archive or the source article.
