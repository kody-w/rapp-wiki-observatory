# Methods and limits

## Source integrity

The supplied ZIP contains exactly `pages.jsonl`, `revisions.jsonl`, `events.jsonl`, `labels.jsonl`, `manifest.json` and `SHA256SUMS`. The parser refuses unexpected names, duplicates, symbolic links, encryption, unsupported compression, inconsistent local/central headers, overlapping entries and excessive sizes.

Each member's expanded size and CRC are checked. All five file SHA-256 values must agree with `SHA256SUMS`. A separate, fixed set of published file hashes determines whether the contents match the known reference export. Self-consistent checksums alone are not authentication.

Every revision body's SHA-256 is independently reproduced from its original bytes. The archive's JSON body string is a byte-preserving Latin1 representation, even for its 250 UTF-8 bodies. Encoding that JSON string directly as UTF-8 would double-encode them and produce wrong hashes. The parser first reconstructs byte values, verifies the hash, and then decodes for reading according to `body_encoding`.

Source `lines` and hunk coordinates use literal `split("\n")`, including the final empty line when present. Displayed text does not replace the original-byte digest.

## Joins

`page_key` and `page_id` are different identifiers. For example, a key uses `wiki~name`, while an ID uses `wiki/name`. Page relationships use exact `page_key`; save events join to retained revisions through exact `revision_ref`/`rev_id`. No site/name guessing, URI fetching or fuzzy identity merge is performed.

Events for pages not present in `pages.jsonl` receive metadata-only unheld-page nodes. Probes have no page key and remain unattributed. Public counts preserve all events, rather than silently dropping rows that cannot be joined to retained content.

## Public projection

Page and handle keys are sorted deterministically and assigned public identifiers. Revision and event identifiers derive from source record order, retaining their JSONL line numbers. Original names, IDs, request parameters, raw source-path strings, IP prefixes and bodies never enter the public projection.

The projection is an explicit allowlist, not a regular-expression attempt to remove secrets from raw text. Its validator checks exact field sets, pseudonym shapes, allowed vocabulary, identifiers, joins and counts. Export calls the same validator and does not accept private text, names or search terms.

The public projection remains intentionally linkable to a copy of the source archive. It is a content-minimized evidence view, not a claim that an adversary cannot correlate records.

## Relationships and lenses

Co-editing edges count shared pages among distinct unverified handles. The interface limits the displayed network and labels that subset; a shared page does not establish a message exchange. Blank handles are not treated as one real agent. Source-flagged human handles are excluded from agent-like relationship suggestions.

Repeated-text groups require identical verified body hashes, at least 160 original bytes and at least two distinct unverified named handles. Full page snapshots can repeat because of shared templates, boilerplate or unchanged text. A group is a triage lead, not a finding of cheating.

Keyword lenses detect fixed published terms for coordination, answers, environment, tunnels, liveness and recovery. They do not interpret intent or distinguish every negated mention. Inspect surrounding local text before drawing conclusions.

## Time and coverage

The export's cut is based on `revision.write_date`, whereas an event's chosen timestamp may come from a request log or a recent-changes log. Those are not interchangeable clocks. Timestamp grade and declared uncertainty remain available in the inspector.

Calendar gaps are rendered as zero records in this archive, not as proof that no real-world activity occurred. Dates are handled in UTC. The source article describes activity on other sites and evidence not present in this ZIP; this explorer does not reconstruct that missing evidence.

## Browser boundary

ZIP decompression and private record inspection use local browser APIs. The application has no upload endpoint, analytics or network inference. The built artifact prevents connection requests through its content security policy. Recorded URLs are never turned into navigation actions.

Imports are bounded to a 16 MiB ZIP, 64 MiB per expanded member, 96 MiB total expanded data, 60,000 rows per JSONL file and a bounded calendar span. Invalid imports must be reported as errors; an earlier loaded dataset may remain visible but is not relabeled as the rejected import.

Private names and text are held separately from public metadata and are not put in local storage or URL parameters. Unloading releases the application's references; it is not a promise of cryptographic erasure from browser or operating-system memory.

## Protocol scope

`rapp-wiki-observatory/1` is an application-data schema, not a new RAPP/1 wire protocol or a signature. No model, agent identity, collusion claim or provider attribution is certified by this artifact.
