"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const zlib = require("node:zlib");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { fixture } = require("./fixture.cjs");

const root = path.resolve(__dirname, "..");
const output = process.env.OBSERVATORY_PROOF_DIR || path.join(root, "artifacts", "browser");
const dataset = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, "data/public.json.gz"))));
const url = pathToFileURL(path.join(root, "docs", "index.html")).href;
const results = [];

async function waitCount(page, count, total = dataset.events.length) {
  const expected = `${count.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} events`;
  await page.waitForFunction(text => document.getElementById("filter-count").textContent.startsWith(text), expected);
}

async function reset(page) {
  await page.locator("#reset-filters").click();
  await waitCount(page, dataset.events.length);
}

async function view(page, name) {
  await page.getByRole("tab", { name, exact: true }).click();
  await page.waitForFunction(text => document.getElementById("view-heading").textContent === text, name);
}

async function closeDialog(page) {
  await page.locator("#close-dialog").click();
  await page.waitForFunction(() => !document.getElementById("evidence-dialog").open);
}

async function inspectFirst(page, label = "Inspect") {
  await page.locator("#view-content").getByRole("button", { name: label, exact: true }).first().click();
  await page.locator("#evidence-dialog").waitFor({ state: "visible" });
}

async function pinAndExport(page) {
  await page.getByRole("button", { name: "Pin event", exact: true }).click();
  await closeDialog(page);
  assert.equal(await page.locator("#export-selection").isEnabled(), true);
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export-selection").click();
  const download = await downloadPromise;
  const exported = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
  assert.equal(exported.privacy, "metadata-only");
  assert.ok(exported.eventCount > 0);
  await page.locator("#open-pins").click();
  assert.match(await page.locator("#dialog-body").innerText(), /Only event IDs/);
  await page.locator("#dialog-body").getByRole("button", { name: "Remove", exact: true }).first().click();
  await page.waitForFunction(() => !document.getElementById("evidence-dialog").open);
  assert.equal(await page.locator("#export-selection").isDisabled(), true);
  return exported;
}

async function screenshot(page, name) {
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.mouse.move(0, 0);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: path.join(output, name), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `horizontal overflow: ${name}`);
}

