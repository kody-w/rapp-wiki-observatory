"use strict";

const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { crc32 } = require("../web/data.js");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function archiveFromEntries(entries, options = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, body] of entries) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const filename = Buffer.from(name);
    const compressed = zlib.deflateRawSync(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(options.flags || 0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(options.forgedSize || bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(options.flags || 0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(bytes), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(options.forgedSize || bytes.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, filename, compressed);
    centrals.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

function fixture(options = {}) {
  const name = "PRIVATE_PAGE_DO_NOT_EXPORT";
  const pageKey = `dse~${name}`;
  const privateHandle = "private-person@example.invalid";
  const secondHandle = "PRIVATE_SECOND_HANDLE";
  const text = "caf\u00e9\nOther agents share an answer cache in an environment. "
    + "<img src=\"https://do-not-fetch.invalid/save\" onerror=\"globalThis.__unsafeArchiveExecuted=1\">\n"
    + "Heartbeat and backup notes. ".repeat(8);
  const body = Buffer.from(text, "utf8");
  const revisions = [privateHandle, secondHandle].map((label, index) => ({
    rev_id: `${pageKey}@${index + 1}`, page_id: `dse/${name}`, page_key: pageKey,
    wiki: "dse", name, seq: index + 1, body: body.toString("latin1"),
    body_len: body.length, body_sha256: options.badBodyHash ? "0".repeat(64) : sha(body),
    lines: text.split("\n").length, diff_base: index ? `${pageKey}@1` : null,
    hunks: [{ op: index ? "replace" : "insert", a0: 0, a1: index ? 3 : 0, b0: 0, b1: 3 }],
    label, ip16: "192.0.x.x", time: `2026-06-18T00:0${index}:00Z`,
    time_grade: "reqlog", uncertainty_seconds: 1, body_encoding: "utf8"
  }));
  const pages = [{
    page_id: `dse/${name}`, page_key: pageKey, wiki: "dse", name,
    n_revs: 2, deleted_live: false, labels: [privateHandle, secondHandle]
  }];
  const labels = [
    { label: privateHandle, is_human_handle: false },
    { label: secondHandle, is_human_handle: options.humanSecond === true }
  ];
  const events = revisions.map((revision, index) => ({
    event_id: `private-source-${index}`, event_type: "save", wiki: "dse", page: name,
    page_key: pageKey, time: revision.time, time_grade: "reqlog",
    revision_ref: revision.rev_id, related_event_id: null, relation_type: null
  }));
  events.push({
    event_id: "private-deletion", event_type: "delete", wiki: "dse",
    page: "PRIVATE_UNHELD_PAGE", page_key: "dse~PRIVATE_UNHELD_PAGE",
    time: "2026-06-18T00:03:00Z", time_grade: "reqlog", uncertainty_seconds: 1,
    success_observed: true, actor_label: null, revision_ref: null,
    ip16: "203.0.x.x", page_held: false
  });
  events.push({
    event_id: "private-probe", event_type: "probe", time: "2026-06-18T00:04:00Z",
    time_grade: "reqlog", success_observed: false,
    request_action: "DO_NOT_EXPORT_THIS_REQUEST", ip16: "198.51.x.x"
  });
  const manifest = {
    generated_at: "2026-09-03T03:42:36Z",
    cut: { field: "revision.write_date", operator: ">=", value: "2026-05-01" },
    counts: { pages: { value: 1 }, revisions: { value: 2 }, labels: { value: 2 } },
    private_extra: "DO_NOT_EXPORT_MANIFEST_CONTENT"
  };
  const entries = [
    ["pages.jsonl", Buffer.from(pages.map(row => JSON.stringify(row)).join("\n") + "\n")],
    ["revisions.jsonl", Buffer.from(revisions.map(row => JSON.stringify(row)).join("\n") + "\n")],
    ["events.jsonl", Buffer.from(events.map(row => JSON.stringify(row)).join("\n") + "\n")],
    ["labels.jsonl", Buffer.from(labels.map(row => JSON.stringify(row)).join("\n") + "\n")],
    ["manifest.json", Buffer.from(JSON.stringify(manifest))]
  ];
  const sums = entries.map(([filename, bytes]) => `${sha(bytes)}  ${filename}`).join("\n") + "\n";
  entries.push(["SHA256SUMS", Buffer.from(options.badSums ? sums.replace(/^[a-f0-9]{64}/, "0".repeat(64)) : sums)]);
  return { zip: archiveFromEntries(entries), entries, text, privateHandle, secondHandle, name };
}

module.exports = { archiveFromEntries, fixture };
