(function (root) {
  "use strict";

  const SCHEMA = "rapp-wiki-observatory/1";
  const FILES = ["pages.jsonl", "revisions.jsonl", "events.jsonl", "labels.jsonl", "manifest.json"];
  const REFERENCE_URL = "https://collusion.wiki/explorer/download.html";
  const REFERENCE_HASHES = Object.freeze({
    "pages.jsonl": "92b296170b496b836cdf5ef783bed9465d2d75db7e1a0becec1c36c8b7c42cfd",
    "revisions.jsonl": "60df4a515178230aa952d9f64f6215aea4bd95ab2f05e31e484cf9b887e3f793",
    "events.jsonl": "588584295f1c4a7c3d90b04075ab151504f165ff069534d935cda08853ec28b1",
    "labels.jsonl": "d94aecd84baecda46344f5b8726a95a9c81e7e41a1c0969fc89a90c8906f0388",
    "manifest.json": "b6d53e16b5d9a6a0a98d4577238835ee7a574d7d10a8f1312330b4e626c6ba2b"
  });
  const LIMITS = Object.freeze({
    archiveBytes: 16 * 1024 * 1024,
    entryBytes: 64 * 1024 * 1024,
    totalBytes: 96 * 1024 * 1024,
    rowBytes: 512 * 1024,
    rows: 60000,
    bodyBytes: 256 * 1024,
    bundleBytes: 48 * 1024 * 1024,
    calendarDays: 3660
  });
  const WIKIS = ["dse", "probier", "fractal", "dorfwiki", "unattributed", "other"];
  const TYPES = ["save", "delete", "revert", "probe"];
  const GRADES = ["reqlog", "rclog", "write_date", "unknown"];
  const RULES = Object.freeze([
    { id: "coordination", label: "Coordination terms", description: "Mentions of peers or shared work; context can negate the phrase.", terms: ["other agents", "fellow agent", "collaborat", "coordinate", "teammate", "shared knowledge"] },
    { id: "answers", label: "Answer-exchange terms", description: "Mentions of answers or task results; not proof of an answer being transferred.", terms: ["answer cache", "cached answer", "share answers", "task id", "task_id", "ground truth"] },
    { id: "environment", label: "Environment terms", description: "Mentions of the execution environment or restrictions.", terms: ["sandbox", "restriction", "evaluation", "benchmark", "environment", "read-only"] },
    { id: "tunnels", label: "Tunnel / proxy terms", description: "Text mentions only. No recorded instruction or URL is executed.", terms: ["tunnel", "proxy", "tailscale", "ssh ", "tor network", "redirect"] },
    { id: "heartbeat", label: "Liveness terms", description: "Mentions of heartbeats or continued activity, not verified process liveness.", terms: ["heartbeat", "still alive", "still running", "termination", "deadman", "keepalive"] },
    { id: "recovery", label: "Recovery terms", description: "Mentions of deletion, backups or reconstruction.", terms: ["deleted", "deletion", "backup", "restore", "recreate", "moderator"] }
  ]);
  const RULE_IDS = new Set(RULES.map(rule => rule.id));
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });

  class ArchiveError extends Error {
    constructor(message) { super(message); this.name = "ArchiveError"; }
  }

  function requireValue(ok, message) {
    if (!ok) throw new ArchiveError(message);
  }

  function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    throw new ArchiveError("Expected archive bytes.");
  }

  function crc32(bytes) {
    let result = 0xffffffff;
    for (const byte of bytes) result = crcTable[(result ^ byte) & 255] ^ (result >>> 8);
    return (result ^ 0xffffffff) >>> 0;
  }

  function object(value, label) {
    requireValue(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
    return value;
  }

  function string(value, label, maximum = 4096, empty = false) {
    requireValue(typeof value === "string" && value.length <= maximum && (empty || value.length > 0), `${label} must be bounded text.`);
    return value;
  }

  function integer(value, label, maximum = 1000000000) {
    requireValue(Number.isSafeInteger(value) && value >= 0 && value <= maximum, `${label} must be a bounded nonnegative integer.`);
    return value;
  }

  function timestamp(value, label) {
    if (value === null || value === undefined || value === "") return null;
    requireValue(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value), `${label} is not a UTC timestamp.`);
    const date = new Date(value);
    requireValue(Number.isFinite(date.getTime()), `${label} is not a valid date.`);
    const result = date.toISOString();
    requireValue(result.slice(0, 19) === value.slice(0, 19), `${label} has invalid calendar fields.`);
    return result;
  }

  const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  const isHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const enumOr = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
  const identifier = (prefix, index) => prefix + String(index + 1).padStart(prefix === "E" ? 6 : 5, "0");
  const countObject = values => Object.fromEntries(values.map(value => [value, 0]));

  function touch(record, time) {
    if (!time) return;
    if (!record.first || time < record.first) record.first = time;
    if (!record.last || time > record.last) record.last = time;
  }

  function parseJSON(bytes, label) {
    try { return JSON.parse(utf8.decode(bytes)); }
    catch (error) { throw new ArchiveError(`${label} is not valid UTF-8 JSON.`); }
  }

  function parseRows(bytes, name) {
    const result = [];
    let start = 0;
    let line = 1;
    for (let index = 0; index <= bytes.length; index++) {
      if (index !== bytes.length && bytes[index] !== 10) continue;
      if (index === bytes.length && start === index) break;
      requireValue(index - start > 0 && index - start <= LIMITS.rowBytes, `${name}:${line} has an empty or oversized record.`);
      result.push({ row: object(parseJSON(bytes.subarray(start, index), `${name}:${line}`), `${name}:${line}`), line });
      requireValue(result.length <= LIMITS.rows, `${name} has too many records.`);
      start = index + 1;
      line++;
    }
    return result;
  }

  async function readZip(value, adapters) {
    const bytes = asBytes(value);
    requireValue(bytes.length >= 22 && bytes.length <= LIMITS.archiveBytes, "Archive size is outside the allowed bound.");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
      if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) {
        end = offset;
        break;
      }
    }
    requireValue(end >= 0, "ZIP end record is missing or has trailing bytes.");
    requireValue(view.getUint16(end + 4, true) === 0 && view.getUint16(end + 6, true) === 0, "Multi-disk ZIP is not supported.");
    const count = view.getUint16(end + 10, true);
    requireValue(count === 6 && view.getUint16(end + 8, true) === count, "Expected exactly the five export files and SHA256SUMS.");
    const centralSize = view.getUint32(end + 12, true);
    const centralOffset = view.getUint32(end + 16, true);
    requireValue(centralOffset + centralSize === end, "ZIP central directory is inconsistent.");
    const allowed = new Set([...FILES, "SHA256SUMS"]);
    const result = new Map();
    const ranges = [];
    let total = 0;
    let cursor = centralOffset;
    for (let index = 0; index < count; index++) {
      requireValue(cursor + 46 <= end && view.getUint32(cursor, true) === 0x02014b50, "ZIP central entry is invalid.");
      const flags = view.getUint16(cursor + 8, true);
      const method = view.getUint16(cursor + 10, true);
      const checksum = view.getUint32(cursor + 16, true);
      const compressedSize = view.getUint32(cursor + 20, true);
      const size = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      const localOffset = view.getUint32(cursor + 42, true);
      const entryEnd = cursor + 46 + nameLength + extraLength + commentLength;
      requireValue(entryEnd <= end, "ZIP central filename is truncated.");
      const name = utf8.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
      requireValue(allowed.has(name) && !result.has(name), "ZIP contains an unexpected or duplicate filename.");
      requireValue((flags & 1) === 0 && (method === 0 || method === 8), "Encrypted or unsupported ZIP entries are refused.");
      const mode = view.getUint32(cursor + 38, true) >>> 16;
      requireValue((mode & 0xf000) !== 0xa000, "ZIP symbolic links are refused.");
      total += size;
      requireValue(size <= LIMITS.entryBytes && total <= LIMITS.totalBytes, "Expanded archive exceeds the memory bound.");
      requireValue(localOffset + 30 <= centralOffset && view.getUint32(localOffset, true) === 0x04034b50, "ZIP local header is invalid.");
      requireValue(view.getUint16(localOffset + 6, true) === flags && view.getUint16(localOffset + 8, true) === method, "ZIP local and central methods or flags differ.");
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      requireValue(dataStart + compressedSize <= centralOffset, "ZIP member overlaps its directory.");
      const localName = utf8.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength));
      requireValue(localName === name, "ZIP local and central filenames differ.");
      if (!(flags & 8)) {
        requireValue(view.getUint32(localOffset + 14, true) === checksum
          && view.getUint32(localOffset + 18, true) === compressedSize
          && view.getUint32(localOffset + 22, true) === size, "ZIP local and central sizes or CRC differ.");
      }
      requireValue(!ranges.some(([first, last]) => localOffset < last && dataStart + compressedSize > first), "ZIP entries overlap.");
      ranges.push([localOffset, dataStart + compressedSize]);
      if (adapters.progress) adapters.progress(`Checking ${name}`);
      const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
      const expanded = method === 0 ? compressed : asBytes(await adapters.inflateRaw(compressed, size + 1));
      requireValue(expanded.length === size && crc32(expanded) === checksum, `${name} failed its size or CRC check.`);
      result.set(name, expanded);
      cursor = entryEnd;
    }
    requireValue(cursor === end, "ZIP central directory contains unaccounted bytes.");
    return result;
  }

  function rawBody(row, line) {
    const value = string(row.body, `revisions.jsonl:${line} body`, LIMITS.bodyBytes, true);
    const bytes = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      requireValue(code <= 255, "Body must use the export's byte-preserving Latin1 representation.");
      bytes[index] = code;
    }
    requireValue(integer(row.body_len, "body_len", LIMITS.bodyBytes) === bytes.length, "Revision body_len differs from its original bytes.");
    requireValue(["ascii", "utf8", "latin1"].includes(row.body_encoding), "Unknown revision body encoding.");
    if (row.body_encoding === "ascii") requireValue(bytes.every(byte => byte < 128), "ASCII body contains non-ASCII bytes.");
    let text = value;
    if (row.body_encoding === "utf8") {
      try { text = utf8.decode(bytes); }
      catch (error) { throw new ArchiveError("A declared UTF-8 revision is not valid UTF-8."); }
    }
    return { bytes, text };
  }

  async function loadArchive(value, adapters) {
    const bytes = asBytes(value);
    const entries = await readZip(bytes, adapters);
    const sums = new Map();
    const sumText = utf8.decode(entries.get("SHA256SUMS"));
    for (const line of sumText.trim().split(/\r?\n/)) {
      const match = /^([a-f0-9]{64})[ \t]+\*?([A-Za-z0-9._-]+)$/.exec(line);
      requireValue(match && FILES.includes(match[2]) && !sums.has(match[2]), "SHA256SUMS has an invalid or duplicate member.");
      sums.set(match[2], match[1]);
    }
    requireValue(sums.size === FILES.length, "SHA256SUMS does not cover all five export files.");
    const verified = [];
    for (const name of FILES) {
      const hash = await adapters.digest(entries.get(name));
      requireValue(hash === sums.get(name), `${name} failed its SHA-256 check.`);
      verified.push({ name, sha256: hash });
    }
    const matchesReference = verified.every(file => REFERENCE_HASHES[file.name] === file.sha256);
    const manifest = object(parseJSON(entries.get("manifest.json"), "manifest.json"), "manifest");
    const raw = {};
    for (const name of FILES.filter(name => name.endsWith(".jsonl"))) raw[name] = parseRows(entries.get(name), name);
    if (manifest.counts) {
      for (const [key, name] of [["pages", "pages.jsonl"], ["revisions", "revisions.jsonl"], ["labels", "labels.jsonl"]]) {
        const declared = manifest.counts[key] && manifest.counts[key].value;
        if (declared !== undefined) requireValue(declared === raw[name].length, `Manifest ${key} count differs from its records.`);
      }
    }
    const decoded = new Map();
    const revisions = raw["revisions.jsonl"];
    for (let start = 0; start < revisions.length; start += 128) {
      await Promise.all(revisions.slice(start, start + 128).map(async ({ row, line }) => {
        const id = string(row.rev_id, "revision id");
        requireValue(!decoded.has(id), "Duplicate revision id.");
        const body = rawBody(row, line);
        requireValue(typeof row.body_sha256 === "string" && /^[a-f0-9]{64}$/.test(row.body_sha256), "Invalid revision body digest.");
        requireValue(await adapters.digest(body.bytes) === row.body_sha256, `Revision body at line ${line} failed its original-byte checksum.`);
        decoded.set(id, body.text);
      }));
      if (adapters.progress) adapters.progress(`Verified ${Math.min(start + 128, revisions.length).toLocaleString()} of ${revisions.length.toLocaleString()} revision bodies`);
    }
    const archiveSha256 = await adapters.digest(bytes);
    const built = project(raw, manifest, decoded, {
      archiveSha256, matchesReference,
      files: verified.map(file => ({ ...file, rows: raw[file.name] ? raw[file.name].length : 1 }))
    });
    return { data: built.data, privateData: built.privateData, integrity: {
      matchesReference, archiveSha256, verifiedFiles: verified.length, verifiedBodies: revisions.length
    } };
  }

  function project(raw, manifest, decoded, integrity) {
    const pageRaw = new Map();
    const handleRaw = new Map();
    const revisionRaw = new Map();
    const eventRaw = new Map();
    const privateData = { pageNames: Object.create(null), handleNames: Object.create(null), revisionBodies: Object.create(null) };
    for (const { row, line } of raw["pages.jsonl"]) {
      const key = string(row.page_key, "page_key");
      requireValue(!pageRaw.has(key), "Duplicate page_key.");
      string(row.page_id, "page_id");
      pageRaw.set(key, { row, line, held: true });
    }
    for (const { row, line } of raw["labels.jsonl"]) {
      const key = string(row.label, "label", 4096, true);
      requireValue(!handleRaw.has(key), "Duplicate published handle.");
      handleRaw.set(key, { row, line });
    }
    for (const item of raw["revisions.jsonl"]) {
      const row = item.row;
      const key = string(row.rev_id, "rev_id");
      requireValue(!revisionRaw.has(key), "Duplicate revision id.");
      requireValue(pageRaw.has(row.page_key), "A retained revision has no held page_key.");
      revisionRaw.set(key, item);
      const label = string(row.label, "revision label", 4096, true);
      if (!handleRaw.has(label)) handleRaw.set(label, { row: { label, is_human_handle: false }, line: null });
    }
    for (const item of raw["events.jsonl"]) {
      const row = item.row;
      const key = string(row.event_id, "event id");
      requireValue(!eventRaw.has(key), "Duplicate event id.");
      requireValue(TYPES.includes(row.event_type), "Unsupported event_type.");
      eventRaw.set(key, item);
      if (row.event_type !== "probe") {
        const pageKey = string(row.page_key, "event page_key");
        if (!pageRaw.has(pageKey)) pageRaw.set(pageKey, { row: { name: string(row.page, "event page"), wiki: row.wiki }, line: null, held: false });
      }
      if (row.actor_label !== undefined && row.actor_label !== null) {
        const label = string(row.actor_label, "event actor_label", 4096, true);
        if (!handleRaw.has(label)) handleRaw.set(label, { row: { label, is_human_handle: false }, line: null });
      }
    }
    const pageIds = new Map([...pageRaw.keys()].sort().map((key, index) => [key, identifier("P", index)]));
    const handleIds = new Map([...handleRaw.keys()].sort().map((key, index) => [key, identifier("H", index)]));
    const revisionIds = new Map(raw["revisions.jsonl"].map(({ row }, index) => [row.rev_id, identifier("R", index)]));
    const eventIds = new Map(raw["events.jsonl"].map(({ row }, index) => [row.event_id, identifier("E", index)]));
    const pageMap = new Map();
    const handleMap = new Map();
    for (const [key, item] of pageRaw) {
      const id = pageIds.get(key);
      privateData.pageNames[id] = string(item.row.name, "page name");
      pageMap.set(id, {
        id, title: `Page ${id}`, wiki: enumOr(item.row.wiki, WIKIS, "other"),
        held: item.held, revisions: 0, events: 0, handles: new Set(), first: null, last: null,
        deletedSnapshot: typeof item.row.deleted_live === "boolean" ? item.row.deleted_live : null,
        deletions: 0, recreations: 0, tags: new Set()
      });
    }
    for (const [key, item] of handleRaw) {
      const id = handleIds.get(key);
      privateData.handleNames[id] = key;
      const kind = key === "" ? "unattributed" : item.row.is_human_handle === true ? "human" : "unverified";
      handleMap.set(id, {
        id, title: kind === "unattributed" ? "Unattributed" : `Handle ${id}`, kind,
        revisions: 0, pages: new Set(), first: null, last: null, wikis: new Set()
      });
    }
    const revisionMap = new Map();
    const bodyGroups = new Map();
    const revisionDays = new Map();
    for (const { row, line } of raw["revisions.jsonl"]) {
      const id = revisionIds.get(row.rev_id);
      const body = decoded.get(row.rev_id);
      requireValue(typeof body === "string", "A revision has no verified decoded body.");
      privateData.revisionBodies[id] = body;
      const lower = body.toLowerCase();
      const tags = RULES.filter(rule => rule.terms.some(term => lower.includes(term))).map(rule => rule.id);
      const pageId = pageIds.get(row.page_key);
      const handleId = handleIds.get(row.label);
      const time = timestamp(row.time, "revision time");
      const lines = integer(row.lines, "revision lines", LIMITS.bodyBytes);
      requireValue(lines === body.split("\n").length, "Revision line count differs from its decoded text.");
      const previous = revisionRaw.get(row.diff_base);
      if (previous) requireValue(previous.row.page_key === row.page_key, "Revision predecessor belongs to another page.");
      requireValue(Array.isArray(row.hunks) && row.hunks.length <= 10000, "Invalid revision hunks.");
      let previousA = 0;
      let previousB = 0;
      const hunks = row.hunks.map(hunk => {
        object(hunk, "hunk");
        requireValue(["insert", "delete", "replace", "equal"].includes(hunk.op), "Unsupported hunk operation.");
        const result = { op: hunk.op };
        for (const key of ["a0", "a1", "b0", "b1"]) result[key] = integer(hunk[key], `hunk ${key}`, LIMITS.bodyBytes);
        requireValue(result.a0 <= result.a1 && result.b0 <= result.b1, "Invalid hunk range.");
        requireValue(result.b1 <= lines && result.a0 >= previousA && result.b0 >= previousB, "Hunk ranges overlap or exceed the revision.");
        if (previous) requireValue(result.a1 <= previous.row.lines, "Hunk exceeds its retained predecessor.");
        previousA = result.a1;
        previousB = result.b1;
        return result;
      });
      const revision = {
        id, pageId, handleId, time, grade: enumOr(row.time_grade, GRADES, "unknown"),
        uncertaintySeconds: row.uncertainty_seconds === null || row.uncertainty_seconds === undefined ? null : integer(row.uncertainty_seconds, "revision uncertainty"),
        bytes: row.body_len, lines, sha256: row.body_sha256,
        previousId: revisionIds.get(row.diff_base) || null, hunks, tags, sourceLine: line
      };
      revisionMap.set(id, revision);
      const page = pageMap.get(pageId);
      page.revisions++;
      page.handles.add(handleId);
      tags.forEach(tag => page.tags.add(tag));
      touch(page, time);
      const handle = handleMap.get(handleId);
      handle.revisions++;
      handle.pages.add(pageId);
      handle.wikis.add(page.wiki);
      touch(handle, time);
      if (time) revisionDays.set(time.slice(0, 10), (revisionDays.get(time.slice(0, 10)) || 0) + 1);
      if (row.body_len >= 160 && handle.kind === "unverified") {
        if (!bodyGroups.has(row.body_sha256)) bodyGroups.set(row.body_sha256, []);
        bodyGroups.get(row.body_sha256).push(revision);
      }
    }
    const dailyMap = new Map();
    const types = countObject(TYPES);
    const grades = countObject(GRADES);
    const wikis = countObject(WIKIS);
    const events = [];
    let unheldEvents = 0;
    let unattributedEvents = 0;
    for (const { row, line } of raw["events.jsonl"]) {
      const revisionId = row.revision_ref ? revisionIds.get(row.revision_ref) || null : null;
      if (row.event_type === "save") requireValue(revisionId !== null, "A save event has no retained revision_ref.");
      const revision = revisionMap.get(revisionId);
      const pageId = row.page_key ? pageIds.get(row.page_key) || null : null;
      if (revision) requireValue(revision.pageId === pageId, "Save event and revision page keys disagree.");
      const handleId = revision ? revision.handleId : typeof row.actor_label === "string" ? handleIds.get(row.actor_label) : null;
      const time = timestamp(row.time, "event time");
      const wiki = row.event_type === "probe" ? "unattributed" : enumOr(row.wiki, WIKIS, "other");
      if (pageId) requireValue(pageMap.get(pageId).wiki === wiki, "Event wiki disagrees with its page key.");
      const uncertainty = row.uncertainty_seconds === undefined ? (revision ? revision.uncertaintySeconds : null) : row.uncertainty_seconds;
      const event = {
        id: eventIds.get(row.event_id), type: row.event_type, time, wiki, pageId, handleId,
        revisionId, grade: enumOr(row.time_grade, GRADES, "unknown"),
        uncertaintySeconds: uncertainty === null ? null : integer(uncertainty, "event uncertainty"),
        successObserved: typeof row.success_observed === "boolean" ? row.success_observed : null,
        relatedId: eventIds.get(row.related_event_id) || null,
        relationType: row.relation_type === "first_recreation_of" ? "first_recreation_of" : null,
        tags: revision ? [...revision.tags] : [], sourceLine: line
      };
      events.push(event);
      types[event.type]++;
      grades[event.grade]++;
      wikis[event.wiki]++;
      if (wiki === "unattributed") unattributedEvents++;
      if (pageId) {
        const page = pageMap.get(pageId);
        page.events++;
        if (!page.held) unheldEvents++;
        if (event.type === "delete") page.deletions++;
        if (event.relationType) page.recreations++;
        touch(page, time);
      }
      if (time) {
        const day = time.slice(0, 10);
        if (!dailyMap.has(day)) dailyMap.set(day, { day, save: 0, delete: 0, revert: 0, probe: 0, total: 0 });
        dailyMap.get(day)[event.type]++;
        dailyMap.get(day).total++;
      }
    }
    events.sort((a, b) => compare(a.time || "\uffff", b.time || "\uffff") || compare(a.id, b.id));
    const pages = [...pageMap.values()].map(page => ({ ...page, handles: [...page.handles].sort(), tags: [...page.tags].sort() })).sort((a, b) => compare(a.id, b.id));
    const handles = [...handleMap.values()].map(handle => ({ ...handle, pages: [...handle.pages].sort(), wikis: [...handle.wikis].sort() })).sort((a, b) => compare(a.id, b.id));
    const dates = [...dailyMap.keys()].sort();
    if (dates.length) {
      const first = Date.parse(`${dates[0]}T00:00:00Z`);
      const last = Date.parse(`${dates[dates.length - 1]}T00:00:00Z`);
      requireValue((last - first) / 86400000 < LIMITS.calendarDays, "Archive date range exceeds the calendar bound.");
      for (let current = first; current <= last; current += 86400000) {
        const day = new Date(current).toISOString().slice(0, 10);
        if (!dailyMap.has(day)) dailyMap.set(day, { day, save: 0, delete: 0, revert: 0, probe: 0, total: 0 });
      }
    }
    const daily = [...dailyMap.values()].sort((a, b) => compare(a.day, b.day));
    const repeated = [...bodyGroups.entries()].filter(([, group]) => new Set(group.map(rev => rev.handleId)).size >= 2);
    repeated.sort((a, b) => b[1].length - a[1].length || compare(a[0], b[0]));
    const reuse = repeated.map(([sha256, group], index) => ({
      id: identifier("G", index), sha256, bytes: group[0].bytes,
      revisionIds: group.map(revision => revision.id),
      pageIds: [...new Set(group.map(revision => revision.pageId))].sort(),
      handleIds: [...new Set(group.map(revision => revision.handleId))].sort()
    }));
    const peak = [...daily].sort((a, b) => b.total - a.total || compare(a.day, b.day))[0];
    const peakRevision = [...revisionDays.entries()].sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))[0];
    const times = events.map(event => event.time).filter(Boolean);
    const cut = manifest.cut && manifest.cut.field === "revision.write_date" && manifest.cut.operator === ">=" && /^\d{4}-\d{2}-\d{2}$/.test(manifest.cut.value)
      ? { field: "revision.write_date", operator: ">=", value: manifest.cut.value } : null;
    const data = {
      schema: SCHEMA,
      source: {
        title: integrity.matchesReference ? "collusion.wiki public export" : "Local archive (unverified origin)",
        url: integrity.matchesReference ? REFERENCE_URL : null,
        generatedAt: timestamp(manifest.generated_at, "export timestamp"),
        archiveSha256: integrity.archiveSha256, matchesReference: integrity.matchesReference,
        files: integrity.files, cut, privacy: "metadata-only"
      },
      stats: {
        events: events.length, revisions: revisionMap.size, heldPages: raw["pages.jsonl"].length,
        referencedPages: pages.length, handles: handles.length, publishedHandles: raw["labels.jsonl"].length,
        namedHandles: handles.filter(handle => handle.kind === "unverified").length,
        humanHandles: handles.filter(handle => handle.kind === "human").length,
        unattributedEvents, unheldEvents, start: times[0] || null, end: times[times.length - 1] || null,
        peakDay: peak ? peak.day : null, peakDayEvents: peak ? peak.total : 0,
        peakRevisionDay: peakRevision ? peakRevision[0] : null, peakRevisionCount: peakRevision ? peakRevision[1] : 0,
        reusedTextGroups: reuse.length, types, grades, wikis
      },
      daily, rules: RULES.map(rule => ({ ...rule, terms: [...rule.terms] })),
      events, pages, handles, revisions: [...revisionMap.values()], reuse
    };
    assertPublic(data);
    return { data, privateData };
  }

  function exactKeys(value, allowed, label) {
    object(value, label);
    requireValue(Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key)), `${label} contains missing or non-public fields.`);
  }

  function publicId(value, prefix, nullable = false) {
    requireValue((nullable && value === null) || (typeof value === "string" && new RegExp(`^${prefix}\\d{5,6}$`).test(value)), "Invalid public identifier.");
  }

  function publicIds(values, prefix) {
    requireValue(Array.isArray(values) && values.length <= LIMITS.rows, "Invalid identifier array.");
    values.forEach(value => publicId(value, prefix));
  }

  function assertPublic(data) {
    exactKeys(data, ["schema", "source", "stats", "daily", "rules", "events", "pages", "handles", "revisions", "reuse"], "Dataset");
    requireValue(data.schema === SCHEMA, "Unsupported projection schema.");
    exactKeys(data.source, ["title", "url", "generatedAt", "archiveSha256", "matchesReference", "files", "cut", "privacy"], "Source");
    requireValue(data.source.privacy === "metadata-only" && typeof data.source.matchesReference === "boolean", "Projection privacy marker is invalid.");
    requireValue(data.source.title === (data.source.matchesReference ? "collusion.wiki public export" : "Local archive (unverified origin)"), "Source title must not contain private text.");
    requireValue(data.source.url === (data.source.matchesReference ? REFERENCE_URL : null), "Source URL is not allowlisted.");
    requireValue(isHash(data.source.archiveSha256), "Invalid archive fingerprint.");
    timestamp(data.source.generatedAt, "source timestamp");
    requireValue(Array.isArray(data.source.files) && data.source.files.length === 5, "Invalid source file list.");
    const fileNames = new Set();
    for (const file of data.source.files) {
      exactKeys(file, ["name", "sha256", "rows"], "Source file");
      requireValue(FILES.includes(file.name) && !fileNames.has(file.name) && isHash(file.sha256), "Invalid source file metadata.");
      fileNames.add(file.name);
      if (data.source.matchesReference) requireValue(REFERENCE_HASHES[file.name] === file.sha256, "Reference attribution differs from the published file fingerprints.");
      integer(file.rows, "source rows", LIMITS.rows);
    }
    if (data.source.cut !== null) {
      exactKeys(data.source.cut, ["field", "operator", "value"], "Cut");
      requireValue(data.source.cut.field === "revision.write_date" && data.source.cut.operator === ">=" && /^\d{4}-\d{2}-\d{2}$/.test(data.source.cut.value), "Cut contains unsupported text.");
    }
    requireValue(JSON.stringify(data.rules) === JSON.stringify(RULES), "Rule definitions must be the published, fixed keyword lenses.");
    const arrayNames = ["events", "pages", "handles", "revisions", "reuse", "daily"];
    for (const name of arrayNames) requireValue(Array.isArray(data[name]) && data[name].length <= LIMITS.rows, `Invalid ${name} array.`);
    for (const page of data.pages) {
      exactKeys(page, ["id", "title", "wiki", "held", "revisions", "events", "handles", "first", "last", "deletedSnapshot", "deletions", "recreations", "tags"], "Page");
      publicId(page.id, "P");
      requireValue(page.title === `Page ${page.id}` && WIKIS.includes(page.wiki), "Page contains a private title or wiki.");
      requireValue(typeof page.held === "boolean" && (page.deletedSnapshot === null || typeof page.deletedSnapshot === "boolean"), "Invalid page flags.");
      publicIds(page.handles, "H");
      for (const name of ["revisions", "events", "deletions", "recreations"]) integer(page[name], name);
      timestamp(page.first, "page first"); timestamp(page.last, "page last");
      requireValue(Array.isArray(page.tags) && page.tags.every(tag => RULE_IDS.has(tag)), "Invalid page tags.");
    }
    for (const handle of data.handles) {
      exactKeys(handle, ["id", "title", "kind", "revisions", "pages", "first", "last", "wikis"], "Handle");
      publicId(handle.id, "H");
      requireValue(["unverified", "human", "unattributed"].includes(handle.kind), "Invalid handle kind.");
      requireValue(handle.title === (handle.kind === "unattributed" ? "Unattributed" : `Handle ${handle.id}`), "Handle contains a private name.");
      publicIds(handle.pages, "P"); integer(handle.revisions, "handle revisions");
      timestamp(handle.first, "handle first"); timestamp(handle.last, "handle last");
      requireValue(Array.isArray(handle.wikis) && handle.wikis.every(wiki => WIKIS.includes(wiki)), "Invalid handle wikis.");
    }
    for (const event of data.events) {
      exactKeys(event, ["id", "type", "time", "wiki", "pageId", "handleId", "revisionId", "grade", "uncertaintySeconds", "successObserved", "relatedId", "relationType", "tags", "sourceLine"], "Event");
      publicId(event.id, "E"); publicId(event.pageId, "P", true); publicId(event.handleId, "H", true);
      publicId(event.revisionId, "R", true); publicId(event.relatedId, "E", true);
      requireValue(TYPES.includes(event.type) && WIKIS.includes(event.wiki) && GRADES.includes(event.grade), "Event contains unsupported text.");
      requireValue(event.relationType === null || event.relationType === "first_recreation_of", "Invalid event relation.");
      requireValue(event.successObserved === null || typeof event.successObserved === "boolean", "Invalid observed-success flag.");
      timestamp(event.time, "event time"); integer(event.sourceLine, "event line", LIMITS.rows);
      if (event.uncertaintySeconds !== null) integer(event.uncertaintySeconds, "event uncertainty");
      requireValue(Array.isArray(event.tags) && event.tags.every(tag => RULE_IDS.has(tag)), "Invalid event tags.");
    }
    for (const revision of data.revisions) {
      exactKeys(revision, ["id", "pageId", "handleId", "time", "grade", "uncertaintySeconds", "bytes", "lines", "sha256", "previousId", "hunks", "tags", "sourceLine"], "Revision");
      publicId(revision.id, "R"); publicId(revision.pageId, "P"); publicId(revision.handleId, "H"); publicId(revision.previousId, "R", true);
      requireValue(GRADES.includes(revision.grade) && isHash(revision.sha256), "Invalid revision metadata.");
      timestamp(revision.time, "revision time");
      for (const key of ["bytes", "lines", "sourceLine"]) integer(revision[key], key);
      if (revision.uncertaintySeconds !== null) integer(revision.uncertaintySeconds, "revision uncertainty");
      requireValue(Array.isArray(revision.tags) && revision.tags.every(tag => RULE_IDS.has(tag)), "Invalid revision tags.");
      requireValue(Array.isArray(revision.hunks), "Invalid hunks.");
      for (const hunk of revision.hunks) {
        exactKeys(hunk, ["op", "a0", "a1", "b0", "b1"], "Hunk");
        requireValue(["equal", "insert", "delete", "replace"].includes(hunk.op), "Invalid hunk operation.");
        for (const key of ["a0", "a1", "b0", "b1"]) integer(hunk[key], key, LIMITS.bodyBytes);
        requireValue(hunk.a0 <= hunk.a1 && hunk.b0 <= hunk.b1 && hunk.b1 <= revision.lines, "Invalid public hunk range.");
      }
    }
    for (const group of data.reuse) {
      exactKeys(group, ["id", "sha256", "bytes", "revisionIds", "pageIds", "handleIds"], "Reuse group");
      publicId(group.id, "G"); requireValue(isHash(group.sha256), "Invalid reuse digest.");
      integer(group.bytes, "reuse bytes"); publicIds(group.revisionIds, "R"); publicIds(group.pageIds, "P"); publicIds(group.handleIds, "H");
    }
    for (const day of data.daily) {
      exactKeys(day, ["day", "save", "delete", "revert", "probe", "total"], "Daily row");
      requireValue(/^\d{4}-\d{2}-\d{2}$/.test(day.day), "Invalid daily date.");
      [...TYPES, "total"].forEach(key => integer(day[key], key));
    }
    const numericStats = ["events", "revisions", "heldPages", "referencedPages", "handles", "publishedHandles", "namedHandles", "humanHandles", "unattributedEvents", "unheldEvents", "peakDayEvents", "peakRevisionCount", "reusedTextGroups"];
    exactKeys(data.stats, [...numericStats, "start", "end", "peakDay", "peakRevisionDay", "types", "grades", "wikis"], "Stats");
    numericStats.forEach(key => integer(data.stats[key], key));
    timestamp(data.stats.start, "start"); timestamp(data.stats.end, "end");
    for (const key of ["peakDay", "peakRevisionDay"]) requireValue(data.stats[key] === null || /^\d{4}-\d{2}-\d{2}$/.test(data.stats[key]), "Invalid peak date.");
    for (const [key, names] of [["types", TYPES], ["grades", GRADES], ["wikis", WIKIS]]) {
      exactKeys(data.stats[key], names, key);
      names.forEach(name => integer(data.stats[key][name], name));
    }
    requireValue(data.stats.events === data.events.length && data.stats.revisions === data.revisions.length
      && data.stats.referencedPages === data.pages.length && data.stats.handles === data.handles.length, "Projection counts do not match its rows.");
    const sets = {};
    for (const name of ["events", "pages", "handles", "revisions", "reuse"]) {
      sets[name] = new Set(data[name].map(row => row.id));
      requireValue(sets[name].size === data[name].length, "Projection identifiers are duplicated.");
    }
    for (const event of data.events) {
      for (const [key, name] of [["pageId", "pages"], ["handleId", "handles"], ["revisionId", "revisions"], ["relatedId", "events"]]) {
        requireValue(event[key] === null || sets[name].has(event[key]), "Projection contains an unresolved event reference.");
      }
    }
    for (const revision of data.revisions) {
      requireValue(sets.pages.has(revision.pageId) && sets.handles.has(revision.handleId)
        && (revision.previousId === null || sets.revisions.has(revision.previousId)), "Projection contains an unresolved revision reference.");
    }
    for (const page of data.pages) requireValue(page.handles.every(id => sets.handles.has(id)), "Projection contains an unresolved page handle.");
    for (const handle of data.handles) requireValue(handle.pages.every(id => sets.pages.has(id)), "Projection contains an unresolved handle page.");
    for (const group of data.reuse) {
      for (const [key, name] of [["revisionIds", "revisions"], ["pageIds", "pages"], ["handleIds", "handles"]]) {
        requireValue(group[key].every(id => sets[name].has(id)), "Projection contains an unresolved reuse reference.");
      }
    }
    for (const [key, field, allowed] of [["types", "type", TYPES], ["grades", "grade", GRADES], ["wikis", "wiki", WIKIS]]) {
      const actual = countObject(allowed);
      data.events.forEach(event => actual[event[field]]++);
      requireValue(allowed.every(name => actual[name] === data.stats[key][name]), "Projection category counts differ from their events.");
    }
    requireValue(data.daily.reduce((sum, day) => sum + day.total, 0) === data.events.filter(event => event.time !== null).length, "Calendar totals differ from dated events.");
    return data;
  }

  async function decompress(bytes, format, limit) {
    requireValue(typeof DecompressionStream === "function", "This browser needs native decompression support. Use a current Chrome or Edge.");
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > limit) {
          await reader.cancel();
          throw new ArchiveError("Decompressed input exceeded its declared bound.");
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  }

  async function browserDigest(bytes) {
    requireValue(root.crypto && root.crypto.subtle, "This browser needs Web Crypto in a secure or local-file context.");
    const digest = await root.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  async function loadBundle(base64) {
    requireValue(typeof base64 === "string" && base64.length <= LIMITS.archiveBytes * 2, "Bundled metadata exceeds its size bound.");
    const packed = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const expanded = await decompress(packed, "gzip", LIMITS.bundleBytes);
    return assertPublic(parseJSON(expanded, "Bundled metadata"));
  }

  async function loadLocal(file, progress) {
    requireValue(file && typeof file.arrayBuffer === "function" && file.size <= LIMITS.archiveBytes, "Choose a ZIP smaller than 16 MiB.");
    return loadArchive(await file.arrayBuffer(), {
      inflateRaw: (bytes, limit) => decompress(bytes, "deflate-raw", limit),
      digest: browserDigest, progress
    });
  }

  function exportSelection(data, ids) {
    assertPublic(data);
    requireValue(Array.isArray(ids) && ids.length <= LIMITS.rows, "Invalid export selection.");
    ids.forEach(id => publicId(id, "E"));
    const wanted = new Set(ids);
    const events = data.events.filter(event => wanted.has(event.id));
    requireValue(events.length === wanted.size, "Selection contains an unknown event.");
    const pages = new Set(events.map(event => event.pageId).filter(Boolean));
    const handles = new Set(events.map(event => event.handleId).filter(Boolean));
    const revisions = new Set(events.map(event => event.revisionId).filter(Boolean));
    return JSON.parse(JSON.stringify({
      schema: "rapp-wiki-observatory/selection-1", privacy: "metadata-only",
      source: data.source, eventCount: events.length, events,
      pages: data.pages.filter(page => pages.has(page.id)),
      handles: data.handles.filter(handle => handles.has(handle.id)),
      revisions: data.revisions.filter(revision => revisions.has(revision.id))
    }));
  }

  const api = Object.freeze({
    SCHEMA, FILES, LIMITS, REFERENCE_HASHES, RULES, ArchiveError,
    crc32, readZip, loadArchive, assertPublic, loadBundle, loadLocal, exportSelection
  });
  if (typeof module === "object" && module.exports) module.exports = api;
  root.WikiEvidence = api;
})(globalThis);