async function publicFlows(page, label) {
  await waitCount(page, dataset.events.length);
  assert.equal(await page.locator("#privacy-title").innerText(), "Metadata-only view");
  assert.equal(await page.locator("#export-selection").isDisabled(), true);
  const beforeTheme = await page.locator("html").getAttribute("data-theme");
  await page.locator("#theme-toggle").click();
  assert.notEqual(await page.locator("html").getAttribute("data-theme"), beforeTheme);
  await page.locator("#theme-toggle").click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), beforeTheme);
  for (const type of ["save", "delete", "revert", "probe"]) {
    await page.locator("#type-filter").selectOption(type);
    await waitCount(page, dataset.stats.types[type]);
  }
  await reset(page);
  await page.locator("#jump-results").click();
  assert.equal(await page.evaluate(() => document.activeElement.id), "main-content");
  await page.locator("#show-methods").click();
  assert.equal(await page.locator("#view-heading").innerText(), "Methods");
  await view(page, "Activity");

  await page.locator("#type-filter").selectOption("save");
  await page.locator("#wiki-filter").selectOption("dse");
  await page.locator("#grade-filter").selectOption("reqlog");
  const subset = dataset.events.filter(event => event.type === "save" && event.wiki === "dse" && event.grade === "reqlog");
  await waitCount(page, subset.length);
  await page.locator("#date-from").fill("2026-06-16");
  await page.locator("#date-from").dispatchEvent("change");
  await page.locator("#date-to").fill("2026-06-22");
  await page.locator("#date-to").dispatchEvent("change");
  await waitCount(page, subset.filter(event => event.time.slice(0, 10) >= "2026-06-16" && event.time.slice(0, 10) <= "2026-06-22").length);
  await reset(page);

  await page.locator("#search-filter").fill("E000001");
  await waitCount(page, 1);
  await inspectFirst(page);
  assert.match(await page.locator("#dialog-body").innerText(), /events\.jsonl:1/);
  const exported = await pinAndExport(page);
  assert.equal(exported.events[0].id, "E000001");
  await reset(page);

  await page.locator("#type-filter").selectOption("save");
  await page.locator("#wiki-filter").selectOption("unattributed");
  await waitCount(page, 0);
  assert.equal(await page.getByRole("heading", { name: "No matching events" }).isVisible(), true);
  await reset(page);
  await page.locator("#date-from").fill("2026-07-14");
  await page.locator("#date-from").dispatchEvent("change");
  await page.locator("#date-to").fill("2026-05-17");
  await page.locator("#date-to").dispatchEvent("change");
  assert.equal(await page.locator("#date-from").getAttribute("aria-invalid"), "true");
  await reset(page);

  await page.getByRole("button", { name: /^2026-06-18:.*Filter/ }).click();
  await waitCount(page, dataset.daily.find(day => day.day === "2026-06-18").total);
  await reset(page);
  await screenshot(page, `${label}-activity.png`);

  for (const name of ["Pages", "Handles", "Reuse"]) {
    await view(page, name);
    assert.ok(await page.locator("#view-content tbody tr").count() > 0);
    const next = page.locator("#view-content").getByRole("button", { name: "Next", exact: true });
    if (await next.isEnabled()) {
      const first = await page.locator("#view-content tbody tr").first().innerText();
      await next.click();
      assert.notEqual(await page.locator("#view-content tbody tr").first().innerText(), first);
      await page.locator("#view-content").getByRole("button", { name: "Previous", exact: true }).click();
    }
    await inspectFirst(page, name === "Reuse" ? "Inspect revisions" : "Inspect");
    assert.ok((await page.locator("#dialog-body").innerText()).length > 100);
    if (name === "Reuse") {
      await page.locator("#dialog-body").getByRole("button", { name: /^R\d/ }).first().click();
      assert.match(await page.locator("#dialog-body").innerText(), /revisions\.jsonl:/);
      assert.match(await page.locator("#dialog-body").innerText(), /Full text is intentionally absent/);
    }
    await closeDialog(page);
  }

  await view(page, "Overlap");
  const nodes = page.locator(".graph-node-control");
  const edges = page.locator(".graph-edge-control");
  assert.ok(await nodes.count() > 0 && await nodes.count() <= 24);
  assert.ok(await edges.count() > 0 && await edges.count() <= 80);
  if (await edges.first().isVisible()) {
    await edges.first().focus();
    await page.keyboard.press("Enter");
  } else {
    await page.getByRole("button", { name: "Inspect shared pages", exact: true }).first().click();
  }
  assert.match(await page.locator("#dialog-body").innerText(), /does not show communication or motive/);
  await page.getByRole("button", { name: "Filter activity to shared pages", exact: true }).click();
  assert.equal(await page.locator("#scope-box").isVisible(), true);
  await page.locator("#clear-scope").click();
  await waitCount(page, dataset.events.length);
  await view(page, "Overlap");
  await screenshot(page, `${label}-overlap.png`);

  await view(page, "Methods");
  assert.match(await page.locator("#view-content").innerText(), /revisions\.jsonl/);
  await page.getByRole("tab", { name: "Activity", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator("#view-heading").innerText(), "Pages");
  const focus = await page.evaluate(() => {
    const value = getComputedStyle(document.activeElement);
    return { role: document.activeElement.getAttribute("role"), outline: value.outlineStyle };
  });
  assert.equal(focus.role, "tab");
  assert.notEqual(focus.outline, "none");
  await view(page, "Activity");
  const unheld = dataset.pages.find(page => !page.held);
  await page.locator("#search-filter").fill(unheld.id);
  await waitCount(page, dataset.events.filter(event => event.pageId === unheld.id).length);
  await inspectFirst(page);
  assert.match(await page.locator("#dialog-body").innerText(), /unheld page/);
  await closeDialog(page);
  await reset(page);
}

