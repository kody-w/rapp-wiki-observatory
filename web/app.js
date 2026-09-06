(() => {
  "use strict";

  const PAGE_SIZE = 75;
  const EDGE_LIMIT = 80;
  const NODE_LIMIT = 24;
  const SEARCH_CHARACTER_LIMIT = 96 * 1024 * 1024;
  const SEARCH_MATCH_LIMIT = 60000;
  const BODY_PREVIEW_LIMIT = 100000;
  const CHANGE_HUNK_LIMIT = 32;
  const CHANGE_LINE_LIMIT = 100;
  const EVENT_TYPES = ["save", "delete", "revert", "probe"];
  const VIEW_META = {
    activity: {
      kicker: "Chronology",
      title: "Activity",
      description: "Filter the event record, inspect evidence, and pin event IDs for a metadata-only export."
    },
    pages: {
      kicker: "Document surfaces",
      title: "Pages",
      description: "See which pseudonymous pages are represented by the current event result and where held-page metadata is unavailable."
    },
    handles: {
      kicker: "Unverified aliases",
      title: "Handles",
      description: "Compare aliases observed in the filtered record without treating a handle as an authenticated person, agent, or provider identity."
    },
    overlap: {
      kicker: "Shared-page observation",
      title: "Overlap",
      description: "Explore weighted shared-page overlap among unverified aliases. This is not a communication graph."
    },
    reuse: {
      kicker: "Identical snapshot bytes",
      title: "Reuse",
      description: "Inspect precomputed repeated-snapshot groups of at least 160 bytes spanning at least two distinct unverified nonhuman handles."
    },
    methods: {
      kicker: "Limits before claims",
      title: "Methods",
      description: "Read the projection, timestamp, privacy, source-integrity, and interpretation rules that bound this instrument."
    }
  };

  const numberFormatter = new Intl.NumberFormat("en-US");
  const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "2-digit"
  });

  const refs = {};
  const state = {
    ready: false,
    mode: "loading",
    dataset: null,
    bundledDataset: null,
    privateData: null,
    integrity: null,
    prepared: null,
    view: "activity",
    filters: freshFilters(),
    filteredEvents: [],
    searchContext: null,
    scope: null,
    pins: new Set(),
    pagination: freshPagination(),
    importBusy: false,
    importToken: 0,
    importMessage: "",
    importTone: "",
    filterError: "",
    searchTimer: 0,
    toastTimer: 0,
    downloadUrl: "",
    lastFocus: null
  };

  function freshFilters() {
    return {
      search: "",
      type: "all",
      wiki: "all",
      grade: "all",
      from: "",
      to: ""
    };
  }

  function freshPagination() {
    return {
      activity: 1,
      pages: 1,
      handles: 1,
      overlap: 1,
      reuse: 1
    };
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function own(record, key) {
    return Boolean(record) && Object.prototype.hasOwnProperty.call(record, key);
  }

  function asText(value, fallback = "—") {
    if (value === null || value === undefined || value === "") {
      return fallback;
    }
    return String(value);
  }

  function formatNumber(value) {
    return Number.isFinite(value) ? numberFormatter.format(value) : "—";
  }

  function formatBytes(value) {
    if (!Number.isFinite(value)) {
      return "—";
    }
    if (value < 1024) {
      return `${formatNumber(value)} B`;
    }
    if (value < 1024 * 1024) {
      return `${(value / 1024).toFixed(1)} KiB`;
    }
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  }

  function parseDate(value) {
    if (typeof value !== "string" || !value) {
      return null;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatDateTime(value) {
    const date = parseDate(value);
    return date ? `${dateTimeFormatter.format(date)} UTC` : "No timestamp";
  }

  function formatDate(value) {
    const date = parseDate(value);
    return date ? dateFormatter.format(date) : "No date";
  }

  function datePart(value) {
    if (typeof value !== "string") {
      return "";
    }
    const match = value.match(/^\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : "";
  }

  function truncate(value, maximum) {
    const text = asText(value, "");
    if (text.length <= maximum) {
      return text;
    }
    return `${text.slice(0, Math.max(0, maximum - 1))}…`;
  }

  function normalizeSearch(value) {
    return asText(value, "").trim().toLocaleLowerCase().slice(0, 160);
  }

  function element(tag, options = {}, children = []) {
    const node = document.createElement(tag);
    if (options.className) {
      node.className = options.className;
    }
    if (Object.prototype.hasOwnProperty.call(options, "text")) {
      node.textContent = asText(options.text, "");
    }
    if (options.attrs) {
      for (const [name, value] of Object.entries(options.attrs)) {
        if (value !== null && value !== undefined) {
          node.setAttribute(name, String(value));
        }
      }
    }
    if (options.dataset) {
      for (const [name, value] of Object.entries(options.dataset)) {
        node.dataset[name] = String(value);
      }
    }
    if (options.on) {
      for (const [name, handler] of Object.entries(options.on)) {
        node.addEventListener(name, handler);
      }
    }
    appendChildren(node, children);
    return node;
  }

  function svgElement(tag, attrs = {}) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attrs)) {
      node.setAttribute(name, String(value));
    }
    return node;
  }

  function appendChildren(parent, children) {
    const list = Array.isArray(children) ? children : [children];
    for (const child of list.flat(Infinity)) {
      if (child === null || child === undefined || child === false) {
        continue;
      }
      if (child instanceof Node) {
        parent.append(child);
      } else {
        parent.append(document.createTextNode(String(child)));
      }
    }
  }

  function button(label, handler, className = "button-small", attributes = {}) {
    return element("button", {
      className,
      text: label,
      attrs: { type: "button", ...attributes },
      on: { click: handler }
    });
  }

  function badge(label, dataName, dataValue) {
    const options = {
      className: "badge",
      text: label
    };
    if (dataName && dataValue) {
      options.dataset = { [dataName]: dataValue };
    }
    return element("span", options);
  }

  function card(title, subtitle, content, className = "") {
    const heading = element("h3", { text: title });
    const headingGroup = element("div", {}, [
      heading,
      subtitle ? element("p", { className: "card-subtitle", text: subtitle }) : null
    ]);
    return element("section", { className: `card ${className}`.trim() }, [
      element("div", { className: "section-heading-row" }, [headingGroup]),
      content
    ]);
  }

  function notice(text, tone = "") {
    return element("div", {
      className: "notice",
      dataset: tone ? { tone } : {}
    }, [element("p", { text })]);
  }

  function emptyState(title, copy, action = null) {
    return element("div", { className: "empty-state" }, [
      element("div", {}, [
        element("h3", { text: title }),
        element("p", { text: copy }),
        action ? element("div", { className: "dialog-actions" }, [action]) : null
      ])
    ]);
  }

  function evidenceList(entries) {
    const list = element("dl", { className: "evidence-list" });
    for (const [label, value] of entries) {
      const row = element("div", { className: "evidence-row" }, [
        element("dt", { text: label }),
        element("dd")
      ]);
      const target = row.lastElementChild;
      if (value instanceof Node) {
        target.append(value);
      } else {
        target.textContent = asText(value);
      }
      list.append(row);
    }
    return list;
  }

  function dialogSection(title, children) {
    return element("section", { className: "dialog-section" }, [
      element("h3", { text: title }),
      children
    ]);
  }

  function makeTable(headers, rows) {
    const table = element("table");
    const headRow = element("tr");
    for (const header of headers) {
      headRow.append(element("th", {
        text: header.label,
        attrs: { scope: "col" }
      }));
    }
    table.append(element("thead", {}, [headRow]));
    const body = element("tbody");
    for (const rowCells of rows) {
      const row = element("tr");
      rowCells.forEach((cell, index) => {
        const dataCell = element("td", {
          dataset: { label: headers[index].label }
        });
        if (cell instanceof Node) {
          dataCell.append(cell);
        } else {
          dataCell.textContent = asText(cell);
        }
        row.append(dataCell);
      });
      body.append(row);
    }
    table.append(body);
    return table;
  }

  function nameCell(primary, secondary, handler = null) {
    const wrapper = element("div");
    if (handler) {
      wrapper.append(button(primary, handler, "cell-button"));
    } else {
      wrapper.append(element("span", { className: "cell-main", text: primary }));
    }
    if (secondary && secondary !== primary) {
      wrapper.append(element("span", { className: "cell-secondary", text: secondary }));
    }
    return wrapper;
  }

  function stackedCell(primary, secondaryNode) {
    return element("div", {}, [
      element("span", { className: "cell-main", text: primary }),
      secondaryNode
    ]);
  }

  function timeCell(value) {
    const time = element("time", {
      className: "cell-main",
      text: formatDateTime(value)
    });
    if (value) {
      time.setAttribute("datetime", value);
    }
    return time;
  }

  function assert(condition, message) {
    if (!condition) {
      throw new Error(message);
    }
  }

  function validateId(value, prefix, context) {
    assert(typeof value === "string" && new RegExp(`^${prefix}\\d+$`).test(value), `${context} has an invalid ID.`);
  }

  function validateStringArray(value, context) {
    assert(Array.isArray(value), `${context} must be an array.`);
    value.forEach((item) => assert(typeof item === "string", `${context} contains a non-string value.`));
  }

  function validateDataset(data, label) {
    assert(isRecord(data), `${label} is not an object.`);
    assert(data.schema === "rapp-wiki-observatory/1", `${label} uses an unsupported schema.`);
    assert(isRecord(data.source), `${label} has no source record.`);
    assert(data.source.privacy === "metadata-only", `${label} is not a metadata-only projection.`);
    assert(typeof data.source.title === "string", `${label} has no source title.`);
    assert(typeof data.source.generatedAt === "string", `${label} has no generation timestamp.`);
    assert(typeof data.source.archiveSha256 === "string" && data.source.archiveSha256.length > 0, `${label} has no archive SHA-256.`);
    assert(typeof data.source.matchesReference === "boolean", `${label} has no reference-match state.`);
    assert(Array.isArray(data.source.files), `${label} has no verified file manifest.`);
    data.source.files.forEach((file, index) => {
      assert(isRecord(file), `${label} source file ${index + 1} is invalid.`);
      assert(typeof file.name === "string" && file.name.length > 0, `${label} source file ${index + 1} has no name.`);
      assert(typeof file.sha256 === "string" && file.sha256.length > 0, `${label} source file ${index + 1} has no SHA-256.`);
      assert(Number.isFinite(file.rows) && file.rows >= 0, `${label} source file ${index + 1} has an invalid row count.`);
    });
    assert(isRecord(data.source.cut), `${label} has no documented cut rule.`);
    assert(typeof data.source.cut.field === "string", `${label} cut field is invalid.`);
    assert(typeof data.source.cut.operator === "string", `${label} cut operator is invalid.`);
    assert(
      ["string", "number", "boolean"].includes(typeof data.source.cut.value) &&
        (typeof data.source.cut.value !== "number" || Number.isFinite(data.source.cut.value)),
      `${label} cut value is invalid.`
    );
    assert(isRecord(data.stats), `${label} has no statistics.`);

    const arrayNames = ["daily", "rules", "events", "pages", "handles", "revisions", "reuse"];
    for (const name of arrayNames) {
      assert(Array.isArray(data[name]), `${label} has no ${name} array.`);
    }

    const ruleIds = new Set();
    data.rules.forEach((rule, index) => {
      assert(isRecord(rule), `${label} rule ${index + 1} is invalid.`);
      assert(typeof rule.id === "string" && rule.id.length > 0, `${label} rule ${index + 1} has no ID.`);
      assert(!ruleIds.has(rule.id), `${label} contains duplicate rule ID ${rule.id}.`);
      ruleIds.add(rule.id);
      assert(typeof rule.label === "string", `${label} rule ${rule.id} has no label.`);
      assert(typeof rule.description === "string", `${label} rule ${rule.id} has no description.`);
      validateStringArray(rule.terms, `${label} rule ${rule.id} terms`);
    });

    data.daily.forEach((day, index) => {
      assert(isRecord(day), `${label} daily row ${index + 1} is invalid.`);
      assert(/^\d{4}-\d{2}-\d{2}$/.test(day.day), `${label} daily row ${index + 1} has an invalid UTC day.`);
      for (const key of [...EVENT_TYPES, "total"]) {
        assert(Number.isFinite(day[key]) && day[key] >= 0, `${label} daily row ${day.day} has an invalid ${key} count.`);
      }
    });

    const eventIds = new Set();
    data.events.forEach((event, index) => {
      assert(isRecord(event), `${label} event ${index + 1} is invalid.`);
      validateId(event.id, "E", `${label} event ${index + 1}`);
      assert(!eventIds.has(event.id), `${label} contains duplicate event ID ${event.id}.`);
      eventIds.add(event.id);
      assert(EVENT_TYPES.includes(event.type), `${label} event ${event.id} has an invalid type.`);
      assert(event.time === null || typeof event.time === "string", `${label} event ${event.id} has an invalid time.`);
      assert(typeof event.wiki === "string", `${label} event ${event.id} has an invalid wiki.`);
      assert(event.pageId === null || typeof event.pageId === "string", `${label} event ${event.id} has an invalid page ID.`);
      assert(event.handleId === null || typeof event.handleId === "string", `${label} event ${event.id} has an invalid handle ID.`);
      assert(event.revisionId === null || typeof event.revisionId === "string", `${label} event ${event.id} has an invalid revision ID.`);
      assert(typeof event.grade === "string", `${label} event ${event.id} has an invalid time grade.`);
      assert(event.uncertaintySeconds === null || (Number.isFinite(event.uncertaintySeconds) && event.uncertaintySeconds >= 0), `${label} event ${event.id} has invalid uncertainty.`);
      assert(event.successObserved === null || typeof event.successObserved === "boolean", `${label} event ${event.id} has an invalid success observation.`);
      assert(event.relatedId === null || typeof event.relatedId === "string", `${label} event ${event.id} has an invalid related ID.`);
      assert(event.relationType === null || event.relationType === "first_recreation_of", `${label} event ${event.id} has an invalid relation type.`);
      validateStringArray(event.tags, `${label} event ${event.id} tags`);
      assert(Number.isFinite(event.sourceLine) && event.sourceLine >= 0, `${label} event ${event.id} has an invalid source line.`);
    });

    const pageIds = new Set();
    data.pages.forEach((page, index) => {
      assert(isRecord(page), `${label} page ${index + 1} is invalid.`);
      validateId(page.id, "P", `${label} page ${index + 1}`);
      assert(!pageIds.has(page.id), `${label} contains duplicate page ID ${page.id}.`);
      pageIds.add(page.id);
      assert(typeof page.wiki === "string", `${label} page ${page.id} has an invalid wiki.`);
      assert(typeof page.held === "boolean", `${label} page ${page.id} has an invalid held state.`);
      assert(Number.isFinite(page.revisions) && page.revisions >= 0, `${label} page ${page.id} has an invalid revision count.`);
      assert(Number.isFinite(page.events) && page.events >= 0, `${label} page ${page.id} has an invalid event count.`);
      validateStringArray(page.handles, `${label} page ${page.id} handles`);
      validateStringArray(page.tags, `${label} page ${page.id} tags`);
    });

    const handleIds = new Set();
    data.handles.forEach((handle, index) => {
      assert(isRecord(handle), `${label} handle ${index + 1} is invalid.`);
      validateId(handle.id, "H", `${label} handle ${index + 1}`);
      assert(!handleIds.has(handle.id), `${label} contains duplicate handle ID ${handle.id}.`);
      handleIds.add(handle.id);
      assert(["unverified", "human", "unattributed"].includes(handle.kind), `${label} handle ${handle.id} has an invalid kind.`);
      assert(Number.isFinite(handle.revisions) && handle.revisions >= 0, `${label} handle ${handle.id} has an invalid revision count.`);
      validateStringArray(handle.pages, `${label} handle ${handle.id} pages`);
      validateStringArray(handle.wikis, `${label} handle ${handle.id} wikis`);
    });

    const revisionIds = new Set();
    data.revisions.forEach((revision, index) => {
      assert(isRecord(revision), `${label} revision ${index + 1} is invalid.`);
      validateId(revision.id, "R", `${label} revision ${index + 1}`);
      assert(!revisionIds.has(revision.id), `${label} contains duplicate revision ID ${revision.id}.`);
      revisionIds.add(revision.id);
      assert(typeof revision.pageId === "string", `${label} revision ${revision.id} has an invalid page ID.`);
      assert(revision.handleId === null || typeof revision.handleId === "string", `${label} revision ${revision.id} has an invalid handle ID.`);
      assert(revision.time === null || typeof revision.time === "string", `${label} revision ${revision.id} has an invalid time.`);
      assert(typeof revision.grade === "string", `${label} revision ${revision.id} has an invalid time grade.`);
      assert(revision.uncertaintySeconds === null || (Number.isFinite(revision.uncertaintySeconds) && revision.uncertaintySeconds >= 0), `${label} revision ${revision.id} has invalid uncertainty.`);
      assert(Number.isFinite(revision.bytes) && revision.bytes >= 0, `${label} revision ${revision.id} has invalid byte size.`);
      assert(Number.isFinite(revision.lines) && revision.lines >= 0, `${label} revision ${revision.id} has invalid line count.`);
      assert(typeof revision.sha256 === "string" && revision.sha256.length > 0, `${label} revision ${revision.id} has no SHA-256.`);
      assert(revision.previousId === null || typeof revision.previousId === "string", `${label} revision ${revision.id} has an invalid predecessor.`);
      assert(Array.isArray(revision.hunks), `${label} revision ${revision.id} has no hunk array.`);
      revision.hunks.forEach((hunk) => {
        assert(isRecord(hunk), `${label} revision ${revision.id} has an invalid hunk.`);
        assert(["insert", "delete", "replace", "equal"].includes(hunk.op), `${label} revision ${revision.id} has an invalid hunk operation.`);
        for (const coordinate of ["a0", "a1", "b0", "b1"]) {
          assert(Number.isFinite(hunk[coordinate]) && hunk[coordinate] >= 0, `${label} revision ${revision.id} has an invalid hunk coordinate.`);
        }
      });
      validateStringArray(revision.tags, `${label} revision ${revision.id} tags`);
      assert(Number.isFinite(revision.sourceLine) && revision.sourceLine >= 0, `${label} revision ${revision.id} has an invalid source line.`);
    });

    const reuseIds = new Set();
    data.reuse.forEach((group, index) => {
      assert(isRecord(group), `${label} reuse group ${index + 1} is invalid.`);
      validateId(group.id, "G", `${label} reuse group ${index + 1}`);
      assert(!reuseIds.has(group.id), `${label} contains duplicate reuse ID ${group.id}.`);
      reuseIds.add(group.id);
      assert(typeof group.sha256 === "string" && group.sha256.length > 0, `${label} reuse group ${group.id} has no SHA-256.`);
      assert(Number.isFinite(group.bytes) && group.bytes >= 0, `${label} reuse group ${group.id} has invalid byte size.`);
      validateStringArray(group.revisionIds, `${label} reuse group ${group.id} revisions`);
      validateStringArray(group.pageIds, `${label} reuse group ${group.id} pages`);
      validateStringArray(group.handleIds, `${label} reuse group ${group.id} handles`);
    });

    assert(Number.isFinite(data.stats.events) && data.stats.events === data.events.length, `${label} event count does not match its event array.`);
    assert(Number.isFinite(data.stats.revisions) && data.stats.revisions === data.revisions.length, `${label} revision count does not match its revision array.`);

    for (const event of data.events) {
      if (event.revisionId) {
        assert(revisionIds.has(event.revisionId), `${label} event ${event.id} references a missing revision.`);
      }
      if (event.handleId) {
        assert(handleIds.has(event.handleId), `${label} event ${event.id} references a missing handle.`);
      }
    }
    for (const group of data.reuse) {
      group.revisionIds.forEach((id) => assert(revisionIds.has(id), `${label} reuse group ${group.id} references a missing revision.`));
    }
    return data;
  }

  function validatePrivateData(privateData, dataset) {
    assert(isRecord(privateData), "The local archive returned no private-data record.");
    for (const key of ["pageNames", "handleNames", "revisionBodies"]) {
      assert(isRecord(privateData[key]), `The local archive returned no ${key} map.`);
    }

    const knownPages = new Set(dataset.pages.map((page) => page.id));
    const knownHandles = new Set(dataset.handles.map((handle) => handle.id));
    const knownRevisions = new Set(dataset.revisions.map((revision) => revision.id));
    dataset.events.forEach((event) => {
      if (event.pageId) {
        knownPages.add(event.pageId);
      }
      if (event.handleId) {
        knownHandles.add(event.handleId);
      }
    });
    dataset.revisions.forEach((revision) => knownPages.add(revision.pageId));

    for (const [id, value] of Object.entries(privateData.pageNames)) {
      assert(knownPages.has(id), `The private page-name map contains unknown ID ${id}.`);
      assert(typeof value === "string", `The private page-name map contains a non-text value for ${id}.`);
    }
    for (const [id, value] of Object.entries(privateData.handleNames)) {
      assert(knownHandles.has(id), `The private handle-name map contains unknown ID ${id}.`);
      assert(typeof value === "string", `The private handle-name map contains a non-text value for ${id}.`);
    }
    for (const [id, value] of Object.entries(privateData.revisionBodies)) {
      assert(knownRevisions.has(id), `The private revision-body map contains unknown ID ${id}.`);
      assert(typeof value === "string", `The private revision-body map contains a non-text value for ${id}.`);
    }
    for (const id of knownRevisions) {
      assert(own(privateData.revisionBodies, id), `The private revision-body map is missing ${id}.`);
    }
  }

  function validateLocalResult(result) {
    assert(isRecord(result), "The archive loader returned no result.");
    validateDataset(result.data, "The imported archive projection");
    validatePrivateData(result.privateData, result.data);
    assert(isRecord(result.integrity), "The archive loader returned no integrity record.");
    const integrity = result.integrity;
    assert(typeof integrity.matchesReference === "boolean", "The archive integrity result has no reference-match state.");
    assert(typeof integrity.archiveSha256 === "string" && integrity.archiveSha256.length > 0, "The archive integrity result has no SHA-256.");
    assert(Number.isFinite(integrity.verifiedFiles) && integrity.verifiedFiles >= 0, "The archive integrity result has an invalid verified-file count.");
    assert(Number.isFinite(integrity.verifiedBodies) && integrity.verifiedBodies >= 0, "The archive integrity result has an invalid verified-body count.");
    assert(integrity.verifiedFiles >= result.data.source.files.length, `Archive validation is incomplete: ${integrity.verifiedFiles} of ${result.data.source.files.length} source files verified.`);
    assert(integrity.verifiedBodies >= result.data.revisions.length, `Archive validation is incomplete: ${integrity.verifiedBodies} of ${result.data.revisions.length} revision bodies verified.`);
    assert(integrity.archiveSha256.toLocaleLowerCase() === result.data.source.archiveSha256.toLocaleLowerCase(), "The archive SHA-256 does not match the imported projection.");
    assert(integrity.matchesReference === result.data.source.matchesReference, "The archive reference-match state conflicts with the imported projection.");
    return result;
  }

  function prepareDataset(dataset) {
    const pages = new Map(dataset.pages.map((record) => [record.id, record]));
    const handles = new Map(dataset.handles.map((record) => [record.id, record]));
    const revisions = new Map(dataset.revisions.map((record) => [record.id, record]));
    const events = new Map(dataset.events.map((record) => [record.id, record]));
    const rules = new Map(dataset.rules.map((record) => [record.id, record]));
    const reuse = new Map(dataset.reuse.map((record) => [record.id, record]));
    const eventMetadata = new Map();

    for (const event of dataset.events) {
      const parts = [
        event.id,
        event.type,
        event.time,
        event.wiki,
        event.pageId,
        event.handleId,
        event.revisionId,
        event.grade,
        event.relatedId,
        event.relationType,
        ...event.tags
      ];
      const page = event.pageId ? pages.get(event.pageId) : null;
      const handle = event.handleId ? handles.get(event.handleId) : null;
      const revision = event.revisionId ? revisions.get(event.revisionId) : null;
      if (page) {
        parts.push(page.wiki, ...page.tags);
      }
      if (handle) {
        parts.push(handle.kind, ...handle.wikis);
      }
      if (revision) {
        parts.push(revision.sha256, revision.previousId, ...revision.tags);
      }
      for (const tag of event.tags) {
        const rule = rules.get(tag);
        if (rule) {
          parts.push(rule.label, rule.description, ...rule.terms);
        }
      }
      eventMetadata.set(event.id, parts.filter((value) => value !== null && value !== undefined).join(" ").toLocaleLowerCase());
    }

    return { pages, handles, revisions, events, rules, reuse, eventMetadata };
  }

  function displayPageName(id) {
    if (!id) {
      return "Unattributed page";
    }
    if (state.privateData && own(state.privateData.pageNames, id)) {
      const original = state.privateData.pageNames[id];
      if (original.trim()) {
        return original;
      }
    }
    return `Page ${id}`;
  }

  function displayHandleName(id) {
    if (!id) {
      return "Unattributed";
    }
    if (state.privateData && own(state.privateData.handleNames, id)) {
      const original = state.privateData.handleNames[id];
      if (original.trim()) {
        return original;
      }
    }
    return `Handle ${id}`;
  }

  function getRevisionBody(id) {
    if (!state.privateData || !id || !own(state.privateData.revisionBodies, id)) {
      return null;
    }
    return state.privateData.revisionBodies[id];
  }

  function setAppStatus(message, tone = "") {
    refs.appStatus.hidden = false;
    refs.appStatus.dataset.tone = tone;
    refs.appStatus.replaceChildren(element("span", { text: message }));
  }

  function hideAppStatus() {
    refs.appStatus.hidden = true;
    refs.appStatus.dataset.tone = "";
  }

  function showToast(message, tone = "") {
    window.clearTimeout(state.toastTimer);
    refs.toast.textContent = message;
    refs.toast.dataset.tone = tone;
    refs.toast.hidden = false;
    state.toastTimer = window.setTimeout(() => {
      refs.toast.hidden = true;
      refs.toast.textContent = "";
      refs.toast.dataset.tone = "";
    }, 4200);
  }

  function errorMessage(error) {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return String(error || "Unknown error");
  }

  function updateThemeControl() {
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    refs.themeToggle.textContent = dark ? "Use light theme" : "Use dark theme";
    refs.themeToggle.setAttribute("aria-pressed", dark ? "true" : "false");
  }

  function toggleTheme() {
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    document.documentElement.setAttribute("data-theme", dark ? "light" : "dark");
    updateThemeControl();
  }

  function setImportBusy(busy) {
    state.importBusy = busy;
    refs.importArchive.disabled = busy;
    refs.archiveInput.disabled = busy;
    refs.unloadArchive.disabled = busy || state.mode !== "private";
    refs.exportSelection.disabled = busy || state.pins.size === 0;
  }

  function setImportMessage(message, tone = "") {
    state.importMessage = message;
    state.importTone = tone;
    refs.importStatus.textContent = message;
    refs.importStatus.dataset.tone = tone;
  }

  function populateSelect(select, allLabel, values, selectedValue) {
    const options = [element("option", {
      text: allLabel,
      attrs: { value: "all" }
    })];
    for (const value of values) {
      options.push(element("option", {
        text: value,
        attrs: { value }
      }));
    }
    select.replaceChildren(...options);
    select.value = values.includes(selectedValue) ? selectedValue : "all";
  }

  function populateFilters() {
    const types = EVENT_TYPES.filter((type) => state.dataset.events.some((event) => event.type === type));
    const wikis = [...new Set(state.dataset.events.map((event) => event.wiki).filter(Boolean))]
      .sort((a, b) => {
        if (a === "unattributed") {
          return 1;
        }
        if (b === "unattributed") {
          return -1;
        }
        return a.localeCompare(b);
      });
    const grades = [...new Set(state.dataset.events.map((event) => event.grade).filter(Boolean))].sort();
    populateSelect(refs.typeFilter, "All event types", types, state.filters.type);
    populateSelect(refs.wikiFilter, "All wikis", wikis, state.filters.wiki);
    populateSelect(refs.gradeFilter, "All time grades", grades, state.filters.grade);

    const minimum = datePart(state.dataset.stats.start);
    const maximum = datePart(state.dataset.stats.end);
    for (const input of [refs.dateFrom, refs.dateTo]) {
      if (minimum) {
        input.min = minimum;
      } else {
        input.removeAttribute("min");
      }
      if (maximum) {
        input.max = maximum;
      } else {
        input.removeAttribute("max");
      }
    }
  }

  function syncFilterControls() {
    refs.searchFilter.value = state.filters.search;
    refs.typeFilter.value = state.filters.type;
    refs.wikiFilter.value = state.filters.wiki;
    refs.gradeFilter.value = state.filters.grade;
    refs.dateFrom.value = state.filters.from;
    refs.dateTo.value = state.filters.to;
  }

  function clearInspector(restoreFocus = false) {
    if (refs.evidenceDialog.open) {
      refs.evidenceDialog.close();
    }
    refs.dialogBody.replaceChildren();
    if (restoreFocus && state.lastFocus instanceof HTMLElement && state.lastFocus.isConnected) {
      state.lastFocus.focus();
    }
    state.lastFocus = null;
  }

  function renderPrivacyState() {
    if (state.mode === "private") {
      refs.privacyMark.textContent = "L";
      refs.privacyTitle.textContent = "Private archive loaded locally";
      refs.privacyCopy.textContent = "Original page names, handle aliases, and revision text are available only in this browser tab. Nothing is uploaded, persisted, or added to exported selections.";
      if (state.integrity) {
        const reference = state.integrity.matchesReference ? "matches documented reference" : "does not match documented reference";
        refs.integrityLine.textContent = `archive sha256 ${state.integrity.archiveSha256} · ${formatNumber(state.integrity.verifiedFiles)} files · ${formatNumber(state.integrity.verifiedBodies)} bodies · ${reference}`;
      } else {
        refs.integrityLine.textContent = "";
      }
      refs.searchNote.textContent = "Local mode also searches original names and a bounded in-memory body scan.";
    } else {
      refs.privacyMark.textContent = "M";
      refs.privacyTitle.textContent = "Metadata-only view";
      refs.privacyCopy.textContent = "The bundled public projection contains pseudonymous IDs and no record bodies, original names, IP addresses, or recorded URLs.";
      refs.integrityLine.textContent = state.dataset ? `archive sha256 ${state.dataset.source.archiveSha256}` : "";
      refs.searchNote.textContent = "Public mode searches metadata only.";
    }
    refs.importStatus.textContent = state.importMessage;
    refs.importStatus.dataset.tone = state.importTone;
    refs.unloadArchive.disabled = state.importBusy || state.mode !== "private";
  }

  function resetPagination() {
    state.pagination = freshPagination();
  }

  function activateDataset(dataset, privateData, integrity, mode, prepared, message = "", tone = "") {
    state.dataset = dataset;
    state.privateData = privateData;
    state.integrity = integrity;
    state.mode = mode;
    state.prepared = prepared;
    state.filters = freshFilters();
    state.scope = null;
    state.pins.clear();
    state.searchContext = null;
    state.filterError = "";
    state.importMessage = message;
    state.importTone = tone;
    resetPagination();
    window.clearTimeout(state.searchTimer);
    refs.archiveInput.value = "";
    clearInspector(false);
    populateFilters();
    syncFilterControls();
    renderPrivacyState();
    applyFilters(false);
    renderPinnedControls();
    refs.appShell.setAttribute("aria-busy", "false");
    state.ready = true;
    hideAppStatus();
  }

  function buildSearchContext(query) {
    const normalized = normalizeSearch(query);
    const context = {
      query: normalized,
      pageIds: new Set(),
      handleIds: new Set(),
      revisionIds: new Set(),
      scannedCharacters: 0,
      bodyMatches: 0,
      truncated: false
    };
    if (!normalized || !state.privateData) {
      return context;
    }

    for (const [id, name] of Object.entries(state.privateData.pageNames)) {
      if (name.toLocaleLowerCase().includes(normalized)) {
        context.pageIds.add(id);
      }
    }
    for (const [id, name] of Object.entries(state.privateData.handleNames)) {
      if (name.toLocaleLowerCase().includes(normalized)) {
        context.handleIds.add(id);
      }
    }

    const entries = Object.entries(state.privateData.revisionBodies);
    let visited = 0;
    for (const [id, body] of entries) {
      if (context.scannedCharacters >= SEARCH_CHARACTER_LIMIT || context.bodyMatches >= SEARCH_MATCH_LIMIT) {
        context.truncated = visited < entries.length;
        break;
      }
      const allowance = Math.min(body.length, SEARCH_CHARACTER_LIMIT - context.scannedCharacters);
      const sample = body.slice(0, allowance);
      context.scannedCharacters += allowance;
      visited += 1;
      if (sample.toLocaleLowerCase().includes(normalized)) {
        context.revisionIds.add(id);
        context.bodyMatches += 1;
      }
      if (allowance < body.length) {
        context.truncated = true;
        break;
      }
    }
    if (visited < entries.length) {
      context.truncated = true;
    }
    return context;
  }

  function eventMatchesSearch(event, query, context) {
    if (!query) {
      return true;
    }
    const metadata = state.prepared.eventMetadata.get(event.id) || "";
    if (metadata.includes(query)) {
      return true;
    }
    if (event.pageId && context.pageIds.has(event.pageId)) {
      return true;
    }
    if (event.handleId && context.handleIds.has(event.handleId)) {
      return true;
    }
    return Boolean(event.revisionId && context.revisionIds.has(event.revisionId));
  }

  function eventMatchesScope(event) {
    if (!state.scope) {
      return true;
    }
    const ids = state.scope.ids;
    if (state.scope.type === "pages") {
      return Boolean(event.pageId && ids.has(event.pageId));
    }
    if (state.scope.type === "handles") {
      return Boolean(event.handleId && ids.has(event.handleId));
    }
    if (state.scope.type === "revisions") {
      return Boolean(event.revisionId && ids.has(event.revisionId));
    }
    if (state.scope.type === "events") {
      return ids.has(event.id);
    }
    return true;
  }

  function updateSearchNote() {
    if (!state.privateData) {
      refs.searchNote.textContent = state.filters.search ? "Searching public IDs, tags, wiki, grade, and revision hashes only." : "Public mode searches metadata only.";
      return;
    }
    if (!state.filters.search) {
      refs.searchNote.textContent = "Local mode also searches original names and a bounded in-memory body scan.";
      return;
    }
    const context = state.searchContext;
    if (!context) {
      refs.searchNote.textContent = "Preparing a bounded local full-text scan…";
      return;
    }
    const suffix = context.truncated ? " · scan limit reached" : " · complete within bound";
    refs.searchNote.textContent = `${formatNumber(context.scannedCharacters)} text characters scanned · ${formatNumber(context.bodyMatches)} body matches${suffix}`;
  }

  function renderScope() {
    if (!state.scope) {
      refs.scopeBox.hidden = true;
      refs.scopeCopy.textContent = "";
      return;
    }
    refs.scopeCopy.textContent = `Evidence scope: ${state.scope.label}`;
    refs.scopeBox.hidden = false;
  }

  function applyFilters(resetPages = true) {
    if (!state.dataset) {
      return;
    }
    const from = state.filters.from;
    const to = state.filters.to;
    refs.dateFrom.removeAttribute("aria-invalid");
    refs.dateTo.removeAttribute("aria-invalid");
    state.filterError = "";

    if (from && to && from > to) {
      state.filteredEvents = [];
      state.filterError = "Invalid UTC date range: From must not be after Through.";
      refs.dateFrom.setAttribute("aria-invalid", "true");
      refs.dateTo.setAttribute("aria-invalid", "true");
    } else {
      const query = normalizeSearch(state.filters.search);
      if (!state.searchContext || state.searchContext.query !== query) {
        state.searchContext = buildSearchContext(query);
      }
      state.filteredEvents = state.dataset.events.filter((event) => {
        if (state.filters.type !== "all" && event.type !== state.filters.type) {
          return false;
        }
        if (state.filters.wiki !== "all" && event.wiki !== state.filters.wiki) {
          return false;
        }
        if (state.filters.grade !== "all" && event.grade !== state.filters.grade) {
          return false;
        }
        const day = datePart(event.time);
        if (from && (!day || day < from)) {
          return false;
        }
        if (to && (!day || day > to)) {
          return false;
        }
        if (!eventMatchesScope(event)) {
          return false;
        }
        return eventMatchesSearch(event, query, state.searchContext);
      });
    }

    if (resetPages) {
      resetPagination();
    }
    refs.filterCount.textContent = state.filterError
      ? state.filterError
      : `${formatNumber(state.filteredEvents.length)} of ${formatNumber(state.dataset.events.length)} events in the current result.`;
    updateSearchNote();
    renderScope();
    renderPinnedControls();
    renderCurrentView();
  }

  function resetFilters() {
    state.filters = freshFilters();
    state.scope = null;
    state.searchContext = null;
    window.clearTimeout(state.searchTimer);
    syncFilterControls();
    applyFilters(true);
    refs.searchFilter.focus();
  }

  function setScope(type, ids, label) {
    state.scope = {
      type,
      ids: new Set(ids),
      label
    };
    applyFilters(true);
  }

  function clearScope() {
    state.scope = null;
    applyFilters(true);
  }

  function renderPinnedControls() {
    refs.openPins.textContent = `Pinned events: ${formatNumber(state.pins.size)}`;
    refs.openPins.disabled = state.pins.size === 0;
    refs.exportSelection.disabled = state.importBusy || state.pins.size === 0;
  }

  function togglePin(eventId, sourceButton = null) {
    if (state.pins.has(eventId)) {
      state.pins.delete(eventId);
      showToast(`${eventId} removed from the metadata selection.`);
    } else {
      state.pins.add(eventId);
      showToast(`${eventId} pinned for metadata-only export.`, "success");
    }
    renderPinnedControls();
    if (refs.evidenceDialog.open) {
      renderCurrentView();
    }
    if (sourceButton) {
      const pinned = state.pins.has(eventId);
      sourceButton.textContent = pinned ? "Unpin" : "Pin";
      sourceButton.setAttribute("aria-pressed", pinned ? "true" : "false");
    } else {
      renderCurrentView();
    }
  }

  function renderKpis() {
    const events = state.filteredEvents;
    const saves = events.reduce((sum, event) => sum + (event.type === "save" ? 1 : 0), 0);
    const pages = new Set(events.map((event) => event.pageId).filter(Boolean));
    const handles = new Set(events.map((event) => event.handleId).filter(Boolean));
    const dated = events.map((event) => event.time).filter(Boolean).sort();
    const span = dated.length ? `${formatDate(dated[0])} – ${formatDate(dated[dated.length - 1])}` : "No dated events";
    const items = [
      [formatNumber(events.length), "Filtered events"],
      [formatNumber(saves), "Save events"],
      [formatNumber(pages.size), "Observed pages"],
      [formatNumber(handles.size), "Observed handles"],
      [span, "UTC span"]
    ];
    refs.kpiGrid.replaceChildren(...items.map(([value, label]) => element("div", { className: "kpi" }, [
      element("p", { className: "kpi-value", text: value }),
      element("p", { className: "kpi-label", text: label })
    ])));
  }

  function updateViewChrome() {
    const meta = VIEW_META[state.view];
    refs.viewKicker.textContent = meta.kicker;
    refs.viewHeading.textContent = meta.title;
    refs.viewDescription.textContent = meta.description;
    refs.archiveStamp.textContent = state.dataset
      ? `generated ${formatDateTime(state.dataset.source.generatedAt)}\n${state.mode === "private" ? "private text in memory" : "public metadata projection"}`
      : "";
    const tabs = [...refs.viewTabs.querySelectorAll("[data-view]")];
    tabs.forEach((tab) => {
      const selected = tab.dataset.view === state.view;
      tab.setAttribute("aria-selected", selected ? "true" : "false");
      tab.tabIndex = selected ? 0 : -1;
    });
  }

  function renderCurrentView() {
    if (!state.dataset) {
      return;
    }
    updateViewChrome();
    renderKpis();
    refs.viewContent.replaceChildren();
    try {
      if (state.filterError) {
        refs.viewContent.append(emptyState("Fix the UTC date range", state.filterError, button("Reset filters", resetFilters, "button-primary")));
        return;
      }
      if (state.view === "activity") {
        renderActivity();
      } else if (state.view === "pages") {
        renderPages();
      } else if (state.view === "handles") {
        renderHandles();
      } else if (state.view === "overlap") {
        renderOverlap();
      } else if (state.view === "reuse") {
        renderReuse();
      } else {
        renderMethods();
      }
    } catch (error) {
      console.error(error);
      refs.viewContent.append(emptyState("This view could not be rendered", errorMessage(error)));
      showToast(`View error: ${errorMessage(error)}`, "error");
    }
  }

  function switchView(view, moveFocus = false) {
    if (!VIEW_META[view]) {
      return;
    }
    state.view = view;
    renderCurrentView();
    if (moveFocus) {
      refs.viewHeading.focus?.();
      refs.mainContent.focus();
    }
  }

  function paginate(items, key, size = PAGE_SIZE) {
    const totalPages = Math.max(1, Math.ceil(items.length / size));
    const page = Math.min(Math.max(1, state.pagination[key] || 1), totalPages);
    state.pagination[key] = page;
    const start = (page - 1) * size;
    return {
      items: items.slice(start, start + size),
      page,
      totalPages,
      start,
      end: Math.min(items.length, start + size),
      total: items.length
    };
  }

  function paginator(result, key) {
    const previous = button("Previous", () => {
      state.pagination[key] = Math.max(1, result.page - 1);
      renderCurrentView();
      refs.viewHeading.scrollIntoView({ block: "start" });
    }, "button-small", { disabled: result.page <= 1 ? "disabled" : null });
    previous.disabled = result.page <= 1;
    const next = button("Next", () => {
      state.pagination[key] = Math.min(result.totalPages, result.page + 1);
      renderCurrentView();
      refs.viewHeading.scrollIntoView({ block: "start" });
    }, "button-small", { disabled: result.page >= result.totalPages ? "disabled" : null });
    next.disabled = result.page >= result.totalPages;
    const visibleStart = result.total ? result.start + 1 : 0;
    return element("nav", {
      className: "pagination",
      attrs: { "aria-label": "Table pages" }
    }, [
      previous,
      element("span", {
        className: "pagination-status",
        text: `Page ${formatNumber(result.page)} of ${formatNumber(result.totalPages)} · ${formatNumber(visibleStart)}–${formatNumber(result.end)} of ${formatNumber(result.total)}`
      }),
      next
    ]);
  }

  function buildTimelineBuckets() {
    const counts = new Map();
    for (const event of state.filteredEvents) {
      const day = datePart(event.time);
      if (!day) {
        continue;
      }
      if (!counts.has(day)) {
        counts.set(day, { day, save: 0, delete: 0, revert: 0, probe: 0, total: 0 });
      }
      const row = counts.get(day);
      row[event.type] += 1;
      row.total += 1;
    }

    let days = [...new Set(state.dataset.daily.map((row) => row.day))].sort();
    if (!days.length) {
      days = [...new Set(state.dataset.events.map((event) => datePart(event.time)).filter(Boolean))].sort();
    }
    if (state.filters.from) {
      days = days.filter((day) => day >= state.filters.from);
    }
    if (state.filters.to) {
      days = days.filter((day) => day <= state.filters.to);
    }
    if (!days.length && counts.size) {
      days = [...counts.keys()].sort();
    }

    const bucketWidth = Math.max(1, Math.ceil(days.length / 64));
    const buckets = [];
    for (let index = 0; index < days.length; index += bucketWidth) {
      const bucketDays = days.slice(index, index + bucketWidth);
      const bucket = {
        start: bucketDays[0],
        end: bucketDays[bucketDays.length - 1],
        save: 0,
        delete: 0,
        revert: 0,
        probe: 0,
        total: 0
      };
      for (const day of bucketDays) {
        const row = counts.get(day);
        if (!row) {
          continue;
        }
        for (const type of EVENT_TYPES) {
          bucket[type] += row[type];
        }
        bucket.total += row.total;
      }
      buckets.push(bucket);
    }
    return { buckets, bucketWidth };
  }

  function renderTimeline() {
    const { buckets, bucketWidth } = buildTimelineBuckets();
    if (!buckets.length) {
      return emptyState("No dated events in this result", "Events without a usable UTC timestamp remain in the table but cannot be placed on the timeline.");
    }
    const maximum = Math.max(1, ...buckets.map((bucket) => bucket.total));
    const timeline = element("div", {
      className: "timeline",
      attrs: { role: "group", "aria-label": "UTC activity timeline" }
    });
    const controls = [];

    buckets.forEach((bucket) => {
      const label = bucket.start === bucket.end ? bucket.start : `${bucket.start} through ${bucket.end}`;
      const control = element("button", {
        className: "timeline-unit",
        attrs: { type: "button" }
      });
      const bar = element("span", { className: "timeline-bar" });
      const height = bucket.total ? Math.max(2, (bucket.total / maximum) * 100) : 1;
      bar.style.height = `${height}%`;
      for (const type of EVENT_TYPES) {
        if (!bucket[type] || !bucket.total) {
          continue;
        }
        const segment = element("span", {
          className: "timeline-segment",
          dataset: { type }
        });
        segment.style.height = `${(bucket[type] / bucket.total) * 100}%`;
        bar.append(segment);
      }
      control.append(bar);
      control.append(element("span", {
        className: "visually-hidden",
        text: `${label}: ${formatNumber(bucket.total)} events; ${formatNumber(bucket.save)} saves, ${formatNumber(bucket.delete)} deletes, ${formatNumber(bucket.revert)} reverts, ${formatNumber(bucket.probe)} probes. Filter to this UTC range.`
      }));
      control.addEventListener("click", () => {
        state.filters.from = bucket.start;
        state.filters.to = bucket.end;
        syncFilterControls();
        applyFilters(true);
        showToast(`UTC range set to ${label}.`, "success");
      });
      control.addEventListener("keydown", (event) => {
        const index = controls.indexOf(control);
        if (event.key === "ArrowRight" && controls[index + 1]) {
          event.preventDefault();
          controls[index + 1].focus();
        } else if (event.key === "ArrowLeft" && controls[index - 1]) {
          event.preventDefault();
          controls[index - 1].focus();
        } else if (event.key === "Home" && controls[0]) {
          event.preventDefault();
          controls[0].focus();
        } else if (event.key === "End" && controls[controls.length - 1]) {
          event.preventDefault();
          controls[controls.length - 1].focus();
        }
      });
      controls.push(control);
      timeline.append(control);
    });

    const content = element("div", {}, [
      timeline,
      element("div", { className: "timeline-axis" }, [
        element("span", { text: buckets[0].start }),
        element("span", { text: buckets[buckets.length - 1].end })
      ]),
      element("p", {
        className: "section-note",
        text: bucketWidth === 1
          ? "Each bar is one UTC day. Activate a bar to filter to that day."
          : `Each bar groups up to ${formatNumber(bucketWidth)} UTC days. Activate a bar to filter to its range.`
      })
    ]);
    return content;
  }

  function eventTypeBadge(event) {
    return badge(event.type, "type", event.type);
  }

  function eventActions(event) {
    const actions = element("div", { className: "row-actions" });
    actions.append(button("Inspect", () => openEvent(event.id), "button-small"));
    const pin = button(state.pins.has(event.id) ? "Unpin" : "Pin", () => togglePin(event.id, pin), "button-small", {
      "aria-pressed": state.pins.has(event.id) ? "true" : "false"
    });
    actions.append(pin);
    return actions;
  }

  function eventRows(events) {
    return events.map((event) => {
      const page = event.pageId
        ? nameCell(displayPageName(event.pageId), event.pageId, () => openPage(event.pageId))
        : nameCell(event.type === "probe" ? "No page attribution" : "Unattributed", "");
      const handle = event.handleId
        ? nameCell(displayHandleName(event.handleId), event.handleId, () => openHandle(event.handleId))
        : nameCell("Unattributed", "");
      return [
        nameCell(event.id, event.relationType || ""),
        timeCell(event.time),
        eventTypeBadge(event),
        nameCell(event.wiki || "unattributed", event.grade),
        page,
        handle,
        eventActions(event)
      ];
    });
  }

  function renderActivity() {
    const timelineHeader = element("div", { className: "section-heading-row" }, [
      element("div", {}, [
        element("h3", { text: "UTC activity profile" }),
        element("p", { className: "card-subtitle", text: "Bar height shows filtered event volume; color segments show event types." })
      ]),
      element("div", { className: "legend", attrs: { "aria-label": "Timeline legend" } },
        EVENT_TYPES.map((type) => element("span", { className: "legend-item" }, [
          element("span", { className: "legend-swatch", dataset: { type }, attrs: { "aria-hidden": "true" } }),
          element("span", { text: type })
        ]))
      )
    ]);
    refs.viewContent.append(element("section", { className: "card" }, [
      timelineHeader,
      renderTimeline()
    ]));

    if (!state.filteredEvents.length) {
      refs.viewContent.append(card("Event record", "No events satisfy the current evidence bounds.", emptyState(
        "No matching events",
        "Broaden the metadata search or reset one or more filters. A successful empty result is not an import error.",
        button("Reset filters", resetFilters, "button-primary")
      )));
      return;
    }

    const result = paginate(state.filteredEvents, "activity");
    const table = makeTable([
      { label: "Event" },
      { label: "UTC time" },
      { label: "Type" },
      { label: "Wiki / grade" },
      { label: "Page" },
      { label: "Handle" },
      { label: "Evidence" }
    ], eventRows(result.items));
    refs.viewContent.append(card(
      "Event record",
      `${formatNumber(state.filteredEvents.length)} filtered events; tables are bounded to ${formatNumber(PAGE_SIZE)} rows per page.`,
      element("div", { className: "table-wrap" }, [table, paginator(result, "activity")])
    ));
  }

  function derivePages() {
    const summaries = new Map();
    for (const event of state.filteredEvents) {
      if (!event.pageId) {
        continue;
      }
      if (!summaries.has(event.pageId)) {
        summaries.set(event.pageId, {
          id: event.pageId,
          events: 0,
          saves: 0,
          deletes: 0,
          handles: new Set(),
          first: event.time,
          last: event.time
        });
      }
      const summary = summaries.get(event.pageId);
      summary.events += 1;
      summary.saves += event.type === "save" ? 1 : 0;
      summary.deletes += event.type === "delete" ? 1 : 0;
      if (event.handleId) {
        summary.handles.add(event.handleId);
      }
      if (event.time && (!summary.first || event.time < summary.first)) {
        summary.first = event.time;
      }
      if (event.time && (!summary.last || event.time > summary.last)) {
        summary.last = event.time;
      }
    }
    return [...summaries.values()].sort((a, b) => b.events - a.events || a.id.localeCompare(b.id));
  }

  function renderPages() {
    const pages = derivePages();
    if (!pages.length) {
      refs.viewContent.append(emptyState(
        "No pages in this result",
        "Probe events have no page attribution, and the current filters may exclude all page-bearing events.",
        button("Reset filters", resetFilters, "button-primary")
      ));
      return;
    }
    const result = paginate(pages, "pages");
    const rows = result.items.map((summary) => {
      const page = state.prepared.pages.get(summary.id);
      const availability = page
        ? badge(page.held ? "Held page" : "Referenced only")
        : badge("No held-page row");
      const actions = element("div", { className: "row-actions" }, [
        button("Inspect", () => openPage(summary.id), "button-small"),
        button("Filter activity", () => {
          setScope("pages", [summary.id], `page ${summary.id}`);
          switchView("activity", true);
        }, "button-small")
      ]);
      return [
        nameCell(displayPageName(summary.id), summary.id, () => openPage(summary.id)),
        stackedCell(page ? page.wiki : "Not recorded", availability),
        page ? formatNumber(page.revisions) : "Unavailable",
        formatNumber(summary.events),
        formatNumber(summary.handles.size),
        nameCell(formatDate(summary.first), formatDate(summary.last)),
        actions
      ];
    });
    const table = makeTable([
      { label: "Page" },
      { label: "Wiki / availability" },
      { label: "All revisions" },
      { label: "Filtered events" },
      { label: "Filtered handles" },
      { label: "First / last UTC" },
      { label: "Evidence" }
    ], rows);
    refs.viewContent.append(card(
      "Pages represented by filtered events",
      "A missing held-page row means the projection cannot supply held-page metadata; it does not establish what the page contained.",
      element("div", { className: "table-wrap" }, [table, paginator(result, "pages")])
    ));
  }

  function deriveHandles() {
    const summaries = new Map();
    for (const event of state.filteredEvents) {
      const key = event.handleId || "__unattributed__";
      if (!summaries.has(key)) {
        summaries.set(key, {
          id: event.handleId,
          events: 0,
          saves: 0,
          pages: new Set(),
          wikis: new Set(),
          eventIds: new Set(),
          first: event.time,
          last: event.time
        });
      }
      const summary = summaries.get(key);
      summary.events += 1;
      summary.saves += event.type === "save" ? 1 : 0;
      summary.eventIds.add(event.id);
      if (event.pageId) {
        summary.pages.add(event.pageId);
      }
      if (event.wiki) {
        summary.wikis.add(event.wiki);
      }
      if (event.time && (!summary.first || event.time < summary.first)) {
        summary.first = event.time;
      }
      if (event.time && (!summary.last || event.time > summary.last)) {
        summary.last = event.time;
      }
    }
    return [...summaries.values()].sort((a, b) => b.events - a.events || asText(a.id, "").localeCompare(asText(b.id, "")));
  }

  function renderHandles() {
    const handles = deriveHandles();
    if (!handles.length) {
      refs.viewContent.append(emptyState(
        "No handles in this result",
        "The current filter set contains no handle-bearing or unattributed events.",
        button("Reset filters", resetFilters, "button-primary")
      ));
      return;
    }
    const result = paginate(handles, "handles");
    const rows = result.items.map((summary) => {
      const handle = summary.id ? state.prepared.handles.get(summary.id) : null;
      const kind = handle ? handle.kind : "unattributed";
      const actions = element("div", { className: "row-actions" }, [
        summary.id ? button("Inspect", () => openHandle(summary.id), "button-small") : null,
        button("Filter activity", () => {
          setScope("events", summary.eventIds, summary.id ? `events attributed to ${summary.id}` : "unattributed events");
          switchView("activity", true);
        }, "button-small")
      ]);
      return [
        nameCell(displayHandleName(summary.id), summary.id || "", summary.id ? () => openHandle(summary.id) : null),
        badge(kind, "kind", kind),
        formatNumber(summary.events),
        formatNumber(summary.saves),
        formatNumber(summary.pages.size),
        [...summary.wikis].sort().join(", ") || "Not recorded",
        actions
      ];
    });
    const table = makeTable([
      { label: "Handle" },
      { label: "Kind" },
      { label: "Filtered events" },
      { label: "Filtered saves" },
      { label: "Filtered pages" },
      { label: "Wikis" },
      { label: "Evidence" }
    ], rows);
    refs.viewContent.append(card(
      "Handles represented by filtered events",
      "Aliases are unverified labels. Human and unattributed records remain visible here but are excluded from the agent-like overlap graph.",
      element("div", { className: "table-wrap" }, [table, paginator(result, "handles")])
    ));
  }

  function buildOverlap() {
    const handlePages = new Map();
    for (const event of state.filteredEvents) {
      if (event.type !== "save" || !event.handleId || !event.pageId) {
        continue;
      }
      const handle = state.prepared.handles.get(event.handleId);
      if (!handle || handle.kind !== "unverified") {
        continue;
      }
      if (!handlePages.has(event.handleId)) {
        handlePages.set(event.handleId, {
          id: event.handleId,
          pages: new Set(),
          saves: 0
        });
      }
      const record = handlePages.get(event.handleId);
      record.pages.add(event.pageId);
      record.saves += 1;
    }

    const allNodes = [...handlePages.values()].sort((a, b) => b.pages.size - a.pages.size || b.saves - a.saves || a.id.localeCompare(b.id));
    const nodes = allNodes.slice(0, NODE_LIMIT);
    const edges = [];
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
        const left = nodes[leftIndex];
        const right = nodes[rightIndex];
        const smaller = left.pages.size <= right.pages.size ? left.pages : right.pages;
        const larger = smaller === left.pages ? right.pages : left.pages;
        const sharedPages = [...smaller].filter((pageId) => larger.has(pageId)).sort();
        if (sharedPages.length) {
          edges.push({
            left: left.id,
            right: right.id,
            sharedPages,
            weight: sharedPages.length
          });
        }
      }
    }
    edges.sort((a, b) => b.weight - a.weight || a.left.localeCompare(b.left) || a.right.localeCompare(b.right));
    return {
      nodes,
      edges: edges.slice(0, EDGE_LIMIT),
      eligibleCount: allNodes.length,
      uncappedEdgeCount: edges.length
    };
  }

  function keyboardActivate(node, handler) {
    node.addEventListener("click", handler);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handler();
      }
    });
  }

  function renderOverlapGraph(overlap) {
    const width = 960;
    const height = 620;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = 235;
    const positions = new Map();
    overlap.nodes.forEach((node, index) => {
      const angle = -Math.PI / 2 + (index / Math.max(1, overlap.nodes.length)) * Math.PI * 2;
      positions.set(node.id, {
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius
      });
    });

    const svg = svgElement("svg", {
      class: "overlap-graph",
      viewBox: `0 0 ${width} ${height}`,
      role: "group",
      "aria-labelledby": "overlap-graph-title overlap-graph-description"
    });
    const title = svgElement("title", { id: "overlap-graph-title" });
    title.textContent = "Shared-page overlap among unverified aliases";
    const description = svgElement("desc", { id: "overlap-graph-description" });
    description.textContent = "Weighted edges indicate numbers of shared pages among the top filtered save-event aliases. This is not a communication graph.";
    svg.append(title, description);

    overlap.edges.forEach((edge, index) => {
      const left = positions.get(edge.left);
      const right = positions.get(edge.right);
      const group = svgElement("g", {
        class: "graph-edge-control",
        role: "button",
        tabindex: "0",
        "aria-labelledby": `edge-title-${index}`
      });
      const edgeTitle = svgElement("title", { id: `edge-title-${index}` });
      edgeTitle.textContent = `${edge.left} and ${edge.right}: ${formatNumber(edge.weight)} shared pages. Inspect overlap evidence.`;
      const hit = svgElement("line", {
        class: "graph-hit",
        x1: left.x,
        y1: left.y,
        x2: right.x,
        y2: right.y,
        "stroke-width": "18"
      });
      const line = svgElement("line", {
        class: "graph-edge",
        x1: left.x,
        y1: left.y,
        x2: right.x,
        y2: right.y,
        "stroke-width": Math.min(9, 1 + Math.sqrt(edge.weight) * 1.35)
      });
      group.append(edgeTitle, hit, line);
      keyboardActivate(group, () => openOverlapEdge(edge));
      svg.append(group);
    });

    const maximumPages = Math.max(1, ...overlap.nodes.map((node) => node.pages.size));
    overlap.nodes.forEach((node, index) => {
      const position = positions.get(node.id);
      const nodeRadius = 10 + Math.sqrt(node.pages.size / maximumPages) * 10;
      const angle = -Math.PI / 2 + (index / Math.max(1, overlap.nodes.length)) * Math.PI * 2;
      const horizontal = Math.cos(angle);
      const group = svgElement("g", {
        class: "graph-node-control",
        role: "button",
        tabindex: "0",
        "aria-labelledby": `node-title-${index}`
      });
      const nodeTitle = svgElement("title", { id: `node-title-${index}` });
      nodeTitle.textContent = `${displayHandleName(node.id)}, ${node.id}: ${formatNumber(node.pages.size)} pages and ${formatNumber(node.saves)} filtered saves. Inspect handle evidence.`;
      const circle = svgElement("circle", {
        class: "graph-node",
        cx: position.x,
        cy: position.y,
        r: nodeRadius
      });
      const label = svgElement("text", {
        class: "graph-label",
        x: centerX + horizontal * (radius + 42),
        y: centerY + Math.sin(angle) * (radius + 42) + 4,
        "text-anchor": Math.abs(horizontal) < 0.1 ? "middle" : horizontal < 0 ? "end" : "start"
      });
      label.textContent = node.id;
      group.append(nodeTitle, circle, label);
      keyboardActivate(group, () => openHandle(node.id));
      svg.append(group);
    });
    return svg;
  }

  function renderOverlap() {
    const overlap = buildOverlap();
    const note = `Graph scope: ${formatNumber(overlap.nodes.length)} of ${formatNumber(overlap.eligibleCount)} eligible unverified aliases, ranked by distinct filtered pages and then save count; ${formatNumber(overlap.edges.length)} of ${formatNumber(overlap.uncappedEdgeCount)} weighted edges, capped at ${formatNumber(EDGE_LIMIT)}. Compact displays use the edge table below. Human and unattributed handles are excluded.`;
    if (overlap.nodes.length < 2) {
      refs.viewContent.append(emptyState(
        "Not enough eligible aliases",
        "The overlap view needs at least two unverified, nonhuman named handles with filtered save events on attributed pages."
      ));
      return;
    }

    const graphContent = overlap.edges.length
      ? element("div", {}, [
        element("div", { className: "graph-shell" }, [renderOverlapGraph(overlap)]),
        element("p", { className: "section-note", text: "Edge weight is the count of shared page IDs. Activate an edge to inspect its page evidence." })
      ])
      : emptyState("No shared pages among eligible aliases", "The top eligible aliases have filtered save events, but no pair shares a page in the current result.");
    refs.viewContent.append(card(
      "Shared-page overlap—not communication",
      note,
      graphContent
    ));

    if (!overlap.edges.length) {
      return;
    }
    const result = paginate(overlap.edges, "overlap", 50);
    const rows = result.items.map((edge) => [
      nameCell(displayHandleName(edge.left), edge.left, () => openHandle(edge.left)),
      nameCell(displayHandleName(edge.right), edge.right, () => openHandle(edge.right)),
      formatNumber(edge.weight),
      element("div", { className: "row-actions" }, [
        button("Inspect shared pages", () => openOverlapEdge(edge), "button-small"),
        button("Filter activity", () => {
          setScope("pages", edge.sharedPages, `${formatNumber(edge.weight)} shared pages for ${edge.left} + ${edge.right}`);
          switchView("activity", true);
        }, "button-small")
      ])
    ]);
    const table = makeTable([
      { label: "Alias A" },
      { label: "Alias B" },
      { label: "Shared pages" },
      { label: "Evidence" }
    ], rows);
    refs.viewContent.append(card(
      "Bounded overlap edge list",
      "The table is the accessible evidence companion to the graph.",
      element("div", { className: "table-wrap" }, [table, paginator(result, "overlap")])
    ));
  }

  function filteredReuseGroups() {
    const revisionIds = new Set(state.filteredEvents.map((event) => event.revisionId).filter(Boolean));
    return state.dataset.reuse
      .filter((group) => group.revisionIds.some((id) => revisionIds.has(id)))
      .sort((a, b) => b.revisionIds.length - a.revisionIds.length || b.bytes - a.bytes || a.id.localeCompare(b.id));
  }

  function renderReuse() {
    const groups = filteredReuseGroups();
    if (!groups.length) {
      refs.viewContent.append(emptyState(
        "No repeated snapshots in this result",
        "No dataset reuse group intersects a revision-bearing event under the current evidence bounds. Broaden the filters to inspect other groups.",
        button("Reset filters", resetFilters, "button-primary")
      ));
      return;
    }
    const result = paginate(groups, "reuse", 50);
    const rows = result.items.map((group) => [
      nameCell(group.id, truncate(group.sha256, 18)),
      formatBytes(group.bytes),
      formatNumber(group.revisionIds.length),
      formatNumber(group.pageIds.length),
      formatNumber(group.handleIds.length),
      element("div", { className: "row-actions" }, [
        button("Inspect revisions", () => openReuseGroup(group.id), "button-small"),
        button("Filter activity", () => {
          setScope("revisions", group.revisionIds, `revisions in reuse group ${group.id}`);
          switchView("activity", true);
        }, "button-small")
      ])
    ]);
    const table = makeTable([
      { label: "Group / SHA" },
      { label: "Snapshot size" },
      { label: "Revisions" },
      { label: "Pages" },
      { label: "Handles" },
      { label: "Evidence" }
    ], rows);
    refs.viewContent.append(card(
      "Identical revision snapshot groups",
      "The dataset includes groups at least 160 bytes long that span at least two distinct unverified nonhuman handles. Equal SHA-256 bytes do not establish who copied what, whether communication occurred, or why the text recurred.",
      element("div", { className: "table-wrap" }, [table, paginator(result, "reuse")])
    ));
  }

  function statRows(entries) {
    const list = element("dl", { className: "stat-list" });
    for (const [label, value] of entries) {
      list.append(element("div", { className: "stat-row" }, [
        element("dt", { text: label }),
        element("dd", { text: value })
      ]));
    }
    return list;
  }

  function staticCitation(url, label) {
    return element("a", {
      text: label,
      attrs: {
        href: url,
        target: "_blank",
        rel: "noreferrer"
      }
    });
  }

  function renderMethods() {
    const source = state.dataset.source;
    const stats = state.dataset.stats;
    const sourceBlock = element("section", { className: "method-block" }, [
      element("h3", { text: "Source boundary" }),
      element("p", { text: "This interface credits the documented source but does not construct or follow mutable URLs recorded in historical log data." }),
      statRows([
        ["Source title", source.title],
        ["Projection generated", formatDateTime(source.generatedAt)],
        ["Archive SHA-256", source.archiveSha256],
        ["Reference match", source.matchesReference ? "Yes" : "No"],
        ["Projection privacy", source.privacy],
        ["Documented cut", `${source.cut.field} ${source.cut.operator} ${source.cut.value}`]
      ]),
      element("p", {}, [
        staticCitation("https://collusion.wiki", "Source documentation"),
        document.createTextNode(" · "),
        staticCitation("https://collusion.wiki/explorer/download.html", "Documented export page")
      ])
    ]);

    const interpretationBlock = element("section", { className: "method-block" }, [
      element("h3", { text: "Interpretation guardrails" }),
      element("ul", {}, [
        element("li", { text: "Revisions are full page snapshots, not individual messages." }),
        element("li", { text: "Handles are unverified aliases, not authenticated agents, people, or evidence of provider identity." }),
        element("li", { text: "Shared-page overlap and repeated bytes are observations, not proof of communication, collusion, motive, or causality." }),
        element("li", { text: "Human and unattributed handles are excluded from the agent-like overlap graph." }),
        element("li", { text: "Probe records are retained in the event stream with wiki='unattributed' and no page attribution." }),
        element("li", { text: "A false successObserved value means success was not observed; it does not prove failure." }),
        element("li", { text: "Body line counts and hunk coordinates use literal text.split('\\n'), including a trailing empty line." }),
        element("li", { text: "Reuse groups are precomputed for snapshots of at least 160 bytes spanning at least two distinct unverified nonhuman handles." }),
        element("li", { text: "A partial or non-reference archive cannot establish unseen behavior or provider identity." })
      ])
    ]);

    const statsBlock = element("section", { className: "method-block" }, [
      element("h3", { text: "Dataset inventory" }),
      statRows([
        ["Events", formatNumber(stats.events)],
        ["Revisions", formatNumber(stats.revisions)],
        ["Held pages", formatNumber(stats.heldPages)],
        ["Referenced pages", formatNumber(stats.referencedPages)],
        ["Handles", formatNumber(stats.handles)],
        ["Published handles", formatNumber(stats.publishedHandles)],
        ["Named handles", formatNumber(stats.namedHandles)],
        ["Human handles", formatNumber(stats.humanHandles)],
        ["Unattributed events", formatNumber(stats.unattributedEvents)],
        ["Unheld events", formatNumber(stats.unheldEvents)],
        ["Repeated-text groups", formatNumber(stats.reusedTextGroups)],
        ["Observed UTC range", `${formatDateTime(stats.start)} – ${formatDateTime(stats.end)}`]
      ])
    ]);

    const timeBlock = element("section", { className: "method-block" }, [
      element("h3", { text: "Timestamp grades" }),
      element("p", { text: "Time-grade filters preserve source distinctions. Uncertainty is displayed when present; this interface does not silently promote an inferred timestamp into an exact one." }),
      statRows(Object.entries(stats.grades || {}).map(([grade, count]) => [grade, formatNumber(count)]))
    ]);

    refs.viewContent.append(element("div", { className: "method-grid" }, [
      sourceBlock,
      interpretationBlock,
      statsBlock,
      timeBlock
    ]));

    const fileRows = source.files.map((file) => [
      file.name,
      formatNumber(file.rows),
      element("span", { className: "mono", text: file.sha256 })
    ]);
    refs.viewContent.append(card(
      "Verified expanded-file manifest",
      "File names, row counts, and SHA-256 values come from the projection manifest. Event source lines refer to events.jsonl; revision source lines refer to revisions.jsonl.",
      element("div", { className: "table-wrap" }, [
        makeTable([
          { label: "Expanded file" },
          { label: "Rows" },
          { label: "SHA-256" }
        ], fileRows)
      ])
    ));

    const ruleList = element("div", { className: "rule-list" });
    for (const rule of state.dataset.rules) {
      ruleList.append(element("article", { className: "rule-card" }, [
        element("h4", { text: rule.label }),
        element("p", { className: "mono", text: rule.id }),
        element("p", { text: rule.description }),
        element("div", { className: "term-list" },
          rule.terms.map((term) => badge(term))
        )
      ]));
    }
    refs.viewContent.append(card(
      "Keyword mention lenses",
      "Rules mark literal term mentions supplied by the dataset. They are retrieval lenses, not classifications of intent.",
      ruleList
    ));

    refs.viewContent.append(card(
      "Privacy projection and local inspection",
      "The public bundle is metadata-only. A private archive import is parsed and verified in browser memory; original names and text are never merged into the public dataset, uploaded, placed in the URL, persisted in storage, or included in metadata exports.",
      notice(state.mode === "private"
        ? "Private archive material is currently loaded in this tab. Use “Unload private archive” to close the inspector, clear filters and pins, release local names and bodies, and restore the bundled public projection."
        : "No private archive material is loaded. Revision inspectors explain how to import the documented archive locally when full text is needed.")
    ));
  }

  function ruleEvidence(tags) {
    if (!tags || !tags.length) {
      return notice("No keyword-lens tag is attached to this record.");
    }
    const list = element("div", { className: "rule-list" });
    for (const tag of tags) {
      const rule = state.prepared.rules.get(tag);
      list.append(element("article", { className: "rule-card" }, [
        element("h4", { text: rule ? rule.label : tag }),
        element("p", { className: "mono", text: tag }),
        element("p", { text: rule ? rule.description : "No rule description is present in this projection." }),
        rule ? element("div", { className: "term-list" }, rule.terms.map((term) => badge(term))) : null
      ]));
    }
    return list;
  }

  function presentInspector(kicker, title, children) {
    const alreadyOpen = refs.evidenceDialog.open;
    if (!alreadyOpen) {
      state.lastFocus = document.activeElement;
    }
    refs.dialogKicker.textContent = kicker;
    refs.dialogTitle.textContent = title;
    refs.dialogBody.replaceChildren(...(Array.isArray(children) ? children : [children]));
    if (!alreadyOpen) {
      refs.evidenceDialog.showModal();
    }
    refs.closeDialog.focus();
  }

  function sourceEvidence(record, kind) {
    const filename = kind === "event" ? "events.jsonl" : "revisions.jsonl";
    const rows = [
      ["Record kind", kind],
      ["Source record", Number.isFinite(record.sourceLine) ? `${filename}:${record.sourceLine}` : "Not recorded"],
      ["Archive SHA-256", state.dataset.source.archiveSha256]
    ];
    if (record.sha256) {
      rows.splice(2, 0, ["Revision SHA-256", record.sha256]);
    }
    return element("div", {}, [
      evidenceList(rows),
      element("p", {
        className: "section-note",
        text: "Source-line numbers refer to the matching JSONL member in the supplied archive. The archive and file fingerprints are available in Methods."
      })
    ]);
  }

  function openEvent(eventId) {
    const event = state.prepared.events.get(eventId);
    if (!event) {
      showToast(`Event ${eventId} is not present in the active projection.`, "error");
      return;
    }
    const page = event.pageId ? state.prepared.pages.get(event.pageId) : null;
    const handle = event.handleId ? state.prepared.handles.get(event.handleId) : null;
    const entries = [
      ["Event ID", event.id],
      ["Type", event.type],
      ["UTC time", formatDateTime(event.time)],
      ["Time grade", event.grade],
      ["Declared uncertainty", event.uncertaintySeconds === null ? "Not recorded" : `${formatNumber(event.uncertaintySeconds)} seconds`],
      ["Wiki", event.wiki || "unattributed"],
      ["Page", event.pageId ? `${displayPageName(event.pageId)} · ${event.pageId}` : event.type === "probe" ? "No page attribution" : "Unattributed"],
      ["Handle", event.handleId ? `${displayHandleName(event.handleId)} · ${event.handleId}` : "Unattributed"],
      ["Handle kind", handle ? handle.kind : "Not attributed"],
      ["Revision", event.revisionId || "None"],
      ["Success observation", event.successObserved === null
        ? "Not recorded"
        : event.successObserved
          ? "Success observed"
          : "Success not observed (not proof of failure)"],
      ["Relation", event.relatedId ? `${event.relationType || "related"} · ${event.relatedId}` : "None"]
    ];
    const actions = element("div", { className: "dialog-actions" });
    const pin = button(state.pins.has(event.id) ? "Unpin event" : "Pin event", () => togglePin(event.id, pin), "button-primary", {
      "aria-pressed": state.pins.has(event.id) ? "true" : "false"
    });
    actions.append(pin);
    if (event.revisionId) {
      actions.append(button("Inspect revision", () => openRevision(event.revisionId), "button-quiet"));
    }
    if (event.pageId) {
      actions.append(button("Inspect page", () => openPage(event.pageId), "button-quiet"));
    }
    if (event.handleId) {
      actions.append(button("Inspect handle", () => openHandle(event.handleId), "button-quiet"));
    }
    if (event.relatedId && state.prepared.events.has(event.relatedId)) {
      actions.append(button("Inspect related event", () => openEvent(event.relatedId), "button-quiet"));
    }

    const children = [
      notice(state.privateData
        ? "Private names and revision text shown by this inspector remain in this browser tab only."
        : "Metadata-only view: full revision text and original names require a complete local archive import."),
      event.type === "probe"
        ? notice("This probe is retained in the event stream with the wiki='unattributed' sentinel and no page attribution. The interface does not infer either field.", "warning")
        : null,
      dialogSection("Event metadata", evidenceList(entries)),
      (page && page.held) || !event.pageId
        ? null
        : notice("This event references an unheld page. Only event-derived metadata is available; its missing content is not reconstructed.", "warning"),
      dialogSection("Evidence actions", actions),
      dialogSection("Keyword mention lenses", ruleEvidence(event.tags)),
      dialogSection("Source trace", sourceEvidence(event, "event"))
    ].filter(Boolean);
    presentInspector("Event evidence", event.id, children);
  }

  function fullTextSection(revision) {
    const body = getRevisionBody(revision.id);
    if (body === null) {
      return dialogSection("Revision text", notice("Full text is intentionally absent from the public projection. Import a complete archive locally to inspect the decoded snapshot; nothing will be uploaded."));
    }
    const preview = body.length > BODY_PREVIEW_LIMIT ? body.slice(0, BODY_PREVIEW_LIMIT) : body;
    const pre = element("pre", { className: "body-preview", text: preview });
    const children = [pre];
    if (body.length > BODY_PREVIEW_LIMIT) {
      const expansion = element("div", {}, [
        element("p", {
          className: "section-note",
          text: `Initial display is bounded at ${formatNumber(BODY_PREVIEW_LIMIT)} characters. The original snapshot contains ${formatBytes(revision.bytes)}.`
        })
      ]);
      const showFull = button("Show complete local text", () => {
        pre.textContent = body;
        expansion.replaceChildren(element("p", {
          className: "section-note",
          text: `Complete local text displayed; original snapshot size: ${formatBytes(revision.bytes)}.`
        }));
      }, "button-quiet");
      expansion.append(showFull);
      children.push(expansion);
    } else {
      children.push(element("p", {
        className: "section-note",
        text: `Complete local text displayed; original snapshot size: ${formatBytes(revision.bytes)}.`
      }));
    }
    return dialogSection("Revision text", children);
  }

  function coordinateLabel(start, end) {
    if (end <= start) {
      return `insertion point ${formatNumber(start + 1)}`;
    }
    if (end === start + 1) {
      return `line ${formatNumber(start + 1)}`;
    }
    return `lines ${formatNumber(start + 1)}–${formatNumber(end)}`;
  }

  function boundedLines(lines, start, end) {
    const actualEnd = Math.min(end, start + CHANGE_LINE_LIMIT);
    const text = lines.slice(start, actualEnd).join("\n");
    return {
      text,
      truncated: actualEnd < end
    };
  }

  function changedRangesSection(revision) {
    if (!state.privateData) {
      return dialogSection("Changed ranges", notice("Changed-range text requires the current and predecessor snapshots from a complete local archive."));
    }
    if (!revision.previousId) {
      return dialogSection("Changed ranges", notice("No retained predecessor is available in this projection, so a changed-range view cannot be computed."));
    }
    const previous = state.prepared.revisions.get(revision.previousId);
    if (!previous) {
      return dialogSection("Changed ranges", notice(`Predecessor ${revision.previousId} is not present in this projection. Missing content is not reconstructed or invented.`, "warning"));
    }
    const currentBody = getRevisionBody(revision.id);
    const previousBody = getRevisionBody(previous.id);
    if (currentBody === null || previousBody === null) {
      return dialogSection("Changed ranges", notice("One or both verified snapshots are unavailable in local memory. Missing content is not reconstructed or invented.", "warning"));
    }
    const changed = revision.hunks.filter((hunk) => hunk.op !== "equal");
    if (!changed.length) {
      return dialogSection("Changed ranges", notice("The revision metadata contains no non-equal hunk."));
    }
    const previousLines = previousBody.split("\n");
    const currentLines = currentBody.split("\n");
    const container = element("div");
    const shown = changed.slice(0, CHANGE_HUNK_LIMIT);
    shown.forEach((hunk, index) => {
      const block = element("div", { className: "change-block" }, [
        element("p", {
          className: "change-label",
          text: `${formatNumber(index + 1)} · ${hunk.op} · previous ${coordinateLabel(hunk.a0, hunk.a1)} · current ${coordinateLabel(hunk.b0, hunk.b1)}`
        })
      ]);
      if (hunk.op === "delete" || hunk.op === "replace") {
        const previousSlice = boundedLines(previousLines, hunk.a0, hunk.a1);
        block.append(element("p", { className: "change-label", text: "Previous snapshot range" }));
        block.append(element("pre", {
          className: "change-preview",
          text: previousSlice.text || "(empty range)"
        }));
        if (previousSlice.truncated) {
          block.append(element("p", { className: "section-note", text: `Range display capped at ${formatNumber(CHANGE_LINE_LIMIT)} lines.` }));
        }
      }
      if (hunk.op === "insert" || hunk.op === "replace") {
        const currentSlice = boundedLines(currentLines, hunk.b0, hunk.b1);
        block.append(element("p", { className: "change-label", text: "Current snapshot range" }));
        block.append(element("pre", {
          className: "change-preview",
          text: currentSlice.text || "(empty range)"
        }));
        if (currentSlice.truncated) {
          block.append(element("p", { className: "section-note", text: `Range display capped at ${formatNumber(CHANGE_LINE_LIMIT)} lines.` }));
        }
      }
      container.append(block);
    });
    if (changed.length > shown.length) {
      container.append(notice(`${formatNumber(changed.length - shown.length)} additional changed ranges are not rendered in this bounded inspector. Inspect the complete snapshots instead.`, "warning"));
    }
    return dialogSection("Changed ranges", container);
  }

  function openRevision(revisionId) {
    const revision = state.prepared.revisions.get(revisionId);
    if (!revision) {
      showToast(`Revision ${revisionId} is not present in the active projection.`, "error");
      return;
    }
    const page = state.prepared.pages.get(revision.pageId);
    const handle = revision.handleId ? state.prepared.handles.get(revision.handleId) : null;
    const actions = element("div", { className: "dialog-actions" }, [
      button("Inspect page", () => openPage(revision.pageId), "button-quiet"),
      revision.handleId ? button("Inspect handle", () => openHandle(revision.handleId), "button-quiet") : null,
      revision.previousId && state.prepared.revisions.has(revision.previousId)
        ? button("Inspect predecessor", () => openRevision(revision.previousId), "button-quiet")
        : null
    ]);
    const children = [
      notice("This record is a complete page snapshot. It is not an individual message and does not authenticate the handle that saved it."),
      dialogSection("Revision metadata", evidenceList([
        ["Revision ID", revision.id],
        ["Page", `${displayPageName(revision.pageId)} · ${revision.pageId}`],
        ["Held-page row", page && page.held ? "Present" : "Absent"],
        ["Handle", revision.handleId ? `${displayHandleName(revision.handleId)} · ${revision.handleId}` : "Unattributed"],
        ["Handle kind", handle ? handle.kind : "Not attributed"],
        ["UTC time", formatDateTime(revision.time)],
        ["Time grade", revision.grade],
        ["Declared uncertainty", revision.uncertaintySeconds === null ? "Not recorded" : `${formatNumber(revision.uncertaintySeconds)} seconds`],
        ["Snapshot bytes", formatNumber(revision.bytes)],
        ["Snapshot lines", formatNumber(revision.lines)],
        ["SHA-256", revision.sha256],
        ["Retained predecessor", revision.previousId || "None available"],
        ["Hunks", formatNumber(revision.hunks.length)]
      ])),
      page ? null : notice("This revision references a page absent from the held-page table. The interface shows the reference but does not invent missing page metadata.", "warning"),
      dialogSection("Evidence actions", actions),
      fullTextSection(revision),
      changedRangesSection(revision),
      dialogSection("Keyword mention lenses", ruleEvidence(revision.tags)),
      dialogSection("Source trace", sourceEvidence(revision, "revision"))
    ].filter(Boolean);
    presentInspector("Revision snapshot", revision.id, children);
  }

  function openPage(pageId) {
    const page = state.prepared.pages.get(pageId);
    const allEvents = state.dataset.events.filter((event) => event.pageId === pageId);
    const filteredEvents = state.filteredEvents.filter((event) => event.pageId === pageId);
    const revisions = state.dataset.revisions
      .filter((revision) => revision.pageId === pageId)
      .sort((a, b) => asText(b.time, "").localeCompare(asText(a.time, "")));
    const actions = element("div", { className: "dialog-actions" }, [
      button("Filter activity to page", () => {
        setScope("pages", [pageId], `page ${pageId}`);
        clearInspector(false);
        switchView("activity", true);
      }, "button-primary")
    ]);
    const children = [
      notice(page && page.held
        ? "Page names are pseudonymous in public mode. A local archive may reveal the original title, but does not change the public page ID."
        : "This is an unheld page referenced by events. Event-derived metadata is available, but its missing content is not reconstructed.", page && page.held ? "" : "warning"),
      dialogSection("Page evidence", evidenceList([
        ["Page", displayPageName(pageId)],
        ["Public ID", pageId],
        ["Wiki", page ? page.wiki : (allEvents[0] ? allEvents[0].wiki : "Not recorded")],
        ["Held-page row", page && page.held ? "Present" : "Absent; event-derived node only"],
        ["All events", formatNumber(allEvents.length)],
        ["Filtered events", formatNumber(filteredEvents.length)],
        ["Revision records", formatNumber(revisions.length)],
        ["Declared revisions", page ? formatNumber(page.revisions) : "Unavailable"],
        ["Declared deletions", page ? formatNumber(page.deletions) : "Unavailable"],
        ["Declared recreations", page ? formatNumber(page.recreations) : "Unavailable"],
        ["First UTC", page ? formatDateTime(page.first) : formatDateTime(allEvents[0]?.time)],
        ["Last UTC", page ? formatDateTime(page.last) : formatDateTime(allEvents[allEvents.length - 1]?.time)]
      ])),
      dialogSection("Evidence actions", actions)
    ];
    if (revisions.length) {
      const revisionButtons = element("div", { className: "dialog-actions" },
        revisions.slice(0, 30).map((revision) => button(
          `${revision.id} · ${formatDate(revision.time)}`,
          () => openRevision(revision.id),
          "button-quiet"
        ))
      );
      if (revisions.length > 30) {
        revisionButtons.append(element("p", {
          className: "section-note",
          text: `${formatNumber(revisions.length - 30)} additional revisions are omitted from this bounded list.`
        }));
      }
      children.push(dialogSection("Latest revision snapshots", revisionButtons));
    } else {
      children.push(dialogSection("Revision snapshots", notice("No revision record for this page is present in the projection.")));
    }
    if (page) {
      children.push(dialogSection("Keyword mention lenses", ruleEvidence(page.tags)));
    }
    presentInspector("Page evidence", pageId, children);
  }

  function openHandle(handleId) {
    const handle = state.prepared.handles.get(handleId);
    if (!handle) {
      showToast(`Handle ${handleId} is not present in the active projection.`, "error");
      return;
    }
    const allEvents = state.dataset.events.filter((event) => event.handleId === handleId);
    const filteredEvents = state.filteredEvents.filter((event) => event.handleId === handleId);
    const filteredPages = new Map();
    for (const event of filteredEvents) {
      if (event.pageId) {
        filteredPages.set(event.pageId, (filteredPages.get(event.pageId) || 0) + 1);
      }
    }
    const sortedPages = [...filteredPages.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const eventIds = allEvents.map((event) => event.id);
    const actions = element("div", { className: "dialog-actions" }, [
      button("Filter activity to handle", () => {
        setScope("handles", [handleId], `events attributed to ${handleId}`);
        clearInspector(false);
        switchView("activity", true);
      }, "button-primary")
    ]);
    const children = [
      notice(handle.kind === "human"
        ? "This alias carries the dataset’s A3 human-handle flag and is excluded from the agent-like overlap graph."
        : handle.kind === "unattributed"
          ? "This record is unattributed and is excluded from the agent-like overlap graph."
          : "This is an unverified alias, not an authenticated agent, person, or provider identity."),
      dialogSection("Handle evidence", evidenceList([
        ["Displayed name", displayHandleName(handleId)],
        ["Public ID", handleId],
        ["Kind", handle.kind],
        ["All attributed events", formatNumber(eventIds.length)],
        ["Filtered events", formatNumber(filteredEvents.length)],
        ["Declared revisions", formatNumber(handle.revisions)],
        ["Declared pages", formatNumber(handle.pages.length)],
        ["First UTC", formatDateTime(handle.first)],
        ["Last UTC", formatDateTime(handle.last)],
        ["Wikis", handle.wikis.join(", ") || "None recorded"]
      ])),
      dialogSection("Evidence actions", actions)
    ];
    if (sortedPages.length) {
      const pageButtons = element("div", { className: "dialog-actions" },
        sortedPages.slice(0, 30).map(([pageId, count]) => button(
          `${displayPageName(pageId)} · ${formatNumber(count)} events`,
          () => openPage(pageId),
          "button-quiet"
        ))
      );
      if (sortedPages.length > 30) {
        pageButtons.append(element("p", {
          className: "section-note",
          text: `${formatNumber(sortedPages.length - 30)} additional filtered pages are omitted from this bounded list.`
        }));
      }
      children.push(dialogSection("Pages in the current result", pageButtons));
    } else {
      children.push(dialogSection("Pages in the current result", notice("No attributed page survives the current filters for this handle.")));
    }
    presentInspector("Handle evidence", handleId, children);
  }

  function openOverlapEdge(edge) {
    const pages = edge.sharedPages;
    const pageButtons = element("div", { className: "dialog-actions" },
      pages.slice(0, 60).map((pageId) => button(
        `${displayPageName(pageId)} · ${pageId}`,
        () => openPage(pageId),
        "button-quiet"
      ))
    );
    if (pages.length > 60) {
      pageButtons.append(element("p", {
        className: "section-note",
        text: `${formatNumber(pages.length - 60)} additional shared pages are omitted from this bounded list.`
      }));
    }
    const actions = element("div", { className: "dialog-actions" }, [
      button("Filter activity to shared pages", () => {
        setScope("pages", pages, `${formatNumber(pages.length)} shared pages for ${edge.left} + ${edge.right}`);
        clearInspector(false);
        switchView("activity", true);
      }, "button-primary"),
      button(`Inspect ${edge.left}`, () => openHandle(edge.left), "button-quiet"),
      button(`Inspect ${edge.right}`, () => openHandle(edge.right), "button-quiet")
    ]);
    presentInspector("Overlap evidence", `${edge.left} + ${edge.right}`, [
      notice("This edge means only that the two unverified aliases have filtered save events on the same public page IDs. It does not show communication or motive."),
      dialogSection("Edge observation", evidenceList([
        ["Alias A", `${displayHandleName(edge.left)} · ${edge.left}`],
        ["Alias B", `${displayHandleName(edge.right)} · ${edge.right}`],
        ["Shared page IDs", formatNumber(edge.weight)],
        ["Graph class", "Shared-page overlap, not communication"]
      ])),
      dialogSection("Evidence actions", actions),
      dialogSection("Shared pages", pageButtons)
    ]);
  }

  function openReuseGroup(groupId) {
    const group = state.prepared.reuse.get(groupId);
    if (!group) {
      showToast(`Reuse group ${groupId} is not present in the active projection.`, "error");
      return;
    }
    const revisionButtons = element("div", { className: "dialog-actions" });
    group.revisionIds.slice(0, 60).forEach((revisionId) => {
      const revision = state.prepared.revisions.get(revisionId);
      revisionButtons.append(button(
        revision ? `${revision.id} · ${displayPageName(revision.pageId)}` : revisionId,
        () => openRevision(revisionId),
        "button-quiet"
      ));
    });
    if (group.revisionIds.length > 60) {
      revisionButtons.append(element("p", {
        className: "section-note",
        text: `${formatNumber(group.revisionIds.length - 60)} additional revisions are omitted from this bounded list.`
      }));
    }
    const pageList = group.pageIds.slice(0, 40).map((id) => `${displayPageName(id)} · ${id}`).join("\n");
    const handleList = group.handleIds.slice(0, 40).map((id) => `${displayHandleName(id)} · ${id}`).join("\n");
    const actions = element("div", { className: "dialog-actions" }, [
      button("Filter activity to group", () => {
        setScope("revisions", group.revisionIds, `revisions in reuse group ${group.id}`);
        clearInspector(false);
        switchView("activity", true);
      }, "button-primary")
    ]);
    presentInspector("Reuse evidence", group.id, [
      notice("This precomputed group contains an identical snapshot of at least 160 bytes across at least two distinct unverified nonhuman handles. Equal SHA-256 values do not establish direction, communication, provider identity, or motive."),
      dialogSection("Reuse group", evidenceList([
        ["Group", group.id],
        ["SHA-256", group.sha256],
        ["Snapshot bytes", formatNumber(group.bytes)],
        ["Revisions", formatNumber(group.revisionIds.length)],
        ["Pages", formatNumber(group.pageIds.length)],
        ["Handles", formatNumber(group.handleIds.length)]
      ])),
      dialogSection("Evidence actions", actions),
      dialogSection("Inspect relevant revisions", revisionButtons),
      dialogSection("Pages", element("pre", {
        className: "change-preview",
        text: pageList || "No page IDs recorded."
      })),
      dialogSection("Handles", element("pre", {
        className: "change-preview",
        text: handleList || "No handle IDs recorded."
      }))
    ]);
  }

  function openPins() {
    const events = [...state.pins]
      .map((id) => state.prepared.events.get(id))
      .filter(Boolean);
    if (!events.length) {
      showToast("No pinned events are available in the active projection.", "error");
      return;
    }
    const visibleEvents = events.slice(0, 100);
    const rows = visibleEvents.map((event) => [
      event.id,
      event.type,
      formatDateTime(event.time),
      event.pageId || "Unattributed",
      element("div", { className: "row-actions" }, [
        button("Inspect", () => openEvent(event.id), "button-small"),
        button("Remove", () => {
          state.pins.delete(event.id);
          renderPinnedControls();
          renderCurrentView();
          if (state.pins.size) {
            openPins();
          } else {
            clearInspector(false);
            showToast("Pinned selection cleared.");
          }
        }, "button-small")
      ])
    ]);
    const table = makeTable([
      { label: "Event" },
      { label: "Type" },
      { label: "UTC time" },
      { label: "Page ID" },
      { label: "Evidence" }
    ], rows);
    const boundedNote = events.length > visibleEvents.length
      ? notice(`${formatNumber(events.length - visibleEvents.length)} additional pinned events are omitted from this bounded inspector. The metadata export still includes every pinned event ID.`, "warning")
      : null;
    presentInspector("Metadata selection", `${formatNumber(events.length)} pinned events`, [
      notice("Only event IDs and the parent-provided metadata-only export are used. Original names, text, and search terms are never passed to the exporter."),
      dialogSection("Pinned events", element("div", { className: "table-wrap" }, [table])),
      boundedNote,
      dialogSection("Export", element("div", { className: "dialog-actions" }, [
        button("Export metadata selection", exportPinnedSelection, "button-primary")
      ]))
    ].filter(Boolean));
  }

  function exportPinnedSelection() {
    if (!state.dataset || !state.pins.size) {
      showToast("Pin at least one event before exporting.", "error");
      return;
    }
    try {
      assert(window.WikiEvidence && typeof window.WikiEvidence.exportSelection === "function", "The metadata exporter is unavailable.");
      const ids = [...state.pins].filter((id) => state.prepared.events.has(id));
      assert(ids.length > 0, "No pinned event IDs remain in the active projection.");
      const exported = window.WikiEvidence.exportSelection(state.dataset, ids);
      const serialized = JSON.stringify(exported, null, 2);
      assert(typeof serialized === "string", "The metadata exporter returned a non-serializable result.");
      if (state.downloadUrl) {
        URL.revokeObjectURL(state.downloadUrl);
      }
      const blob = new Blob([serialized], { type: "application/json" });
      state.downloadUrl = URL.createObjectURL(blob);
      const anchor = element("a", {
        attrs: {
          href: state.downloadUrl,
          download: "rapp-wiki-observatory-selection.json"
        }
      });
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      const downloadUrl = state.downloadUrl;
      window.setTimeout(() => {
        URL.revokeObjectURL(downloadUrl);
        if (state.downloadUrl === downloadUrl) {
          state.downloadUrl = "";
        }
      }, 1000);
      showToast(`Exported metadata for ${formatNumber(ids.length)} pinned events.`, "success");
    } catch (error) {
      console.error(error);
      showToast(`Export failed: ${errorMessage(error)}`, "error");
    }
  }

  async function importArchive(file) {
    if (!file || state.importBusy) {
      return;
    }
    const token = ++state.importToken;
    setImportBusy(true);
    setImportMessage("Opening the archive in browser memory…");
    try {
      assert(window.WikiEvidence && typeof window.WikiEvidence.loadLocal === "function", "The local archive loader is unavailable.");
      const result = await window.WikiEvidence.loadLocal(file, (status) => {
        if (token === state.importToken) {
          setImportMessage(asText(status, "Validating the local archive…"));
        }
      });
      if (token !== state.importToken) {
        return;
      }
      validateLocalResult(result);
      const prepared = prepareDataset(result.data);
      if (token !== state.importToken) {
        return;
      }
      const referenceMessage = result.integrity.matchesReference
        ? "File and body checksums verified locally; the files match the published reference."
        : "File and body checksums verified locally; archive origin is unrecognized.";
      activateDataset(
        result.data,
        result.privateData,
        result.integrity,
        "private",
        prepared,
        referenceMessage,
        result.integrity.matchesReference ? "success" : ""
      );
      showToast("Private archive loaded locally. Nothing was uploaded.", "success");
    } catch (error) {
      console.error(error);
      if (token === state.importToken) {
        setImportMessage(`Import failed: ${errorMessage(error)}`, "error");
        showToast(`Import failed: ${errorMessage(error)}`, "error");
      }
    } finally {
      if (token === state.importToken) {
        setImportBusy(false);
        refs.archiveInput.value = "";
        renderPrivacyState();
      }
    }
  }

  function unloadArchive() {
    if (state.mode !== "private" || !state.bundledDataset) {
      return;
    }
    state.importToken += 1;
    window.clearTimeout(state.searchTimer);
    clearInspector(false);
    refs.dialogBody.replaceChildren();
    refs.searchFilter.value = "";
    state.privateData = null;
    state.integrity = null;
    const prepared = prepareDataset(state.bundledDataset);
    activateDataset(
      state.bundledDataset,
      null,
      null,
      "public",
      prepared,
      "Private archive unloaded. Bundled metadata-only projection restored.",
      "success"
    );
    showToast("Private names and bodies released; public metadata restored.", "success");
  }

  function wireControls() {
    refs.appShell = byId("app-shell");
    refs.appStatus = byId("app-status");
    refs.appStatusText = byId("app-status-text");
    refs.importArchive = byId("import-archive");
    refs.archiveInput = byId("archive-input");
    refs.unloadArchive = byId("unload-archive");
    refs.themeToggle = byId("theme-toggle");
    refs.openPins = byId("open-pins");
    refs.exportSelection = byId("export-selection");
    refs.privacyMark = byId("privacy-mark");
    refs.privacyTitle = byId("privacy-title");
    refs.privacyCopy = byId("privacy-copy");
    refs.integrityLine = byId("integrity-line");
    refs.importStatus = byId("import-status");
    refs.resetFilters = byId("reset-filters");
    refs.searchFilter = byId("search-filter");
    refs.searchNote = byId("search-note");
    refs.typeFilter = byId("type-filter");
    refs.wikiFilter = byId("wiki-filter");
    refs.gradeFilter = byId("grade-filter");
    refs.dateFrom = byId("date-from");
    refs.dateTo = byId("date-to");
    refs.scopeBox = byId("scope-box");
    refs.scopeCopy = byId("scope-copy");
    refs.clearScope = byId("clear-scope");
    refs.jumpResults = byId("jump-results");
    refs.showMethods = byId("show-methods");
    refs.filterCount = byId("filter-count");
    refs.viewTabs = byId("view-tabs");
    refs.mainContent = byId("main-content");
    refs.viewKicker = byId("view-kicker");
    refs.viewHeading = byId("view-heading");
    refs.viewDescription = byId("view-description");
    refs.archiveStamp = byId("archive-stamp");
    refs.kpiGrid = byId("kpi-grid");
    refs.viewContent = byId("view-content");
    refs.evidenceDialog = byId("evidence-dialog");
    refs.dialogKicker = byId("dialog-kicker");
    refs.dialogTitle = byId("dialog-title");
    refs.dialogBody = byId("dialog-body");
    refs.closeDialog = byId("close-dialog");
    refs.toast = byId("toast");

    refs.themeToggle.addEventListener("click", toggleTheme);
    refs.importArchive.addEventListener("click", () => refs.archiveInput.click());
    refs.archiveInput.addEventListener("change", () => {
      const file = refs.archiveInput.files && refs.archiveInput.files[0];
      if (file) {
        void importArchive(file);
      }
    });
    refs.unloadArchive.addEventListener("click", unloadArchive);
    refs.openPins.addEventListener("click", openPins);
    refs.exportSelection.addEventListener("click", exportPinnedSelection);
    refs.resetFilters.addEventListener("click", resetFilters);
    refs.clearScope.addEventListener("click", clearScope);
    refs.jumpResults.addEventListener("click", () => {
      refs.mainContent.focus();
      refs.mainContent.scrollIntoView({ block: "start" });
    });
    refs.showMethods.addEventListener("click", () => switchView("methods", true));
    refs.closeDialog.addEventListener("click", () => clearInspector(true));
    refs.evidenceDialog.addEventListener("close", () => {
      refs.dialogBody.replaceChildren();
      if (state.lastFocus instanceof HTMLElement && state.lastFocus.isConnected) {
        state.lastFocus.focus();
      }
      state.lastFocus = null;
    });

    refs.searchFilter.addEventListener("input", () => {
      state.filters.search = refs.searchFilter.value.slice(0, 160);
      window.clearTimeout(state.searchTimer);
      refs.searchNote.textContent = state.privateData
        ? "Waiting to run a bounded local full-text scan…"
        : "Waiting to search public metadata…";
      state.searchTimer = window.setTimeout(() => {
        state.searchContext = buildSearchContext(state.filters.search);
        applyFilters(true);
      }, 260);
    });
    refs.typeFilter.addEventListener("change", () => {
      state.filters.type = refs.typeFilter.value;
      applyFilters(true);
    });
    refs.wikiFilter.addEventListener("change", () => {
      state.filters.wiki = refs.wikiFilter.value;
      applyFilters(true);
    });
    refs.gradeFilter.addEventListener("change", () => {
      state.filters.grade = refs.gradeFilter.value;
      applyFilters(true);
    });
    refs.dateFrom.addEventListener("change", () => {
      state.filters.from = refs.dateFrom.value;
      applyFilters(true);
    });
    refs.dateTo.addEventListener("change", () => {
      state.filters.to = refs.dateTo.value;
      applyFilters(true);
    });

    const tabs = [...refs.viewTabs.querySelectorAll("[data-view]")];
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => switchView(tab.dataset.view));
      tab.addEventListener("keydown", (event) => {
        const current = tabs.indexOf(tab);
        let target = -1;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          target = (current + 1) % tabs.length;
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          target = (current - 1 + tabs.length) % tabs.length;
        } else if (event.key === "Home") {
          target = 0;
        } else if (event.key === "End") {
          target = tabs.length - 1;
        }
        if (target >= 0) {
          event.preventDefault();
          tabs[target].focus();
          switchView(tabs[target].dataset.view);
        }
      });
    });
    updateThemeControl();
  }

  function fatalError(error) {
    console.error(error);
    state.mode = "error";
    state.ready = false;
    refs.appShell.setAttribute("aria-busy", "false");
    setAppStatus(`Observatory startup failed: ${errorMessage(error)}`, "error");
    refs.filterCount.textContent = "No evidence loaded.";
    refs.viewContent.replaceChildren(emptyState(
      "Evidence could not be loaded",
      "The bundled projection or archive runtime failed validation. No fallback dataset was substituted."
    ));
    refs.importArchive.disabled = true;
    refs.archiveInput.disabled = true;
    refs.unloadArchive.disabled = true;
    refs.openPins.disabled = true;
    refs.exportSelection.disabled = true;
  }

  async function initialize() {
    wireControls();
    try {
      assert(window.WikiEvidence, "WikiEvidence is not present.");
      assert(typeof window.WikiEvidence.loadBundle === "function", "WikiEvidence.loadBundle is unavailable.");
      const dataNode = byId("observatory-data");
      assert(dataNode, "The bundled projection element is missing.");
      const base64 = dataNode.textContent.trim();
      assert(base64.length > 0, "The bundled projection is empty.");
      const dataset = await window.WikiEvidence.loadBundle(base64);
      validateDataset(dataset, "The bundled projection");
      const prepared = prepareDataset(dataset);
      state.bundledDataset = dataset;
      activateDataset(dataset, null, null, "public", prepared);
    } catch (error) {
      fatalError(error);
    }
  }

  window.addEventListener("error", (event) => {
    if (state.ready && event.error) {
      console.error(event.error);
      showToast(`Unexpected interface error: ${errorMessage(event.error)}`, "error");
    }
  });
  window.addEventListener("unhandledrejection", (event) => {
    if (state.ready) {
      console.error(event.reason);
      showToast(`Unexpected interface error: ${errorMessage(event.reason)}`, "error");
    }
  });
  window.addEventListener("beforeunload", () => {
    if (state.downloadUrl) {
      URL.revokeObjectURL(state.downloadUrl);
    }
    state.privateData = null;
  });

  void initialize();
})();
