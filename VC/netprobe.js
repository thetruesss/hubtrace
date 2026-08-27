(() => {
  if (window.__hubTraceProbe) return;

  const CHANNEL = "hub-trace";
  const ORIGIN = location.origin;
  const CAPTURE_WINDOW_MS = 120000;
  const MAX_BODY_CHARS = 6 * 1024 * 1024;
  const GOOD_ENOUGH_SCORE = 70;

  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  const XHR = window.XMLHttpRequest;
  const protoOpen = XHR && XHR.prototype.open;
  const protoSend = XHR && XHR.prototype.send;
  const protoSetHeader = XHR && XHR.prototype.setRequestHeader;
  const INFO = "__hubTraceInfo";

  const probe = {
    recipe: null,
    score: -1,
    card: null,
    cardScore: -1,
    startedAt: Date.now(),
    capturing: true,
    appVersion: "",
    placeId: "",
    debug: false,
    journal: []
  };
  window.__hubTraceProbe = probe;

  // журнал для отладочного отчёта: что за запросы к хабу шли на этой странице.
  // Заголовки не пишем вовсе — в них куки и токены, им в отчёте не место
  const JOURNAL_LIMIT = 30;
  const JOURNAL_BODY_CAP = 4000;
  const JOURNAL_TEXT_CAP = 20000;
  let journalSeq = 0;

  function clipText(value, cap) {
    const text = String(value == null ? "" : value);
    return text.length > cap ? `${text.slice(0, cap)}…(+${text.length - cap})` : text;
  }

  function journalPush(request, responseText, status, own) {
    if (!probe.debug || !request) return;
    const url = String(request.url || "");
    if (!sameOrigin(url)) return;
    const lower = url.toLowerCase();
    if (/\.(js|css|png|jpe?g|svg|woff2?|ico|map)(\?|$)/.test(lower)) return;
    if (/analytics|metrics|sentry|telemetry|tracker/.test(lower)) return;
    probe.journal.push({
      id: ++journalSeq,
      at: Date.now(),
      own: Boolean(own),
      method: String(request.method || "GET").toUpperCase(),
      url: absolute(url),
      status: Number(status) || 0,
      body: clipText(typeof request.body === "string" ? request.body : "", JOURNAL_BODY_CAP),
      response: clipText(responseText, JOURNAL_TEXT_CAP),
      href: location.href
    });
    if (probe.journal.length > JOURNAL_LIMIT) probe.journal.shift();
  }

  function post(payload) {
    try {
      window.postMessage({ channel: CHANNEL, ...payload }, ORIGIN);
    } catch {}
  }

  function itemIdFromHref(href) {
    const match = String(href || "").match(/\/stock\/item\/(?:Lozon:)?([^/?#]+)/i);
    if (!match) return "";
    try {
      return decodeURIComponent(match[1]);
    } catch (_err) {
      return match[1];
    }
  }

  function sameOrigin(url) {
    try {
      return new URL(url, location.href).origin === ORIGIN;
    } catch (_err) {
      return false;
    }
  }

  function absolute(url) {
    try {
      return new URL(url, location.href).toString();
    } catch (_err) {
      return String(url || "");
    }
  }

  function headersToObject(input) {
    const out = {};
    if (!input) return out;
    try {
      if (typeof Headers !== "undefined" && input instanceof Headers) {
        input.forEach((value, key) => {
          out[key] = value;
        });
        return out;
      }
      if (Array.isArray(input)) {
        for (const pair of input) if (pair && pair.length === 2) out[String(pair[0])] = String(pair[1]);
        return out;
      }
      if (typeof input === "object") {
        for (const key of Object.keys(input)) out[key] = String(input[key]);
      }
    } catch {}
    return out;
  }

  const FORBIDDEN_HEADERS = new Set([
    "host",
    "connection",
    "content-length",
    "origin",
    "referer",
    "cookie",
    "cookie2",
    "date",
    "dnt",
    "expect",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "via"
  ]);

  function cleanHeaders(raw) {
    const out = {};
    for (const key of Object.keys(raw || {})) {
      const lower = key.toLowerCase();
      if (FORBIDDEN_HEADERS.has(lower)) continue;
      if (lower.startsWith("sec-") || lower.startsWith("proxy-")) continue;
      out[key] = raw[key];
    }
    return out;
  }

  function looksLikeJson(text) {
    if (!text) return false;
    const head = text.slice(0, 400).trimStart();
    return head.startsWith("{") || head.startsWith("[");
  }

  function carriesId(url, body, itemId) {
    if (!itemId) return false;
    const hay = `${url || ""}\n${typeof body === "string" ? body : ""}`;
    if (hay.includes(itemId)) return true;
    try {
      return hay.includes(encodeURIComponent(itemId));
    } catch (_err) {
      return false;
    }
  }

  function scoreCandidate(request, responseText) {
    const url = String(request.url || "").toLowerCase();
    const body = typeof request.body === "string" ? request.body : "";
    const itemId = itemIdFromHref(location.href);
    let score = 0;

    if (/histor|истор/.test(url)) score += 45;
    if (/histor/i.test(body)) score += 30;
    if (/\/api\/|\/graphql|\/v\d+\//.test(url)) score += 6;
    if (itemId && `${request.url}\n${body}`.includes(itemId)) score += 28;
    if (/event|movement|operation|log|trace/.test(url)) score += 8;

    if (responseText) {
      if (/"(total|totalCount|totalRows|count|rowCount|itemsCount)"\s*:/i.test(responseText)) score += 10;
      if (/\[\s*[{[]/.test(responseText)) score += 8;
      if (/warehouse|склад|sklad/i.test(responseText)) score += 14;
      score += Math.min(12, Math.floor(responseText.length / 3000));
    }

    if (/\.(js|css|png|jpe?g|svg|woff2?|ico|map)(\?|$)/.test(url)) return -1;
    if (/analytics|metrics|sentry|telemetry|tracker/.test(url)) return -1;

    return score;
  }

  const POSTING_NUMBER_RE = /\d{6,}-\d{2,}-\d{1,3}/;

  function scoreCard(request, responseText) {
    const url = String(request.url || "").toLowerCase();
    if (/histor/.test(url)) return -1;
    if (!responseText || responseText.length > 200000) return -1;
    if (!POSTING_NUMBER_RE.test(responseText)) return -1;

    let score = 20;
    const itemId = itemIdFromHref(location.href);
    if (itemId && `${request.url}\n${request.body || ""}`.includes(itemId)) score += 25;
    if (itemId && responseText.includes(itemId)) score += 15;
    if (/"(status|state|stateName|statusName)"/i.test(responseText)) score += 20;
    if (/\/item|\/predmet|\/stock/.test(url)) score += 10;
    score += Math.max(0, 10 - Math.floor(responseText.length / 20000));
    return score;
  }

  function recipeFrom(prefix, request, itemId, score) {
    return {
      id: `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      url: absolute(request.url),
      method: String(request.method || "GET").toUpperCase(),
      headers: cleanHeaders(request.headers),
      body: typeof request.body === "string" ? request.body : null,
      itemId,
      score,
      capturedAt: Date.now()
    };
  }

  function considerCard(request, responseText) {
    const score = scoreCard(request, responseText);
    if (score <= 0 || score <= probe.cardScore) return;
    const itemId = itemIdFromHref(location.href);
    if (!carriesId(request.url, request.body, itemId)) return;

    const recipe = recipeFrom("c", request, itemId, score);

    probe.card = recipe;
    probe.cardScore = score;
    post({ type: "cardRecipe", recipe });
  }

  function readBuildVars() {
    if (probe.appVersion) return false;
    try {
      const config = window.__FE_VARS__?.envs?.config;
      if (config?.GIT_BRANCH) {
        probe.appVersion = String(config.GIT_BRANCH);
        return true;
      }
    } catch {}
    return false;
  }

  function noteHints(request) {
    if (!request || !sameOrigin(request.url)) return;
    let changed = readBuildVars();

    const headers = request.headers || {};
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() !== "x-o3-app-version" || !headers[key]) continue;
      const value = String(headers[key]);
      if (value !== probe.appVersion) {
        probe.appVersion = value;
        changed = true;
      }
    }

    if (!probe.placeId) {
      const source = `${request.url || ""}\n${typeof request.body === "string" ? request.body : ""}`;
      const match =
        source.match(/[?&](?:warehouse|placeId|place_id)=(\d{6,})/i) ||
        source.match(/"placeId"\s*:\s*"?(\d{6,})"?/);
      if (match) {
        probe.placeId = match[1];
        changed = true;
      }
    }

    if (changed) post({ type: "hint", appVersion: probe.appVersion, placeId: probe.placeId });
  }

  function consider(request, responseText, status) {
    noteHints(request);
    journalPush(request, responseText, status == null ? 200 : status, false);
    if (!probe.capturing) return;
    if (Date.now() - probe.startedAt > CAPTURE_WINDOW_MS) {
      probe.capturing = false;
      return;
    }
    if (!request || !request.url || !sameOrigin(request.url)) return;
    if (!looksLikeJson(responseText)) return;
    if (responseText.length > MAX_BODY_CHARS) return;

    considerCard(request, responseText);

    const score = scoreCandidate(request, responseText);
    if (score <= 0 || score <= probe.score) return;

    const itemId = itemIdFromHref(location.href);
    if (!carriesId(request.url, request.body, itemId)) return;
    const recipe = recipeFrom("r", request, itemId, score);
    recipe.sampleLength = responseText.length;

    probe.recipe = recipe;
    probe.score = score;
    if (score >= GOOD_ENOUGH_SCORE && probe.card) probe.capturing = false;
    post({ type: "recipe", recipe });
  }

  if (originalFetch) {
    window.fetch = function hubTraceFetch(input, init) {
      let request = null;
      try {
        if (typeof Request !== "undefined" && input instanceof Request) {
          request = {
            url: input.url,
            method: input.method,
            headers: headersToObject(input.headers),
            body: typeof init?.body === "string" ? init.body : null
          };
        } else {
          request = {
            url: String(input && input.url ? input.url : input),
            method: (init && init.method) || "GET",
            headers: headersToObject(init && init.headers),
            body: typeof init?.body === "string" ? init.body : null
          };
        }
      } catch (_err) {
        request = null;
      }

      const promise = originalFetch(input, init);
      if (!request) return promise;
      if (!probe.capturing && !probe.debug) {
        noteHints(request);
        return promise;
      }

      promise
        .then((response) => {
          if (response && !response.ok) journalPush(request, "", response.status, false);
          if (!response || !response.ok) return;
          const type = response.headers && response.headers.get("content-type");
          if (type && !/json|text/i.test(type)) return;
          let clone = null;
          try {
            clone = response.clone();
          } catch (_err) {
            return;
          }
          clone
            .text()
            .then((text) => consider(request, text))
            .catch(() => {});
        })
        .catch(() => {});

      return promise;
    };
  }

  if (XHR && protoOpen && protoSend) {
    XHR.prototype.open = function hubTraceOpen(method, url) {
      try {
        this[INFO] = {
          method: String(method || "GET").toUpperCase(),
          url: String(url || ""),
          headers: {},
          body: null
        };
      } catch {}
      return protoOpen.apply(this, arguments);
    };

    if (protoSetHeader) {
      XHR.prototype.setRequestHeader = function hubTraceSetHeader(key, value) {
        try {
          if (this[INFO]) this[INFO].headers[String(key)] = String(value);
        } catch {}
        return protoSetHeader.apply(this, arguments);
      };
    }

    XHR.prototype.send = function hubTraceSend(body) {
      try {
        const info = this[INFO];
        if (info) {
          if (typeof body === "string") info.body = body;
          const onLoad = () => {
            try {
              if (this.status < 200 || this.status >= 300) return;
              if (this.responseType && this.responseType !== "text" && this.responseType !== "json") return;
              const text =
                this.responseType === "json" ? JSON.stringify(this.response) : String(this.responseText || "");
              consider(info, text, this.status);
            } catch {}
          };
          this.addEventListener("load", onLoad, { once: true });
        }
      } catch {}
      return protoSend.apply(this, arguments);
    };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.origin && event.origin !== ORIGIN) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL) return;

    if (data.type === "debugOn") {
      probe.debug = true;
      return;
    }

    if (data.type === "askJournal") {
      const after = Number(data.after) || 0;
      post({ type: "journal", ticket: data.ticket, entries: probe.journal.filter((entry) => entry.id > after) });
      return;
    }

    if (data.type === "askRecipe") {
      if (probe.recipe) post({ type: "recipe", recipe: probe.recipe });
      if (probe.card) post({ type: "cardRecipe", recipe: probe.card });
      readBuildVars();
      if (probe.appVersion || probe.placeId) {
        post({ type: "hint", appVersion: probe.appVersion, placeId: probe.placeId });
      }
      return;
    }

    if (data.type !== "replay") return;

    const { ticket, url, method, headers, body, timeoutMs } = data;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = setTimeout(() => {
      try {
        controller?.abort();
      } catch {}
    }, Math.max(1000, Number(timeoutMs) || 20000));

    const init = {
      method: method || "GET",
      headers: headers || {},
      credentials: "include",
      cache: "no-store"
    };
    if (body != null && init.method !== "GET" && init.method !== "HEAD") init.body = body;
    if (controller) init.signal = controller.signal;

    const runner = originalFetch || window.fetch;
    Promise.resolve()
      .then(() => runner(url, init))
      .then((response) =>
        response.text().then((text) => ({
          ok: response.ok,
          status: response.status,
          text
        }))
      )
      .then((result) => {
        clearTimeout(timer);
        journalPush({ url, method, body }, result.text, result.status, true);
        post({ type: "replayResult", ticket, ...result });
      })
      .catch((error) => {
        clearTimeout(timer);
        post({ type: "replayResult", ticket, ok: false, status: 0, error: String(error?.message || error) });
      });
  });

  post({ type: "probeReady" });
})();