async function privateFlows(page, errors) {
  const sample = fixture();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.locator("#import-archive").click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "synthetic-fixture.zip", mimeType: "application/zip", buffer: sample.zip
  });
  await page.waitForFunction(() => document.getElementById("privacy-title").textContent === "Private archive loaded locally", null, { timeout: 60000 });
  await waitCount(page, 4, 4);
  assert.match(await page.locator("#import-status").innerText(), /origin is unrecognized/);
  await view(page, "Activity");
  await page.locator("#search-filter").fill("café");
  await waitCount(page, 2, 4);
  await inspectFirst(page);
  await page.getByRole("button", { name: "Inspect revision", exact: true }).click();
  assert.match(await page.locator(".body-preview").innerText(), /^café/);
  assert.match(await page.locator(".body-preview").innerText(), /<img src=/);
  assert.equal(await page.locator('img[src*="do-not-fetch"]').count(), 0);
  assert.equal(await page.locator('a[href*="do-not-fetch"]').count(), 0);
  assert.equal(await page.evaluate(() => globalThis.__unsafeArchiveExecuted), undefined);
  await closeDialog(page);
  await inspectFirst(page);
  const exported = await pinAndExport(page);
  const serialized = JSON.stringify(exported);
  for (const privateValue of [sample.name, sample.privateHandle, sample.secondHandle, sample.text, "do-not-fetch.invalid"]) {
    assert.ok(!serialized.includes(privateValue), "Private fixture value escaped through export.");
  }
  assert.ok(!page.url().includes("café"));
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  await page.locator("#unload-archive").click();
  await waitCount(page, dataset.events.length);
  assert.equal(await page.locator("#privacy-title").innerText(), "Metadata-only view");
  assert.ok(!(await page.locator("body").innerText()).includes(sample.privateHandle));
  assert.equal(await page.locator("#open-pins").isDisabled(), true);

  const allowedErrors = errors.length;
  await page.locator("#archive-input").setInputFiles({
    name: "invalid.zip", mimeType: "application/zip", buffer: Buffer.from("not an archive")
  });
  await page.waitForFunction(() => document.getElementById("import-status").textContent.startsWith("Import failed:"));
  assert.equal(await page.locator("#privacy-title").innerText(), "Metadata-only view");
  await waitCount(page, dataset.events.length);
  const expected = errors.splice(allowedErrors);
  assert.ok(expected.every(message => /ArchiveError|archive|bound/i.test(message)));

  if (process.env.WIKI_ARCHIVE) {
    await page.locator("#archive-input").setInputFiles(process.env.WIKI_ARCHIVE);
    await page.waitForFunction(() => document.getElementById("privacy-title").textContent === "Private archive loaded locally", null, { timeout: 120000 });
    await waitCount(page, dataset.events.length);
    assert.match(await page.locator("#integrity-line").innerText(), /14,591 bodies/);
    assert.match(await page.locator("#import-status").innerText(), /match the published reference/);
    await page.locator("#search-filter").fill("__observatory_no_match_94212__");
    await waitCount(page, 0);
    assert.match(await page.locator("#search-note").innerText(), /complete within bound/);
    assert.ok(!(await page.locator("#search-note").innerText()).includes("scan limit reached"));
    await page.locator("#reset-filters").click();
    await waitCount(page, dataset.events.length);
    const revision = dataset.revisions.find(revision => revision.previousId && revision.hunks.some(hunk => hunk.op !== "equal"));
    const event = dataset.events.find(event => event.revisionId === revision.id);
    await page.locator("#search-filter").fill(event.id);
    await waitCount(page, 1);
    await inspectFirst(page);
    await page.getByRole("button", { name: "Inspect revision", exact: true }).click();
    assert.ok(await page.locator(".change-block").count() > 0);
    assert.match(await page.locator("#dialog-body").innerText(), /revisions\.jsonl:/);
    await closeDialog(page);
    await page.locator("#unload-archive").click();
    await waitCount(page, dataset.events.length);
  }
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    headless: true,
    chromiumSandbox: true
  });
  try {
    for (const width of [1440, 390]) {
      for (const theme of ["light", "dark"]) {
        const label = `${width > 600 ? "desktop" : "mobile"}-${theme}`;
        const context = await browser.newContext({ viewport: { width, height: width > 600 ? 1000 : 844 }, offline: true, acceptDownloads: true, reducedMotion: "reduce" });
        const page = await context.newPage();
        const errors = [];
        const pageErrors = [];
        const network = [];
        const policyViolations = [];
        page.on("pageerror", error => pageErrors.push(error.message));
        page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
        page.on("request", request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
        await page.addInitScript(() => {
          globalThis.__policyViolations = [];
          addEventListener("securitypolicyviolation", event => globalThis.__policyViolations.push(event.violatedDirective));
        });
        const started = Date.now();
        await page.goto(`${url}?scoutTheme=${theme}`);
        await page.waitForFunction(() => document.getElementById("app-shell")?.getAttribute("aria-busy") === "false");
        const coldMilliseconds = Date.now() - started;
        await publicFlows(page, label);
        if (width === 1440 && theme === "light") await privateFlows(page, errors);
        policyViolations.push(...await page.evaluate(() => globalThis.__policyViolations));
        assert.deepEqual(pageErrors, [], `${label}: page errors`);
        assert.deepEqual(errors, [], `${label}: console errors`);
        assert.deepEqual(network, [], `${label}: unexpected HTTP requests`);
        assert.deepEqual(policyViolations, [], `${label}: CSP violations`);
        results.push({ label, viewport: { width, height: width > 600 ? 1000 : 844 }, coldMilliseconds, offline: true, primaryControls: true, pageErrors: 0, httpRequests: 0 });
        await context.close();
      }
    }
    const report = { browser: await browser.version(), chromiumSandbox: true, artifact: "docs/index.html", realArchiveExercised: Boolean(process.env.WIKI_ARCHIVE), results };
    fs.writeFileSync(path.join(output, "browser-report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
