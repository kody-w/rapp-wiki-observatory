"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const data = require("../web/data.js");
const { adapters, compileHTML } = require("../scripts/build.cjs");
const { fixture, archiveFromEntries } = require("./fixture.cjs");

test("joins page_key, not the unrelated page_id spelling; retains unheld events", async () => {
  const result = await data.loadArchive(fixture().zip, adapters);
  assert.equal(result.data.stats.events, 4);
  assert.equal(result.data.stats.revisions, 2);
  assert.equal(result.data.stats.heldPages, 1);
  assert.equal(result.data.stats.referencedPages, 2);
  assert.equal(result.data.stats.unheldEvents, 1);
  assert.equal(result.data.stats.unattributedEvents, 1);
  assert.equal(result.data.events.filter(event => event.type === "save")[0].pageId, result.data.revisions[0].pageId);
  assert.equal(result.data.revisions[1].previousId, result.data.revisions[0].id);
});

test("verifies original bytes and decodes UTF-8 once, not twice", async () => {
  const source = fixture();
  const result = await data.loadArchive(source.zip, adapters);
  assert.equal(result.integrity.verifiedBodies, 2);
  assert.equal(result.privateData.revisionBodies.R00001, source.text);
  assert.match(result.privateData.revisionBodies.R00001, /^caf\u00e9/);
  assert.equal(result.data.reuse.length, 1);
  assert.ok(result.data.revisions[0].tags.includes("coordination"));
});

test("public projection and exports cannot carry bodies, names, IPs, URLs or source IDs", async () => {
  const source = fixture();
  const result = await data.loadArchive(source.zip, adapters);
  const rendered = JSON.stringify(result.data);
  for (const secret of [source.privateHandle, source.secondHandle, source.name, "192.0.x.x", "203.0.x.x", "do-not-fetch.invalid", "private-source-", "DO_NOT_EXPORT"]) {
    assert.ok(!rendered.includes(secret), secret);
  }
  const exported = data.exportSelection(result.data, [result.data.events[0].id]);
  assert.equal(exported.eventCount, 1);
  assert.ok(!JSON.stringify(exported).includes(source.privateHandle));
  result.data.events[0].body = "private";
  assert.throws(() => data.exportSelection(result.data, [result.data.events[0].id]), /non-public/);
});

test("public page or handle names cannot be replaced with originals", async () => {
  const result = await data.loadArchive(fixture().zip, adapters);
  result.data.pages[0].title = "private original";
  assert.throws(() => data.assertPublic(result.data), /private title/);
});

test("unknown local source is never attributed to the published reference", async () => {
  const result = await data.loadArchive(fixture().zip, adapters);
  assert.equal(result.integrity.matchesReference, false);
  assert.equal(result.data.source.url, null);
  assert.match(result.data.source.title, /unverified origin/);
});

test("human-labelled handles are not counted as unverified aliases or reuse collaborators", async () => {
  const result = await data.loadArchive(fixture({ humanSecond: true }).zip, adapters);
  assert.equal(result.data.stats.humanHandles, 1);
  assert.equal(result.data.stats.namedHandles, 1);
  assert.equal(result.data.reuse.length, 0);
});

test("rejects tampered file checksums", async () => {
  await assert.rejects(data.loadArchive(fixture({ badSums: true }).zip, adapters), /SHA-256/);
});

test("rejects inconsistent body fingerprints even with valid container checksums", async () => {
  await assert.rejects(data.loadArchive(fixture({ badBodyHash: true }).zip, adapters), /original-byte checksum/);
});

test("rejects traversal filenames without extracting anything", async () => {
  const source = fixture();
  source.entries[0][0] = "../pages.jsonl";
  await assert.rejects(data.loadArchive(archiveFromEntries(source.entries), adapters), /unexpected or duplicate/);
});

test("rejects duplicate ZIP names, encryption and inflated size claims", async () => {
  const source = fixture();
  const duplicates = source.entries.map(entry => [...entry]);
  duplicates[1][0] = "pages.jsonl";
  await assert.rejects(data.loadArchive(archiveFromEntries(duplicates), adapters), /unexpected or duplicate/);
  await assert.rejects(data.loadArchive(archiveFromEntries(source.entries, { flags: 1 }), adapters), /Encrypted/);
  await assert.rejects(data.loadArchive(archiveFromEntries(source.entries, { forgedSize: data.LIMITS.entryBytes + 1 }), adapters), /memory bound/);
});

test("rejects unknown selection IDs and exports deterministic public metadata only", async () => {
  const result = await data.loadArchive(fixture().zip, adapters);
  assert.throws(() => data.exportSelection(result.data, ["E999999"]), /unknown event/);
  const ids = result.data.events.map(event => event.id);
  assert.deepEqual(data.exportSelection(result.data, ids), data.exportSelection(result.data, ids));
});

test("refuses broken public references and counterfeit reference attribution", async () => {
  const first = await data.loadArchive(fixture().zip, adapters);
  first.data.events[0].pageId = "P99999";
  assert.throws(() => data.assertPublic(first.data), /unresolved event reference/);
  const second = await data.loadArchive(fixture().zip, adapters);
  second.data.source.matchesReference = true;
  second.data.source.title = "collusion.wiki public export";
  second.data.source.url = "https://collusion.wiki/explorer/download.html";
  assert.throws(() => data.assertPublic(second.data), /published file fingerprints/);
});

test("single-file build hashes scripts and forbids application network connections", () => {
  const template = '<html><head><script>const theme = "light";</script></head><body>'
    + '<script id="observatory-data" type="application/octet-stream">__DATA_GZIP_BASE64__</script>'
    + '<script>__ARCHIVE_JS__</script><script>__APP_JS__</script></body></html>';
  const html = compileHTML(template, Buffer.from("fixture"), "const archive = true;", "const app = true;");
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /form-action 'none'/);
  assert.equal((html.match(/'sha256-/g) || []).length, 3);
  assert.ok(!html.includes("script-src 'unsafe-inline'"));
  assert.throws(() => compileHTML(template.replace("__APP_JS__", ""), Buffer.from(""), "", ""), /exactly one/);
});

const publicFile = path.resolve(__dirname, "../data/public.json.gz");
test("published projection contains all supplied reference events and no hidden content fields", { skip: !fs.existsSync(publicFile) }, () => {
  const projection = data.assertPublic(JSON.parse(zlib.gunzipSync(fs.readFileSync(publicFile))));
  assert.equal(projection.stats.events, 19913);
  assert.equal(projection.stats.revisions, 14591);
  assert.equal(projection.stats.heldPages, 4579);
  assert.equal(projection.stats.publishedHandles, 3103);
  assert.equal(projection.stats.peakRevisionDay, "2026-06-18");
  assert.equal(projection.stats.peakRevisionCount, 6543);
  assert.deepEqual(projection.stats.types, { save: 14591, delete: 5217, revert: 4, probe: 101 });
  assert.equal(projection.daily.reduce((total, day) => total + day.total, 0), 19913);
  assert.equal(projection.source.matchesReference, true);
  assert.equal(projection.stats.referencedPages, 5825);
  assert.equal(projection.daily.length, 59);
  assert.ok(projection.daily.some(day => day.total === 0));
  for (const file of projection.source.files) assert.equal(file.sha256, data.REFERENCE_HASHES[file.name]);
});
