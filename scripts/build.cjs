"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const evidence = require("../web/data.js");

const root = path.resolve(__dirname, "..");
const digest = async bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const adapters = {
  digest,
  inflateRaw: async (bytes, maximum) => zlib.inflateRawSync(bytes, { maxOutputLength: maximum })
};

function readBounded(filename, maximum) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new Error("Expected a bounded regular input file.");
  return fs.readFileSync(filename);
}

function insert(template, token, value) {
  if (template.split(token).length !== 2) throw new Error(`Template must contain exactly one ${token}.`);
  return template.replace(token, () => value);
}

function compileHTML(template, packed, archiveCode, appCode) {
  let html = insert(template, "__DATA_GZIP_BASE64__", packed.toString("base64"));
  html = insert(html, "__ARCHIVE_JS__", archiveCode.replace(/<\/script/gi, "<\\/script"));
  html = insert(html, "__APP_JS__", appCode.replace(/<\/script/gi, "<\\/script"));
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(([, attributes]) => !/type=["']application\/(?:octet-stream|json)["']/i.test(attributes));
  if (scripts.length !== 3 || scripts.some(([, attributes]) => /\bsrc\s*=/i.test(attributes))) {
    throw new Error("The offline artifact must have exactly three inline executable scripts.");
  }
  const hashes = scripts.map(([, , code]) => `'sha256-${crypto.createHash("sha256").update(code).digest("base64")}'`);
  const policy = `default-src 'none'; script-src ${hashes.join(" ")}; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  if (!/<head>/i.test(html) || /http-equiv=["']Content-Security-Policy["']/i.test(html)) throw new Error("Template must have one plain head and no competing CSP.");
  return html.replace(/<head>/i, `<head>\n<meta http-equiv="Content-Security-Policy" content="${policy}">`);
}

async function main(args) {
  let archive = null;
  let projectionOnly = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--archive" && args[index + 1]) archive = args[++index];
    else if (args[index] === "--project-only") projectionOnly = true;
    else throw new Error("Usage: node scripts/build.cjs [--archive /private/full-wiki-logs.zip] [--project-only]");
  }
  const publicPath = path.join(root, "data", "public.json.gz");
  let packed;
  let data;
  if (archive) {
    const loaded = await evidence.loadArchive(readBounded(archive, evidence.LIMITS.archiveBytes), adapters);
    if (!loaded.integrity.matchesReference) throw new Error("Public builds require the known published source checksums. Unrecognized archives are local-view only.");
    data = evidence.assertPublic(loaded.data);
    packed = zlib.gzipSync(Buffer.from(JSON.stringify(data)), { level: 9 });
    fs.mkdirSync(path.dirname(publicPath), { recursive: true });
    fs.writeFileSync(publicPath, packed);
    fs.writeFileSync(path.join(root, "data", "summary.json"), JSON.stringify({
      schema: data.schema, source: data.source, stats: data.stats,
      projectionSha256: await digest(packed),
      projectionBytes: packed.length,
      excluded: ["revision bodies", "original page titles", "original handles", "IP addresses", "recorded URLs", "request parameters", "local paths"]
    }, null, 2) + "\n");
  } else {
    packed = readBounded(publicPath, evidence.LIMITS.archiveBytes);
    data = evidence.assertPublic(JSON.parse(zlib.gunzipSync(packed, { maxOutputLength: evidence.LIMITS.bundleBytes }).toString("utf8")));
  }
  console.log(JSON.stringify({ events: data.stats.events, revisions: data.stats.revisions, heldPages: data.stats.heldPages, referencedPages: data.stats.referencedPages, handles: data.stats.handles, reusedTextGroups: data.stats.reusedTextGroups, metadataGzipBytes: packed.length }));
  if (projectionOnly) return;
  const template = fs.readFileSync(path.join(root, "web", "index.template.html"), "utf8");
  const archiveCode = fs.readFileSync(path.join(root, "web", "data.js"), "utf8");
  const appCode = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
  const html = compileHTML(template, packed, archiveCode, appCode);
  if (/__(?:DATA_GZIP_BASE64|ARCHIVE_JS|APP_JS)__/.test(html)) throw new Error("Build contains an unresolved placeholder.");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "index.html"), html);
  fs.writeFileSync(path.join(root, "docs", ".nojekyll"), "");
  console.log(`Built docs/index.html (${Buffer.byteLength(html)} bytes); no raw archive or record bodies were bundled.`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Build refused: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { adapters, compileHTML, main };
