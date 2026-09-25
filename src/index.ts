interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * MBTA MCP — Boston real-time transit via the MBTA v3 API (api-v3.mbta.com)
 *
 * Tools:
 * - mbta_departures: next real-time arrivals/departures at a station (predictions,
 *   with automatic /schedules fallback when predictions are empty, e.g. commuter
 *   rail off-peak)
 * - mbta_routes: subway / commuter rail / bus / ferry routes
 * - mbta_stops: stops on a route
 * - mbta_alerts: active service alerts
 *
 * Auth: keyless (20 req/min shared). Optional `_apiKey` (free MBTA v3 key)
 * sent as `x-api-key` lifts limits.
 *
 * API shape is JSON:API: rows live in data[].attributes, cross-references in
 * relationships + a top-level included[] sidecar (trip headsigns and route
 * names come from there, never from the prediction row itself).
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'MBTA');
}

const BASE_URL = 'https://api-v3.mbta.com';

const tools: McpToolExport['tools'] = [
  {
    name: 'mbta_departures',
    description:
      'Real-time MBTA train arrival and departure predictions at a Boston station — answers "when is the next train Boston", next Red Line subway at South Station, Green Line trolley, commuter rail departures, Silver Line and bus arrivals. Accepts a station name ("South Station", "Harvard") or a place id ("place-sstat"). Falls back to the published schedule when live predictions are empty (common for commuter rail off-peak). Example: mbta_departures({ stop: "South Station", route: "Red" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        stop: {
          type: 'string',
          description: 'Station name (e.g. "South Station", "Harvard", "Back Bay") or MBTA place id (e.g. "place-sstat")',
        },
        route: {
          type: 'string',
          description: 'Optional route id to filter, e.g. "Red", "Green-B", "CR-Providence", "SL1", "66" (see mbta_routes)',
        },
        direction_id: {
          type: 'number',
          description: 'Optional direction filter: 0 or 1 (meaning per route — see direction_destinations from mbta_routes)',
        },
        limit: { type: 'number', description: 'Max departures to return, 1-30 (default 8)' },
        _apiKey: {
          type: 'string',
          description: 'Optional: free MBTA v3 API key from api-v3.mbta.com for higher rate limits',
        },
      },
      required: ['stop'],
    },
  },
  {
    name: 'mbta_routes',
    description:
      'List MBTA routes for the Boston subway T, commuter rail, bus, and ferry — route ids, names, and the destination each direction heads toward. type: 0-1 subway/light rail (Red, Orange, Blue, Green, Mattapan), 2 commuter rail, 3 bus (includes Silver Line), 4 ferry. Default returns subway + commuter rail + ferry; pass type 3 for buses. Example: mbta_routes({ type: "2" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          description: 'Route type filter, comma-separable: "0,1" subway, "2" commuter rail, "3" bus, "4" ferry (default "0,1,2,4")',
        },
        _apiKey: {
          type: 'string',
          description: 'Optional: free MBTA v3 API key from api-v3.mbta.com for higher rate limits',
        },
      },
    },
  },
  {
    name: 'mbta_stops',
    description:
      'List the stops and stations on an MBTA route — Boston subway T lines, commuter rail lines, bus routes, ferries. Returns stop id, name, municipality, and wheelchair accessibility, in route order. Example: mbta_stops({ route: "Red" }) or mbta_stops({ route: "CR-Worcester" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        route: {
          type: 'string',
          description: 'Route id from mbta_routes, e.g. "Red", "Green-D", "CR-Providence", "66"',
        },
        _apiKey: {
          type: 'string',
          description: 'Optional: free MBTA v3 API key from api-v3.mbta.com for higher rate limits',
        },
      },
      required: ['route'],
    },
  },
  {
    name: 'mbta_alerts',
    description:
      'Active MBTA service alerts — Boston subway T delays, commuter rail disruptions, shuttle replacements, track changes, detours, elevator outages. Filter by route to check one line, e.g. is the Red Line delayed right now. Example: mbta_alerts({ route: "Red" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        route: {
          type: 'string',
          description: 'Optional route id to filter, e.g. "Red", "CR-Kingston", "66"',
        },
        limit: { type: 'number', description: 'Max alerts to return, 1-50 (default 15)' },
        _apiKey: {
          type: 'string',
          description: 'Optional: free MBTA v3 API key from api-v3.mbta.com for higher rate limits',
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// JSON:API plumbing

interface JsonApiResource {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string; type: string } | null }>;
}

interface JsonApiDoc {
  data: JsonApiResource[];
  included?: JsonApiResource[];
}

async function api(path: string, params: URLSearchParams, apiKey?: string): Promise<JsonApiDoc> {
  const headers: Record<string, string> = { Accept: 'application/vnd.api+json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  const res = await pwFetch(`${BASE_URL}${path}?${params}`, { headers });
  if (res.status === 429) {
    throw new Error(
      'MBTA: rate-limit (HTTP 429). The keyless tier allows 20 requests/minute. Retry in a few seconds, or pass _apiKey with a free MBTA v3 API key from api-v3.mbta.com for higher limits.',
    );
  }
  if (!res.ok) throw new Error(`MBTA API error: HTTP ${res.status} on ${path}`);
  return (await res.json()) as JsonApiDoc;
}

/** Index included[] by "type:id" so relationships can be resolved in O(1). */
function indexIncluded(doc: JsonApiDoc): Map<string, JsonApiResource> {
  const map = new Map<string, JsonApiResource>();
  for (const r of doc.included ?? []) map.set(`${r.type}:${r.id}`, r);
  return map;
}

function relId(r: JsonApiResource, name: string): string | undefined {
  return r.relationships?.[name]?.data?.id;
}

// ---------------------------------------------------------------------------
// Shared shaping

const ROUTE_TYPE_LABELS: Record<number, string> = {
  0: 'light rail',
  1: 'subway',
  2: 'commuter rail',
  3: 'bus',
  4: 'ferry',
};

const WHEELCHAIR_LABELS: Record<number, string> = {
  0: 'unknown',
  1: 'accessible',
  2: 'inaccessible',
};

function minutesAway(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((t - Date.now()) / 60000));
}

/** Current date + HH:MM in Boston — the MBTA interprets schedule filters in local time. */
function bostonNow(): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}`,
  };
}

// ---------------------------------------------------------------------------
// Station name resolution — parent stations (location_type=1), cached 10 min.

let stationCache: { at: number; stations: Array<{ id: string; name: string }> } | null = null;

async function listStations(apiKey?: string): Promise<Array<{ id: string; name: string }>> {
  if (stationCache && Date.now() - stationCache.at < 10 * 60 * 1000) return stationCache.stations;
  const doc = await api('/stops', new URLSearchParams({ 'filter[location_type]': '1' }), apiKey);
  const stations = doc.data.map((s) => ({ id: s.id, name: String(s.attributes.name ?? '') }));
  stationCache = { at: Date.now(), stations };
  return stations;
}

/** Resolve a user-supplied stop to a place id: pass through ids, text-match names. */
async function resolveStop(input: string, apiKey?: string): Promise<{ id: string; name?: string }> {
  const raw = input.trim();
  // Looks like an id already (place-sstat, 70079, place-NEC-2287)
  if (/^place-/i.test(raw) || /^\d+$/.test(raw)) return { id: raw };

  const q = raw.toLowerCase().replace(/\s+station$/, '').trim();
  const stations = await listStations(apiKey);
  const norm = (s: string) => s.toLowerCase();

  const exact = stations.find((s) => norm(s.name) === raw.toLowerCase() || norm(s.name) === q);
  if (exact) return { id: exact.id, name: exact.name };

  const starts = stations.filter((s) => norm(s.name).startsWith(q));
  const contains = starts.length > 0 ? starts : stations.filter((s) => norm(s.name).includes(q));
  if (contains.length > 0) {
    // Shortest name is the least-qualified (best) match: "Harvard" over "Harvard Ave".
    contains.sort((a, b) => a.name.length - b.name.length);
    return { id: contains[0].id, name: contains[0].name };
  }

  const suggestions = stations
    .map((s) => s.name)
    .filter((n) => q.length >= 3 && norm(n).slice(0, 3) === q.slice(0, 3))
    .slice(0, 5);
  throw new Error(
    `MBTA: no station matched "${input}". Pass an MBTA station name (e.g. "South Station", "Harvard") or a place id like "place-sstat".${suggestions.length ? ` Close names: ${suggestions.join(', ')}.` : ''} Use mbta_stops({ route }) to list a line's stations.`,
  );
}

// ---------------------------------------------------------------------------
// mbta_departures

interface Departure {
  route: string;
  route_name?: string;
  headsign?: string;
  direction_id: number;
  arrival_time: string | null;
  departure_time: string | null;
  minutes_away: number | null;
  status?: string | null;
  platform?: string | null;
  track?: string | null;
}

function clampLimit(v: unknown, def: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : def;
}

async function departures(args: Record<string, unknown>, apiKey?: string) {
  const stopInput = String(args.stop ?? args.station ?? '').trim();
  if (!stopInput) {
    throw new Error('mbta_departures requires a stop, e.g. { stop: "South Station" } or { stop: "place-sstat" }.');
  }
  const limit = clampLimit(args.limit, 8, 30);
  const route = args.route ? String(args.route).trim() : undefined;
  const directionId = args.direction_id != null ? Number(args.direction_id) : undefined;

  const stop = await resolveStop(stopInput, apiKey);

  const params = new URLSearchParams({
    'filter[stop]': stop.id,
    include: 'route,trip,stop',
    sort: 'departure_time',
    'page[limit]': String(Math.min(limit * 4, 60)), // over-fetch: cancelled/skipped rows get filtered
  });
  if (route) params.set('filter[route]', route);
  if (directionId === 0 || directionId === 1) params.set('filter[direction_id]', String(directionId));

  const doc = await api('/predictions', params, apiKey);
  const inc = indexIncluded(doc);

  const shape = (p: JsonApiResource): Departure | null => {
    const a = p.attributes as {
      arrival_time: string | null;
      departure_time: string | null;
      direction_id: number;
      status?: string | null;
      schedule_relationship?: string | null;
    };
    // null arrival AND null departure = the vehicle skips this stop (or the trip is cancelled)
    if (!a.arrival_time && !a.departure_time) return null;
    if (a.schedule_relationship === 'CANCELLED' || a.schedule_relationship === 'SKIPPED') return null;
    const routeRes = inc.get(`route:${relId(p, 'route') ?? ''}`);
    const tripRes = inc.get(`trip:${relId(p, 'trip') ?? ''}`);
    const stopRes = inc.get(`stop:${relId(p, 'stop') ?? ''}`);
    const ra = routeRes?.attributes as { long_name?: string; short_name?: string } | undefined;
    return {
      route: relId(p, 'route') ?? '',
      route_name: ra?.long_name || ra?.short_name,
      headsign: (tripRes?.attributes as { headsign?: string } | undefined)?.headsign,
      direction_id: a.direction_id,
      arrival_time: a.arrival_time,
      departure_time: a.departure_time,
      minutes_away: minutesAway(a.arrival_time ?? a.departure_time),
      status: a.status ?? undefined,
      platform: (stopRes?.attributes as { platform_name?: string } | undefined)?.platform_name ?? undefined,
      track: (stopRes?.attributes as { platform_code?: string } | undefined)?.platform_code ?? undefined,
    };
  };

  let rows = doc.data.map(shape).filter((d): d is Departure => d !== null);
  rows.sort((x, y) => (x.minutes_away ?? 9999) - (y.minutes_away ?? 9999));
  rows = rows.slice(0, limit);

  let source: 'prediction' | 'schedule' = 'prediction';
  if (rows.length === 0) {
    // No live predictions (commuter rail off-peak, late night) — published schedule for the next hour.
    source = 'schedule';
    rows = await scheduleFallback(stop.id, { route, directionId, limit }, apiKey);
  }

  return {
    stop_id: stop.id,
    stop_name: stop.name,
    source,
    note:
      source === 'schedule'
        ? 'No live predictions right now — showing the published schedule for the next hour (times are scheduled, not real-time).'
        : undefined,
    count: rows.length,
    departures: rows,
  };
}

async function scheduleFallback(
  stopId: string,
  opts: { route?: string; directionId?: number; limit: number },
  apiKey?: string,
): Promise<Departure[]> {
  const now = bostonNow();
  const [h, m] = now.time.split(':').map(Number);
  const endH = h + 1;
  // The API accepts hours >24 for post-midnight service on the same service date.
  const maxTime = `${String(endH).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

  const params = new URLSearchParams({
    'filter[stop]': stopId,
    'filter[date]': now.date,
    'filter[min_time]': now.time,
    'filter[max_time]': maxTime,
    include: 'route,trip',
    sort: 'departure_time',
    // Over-fetch: arrival-only rows sort as nulls upstream; we re-sort by minutes_away below.
    'page[limit]': String(Math.min(opts.limit * 2, 40)),
  });
  if (opts.route) params.set('filter[route]', opts.route);
  if (opts.directionId === 0 || opts.directionId === 1) {
    params.set('filter[direction_id]', String(opts.directionId));
  }

  const doc = await api('/schedules', params, apiKey);
  const inc = indexIncluded(doc);
  const rows: Departure[] = [];
  for (const s of doc.data) {
    const a = s.attributes as {
      arrival_time: string | null;
      departure_time: string | null;
      direction_id: number;
    };
    if (!a.arrival_time && !a.departure_time) continue;
    const routeRes = inc.get(`route:${relId(s, 'route') ?? ''}`);
    const tripRes = inc.get(`trip:${relId(s, 'trip') ?? ''}`);
    const ra = routeRes?.attributes as { long_name?: string; short_name?: string } | undefined;
    rows.push({
      route: relId(s, 'route') ?? '',
      route_name: ra?.long_name || ra?.short_name,
      headsign: (tripRes?.attributes as { headsign?: string } | undefined)?.headsign,
      direction_id: a.direction_id,
      arrival_time: a.arrival_time,
      departure_time: a.departure_time,
      minutes_away: minutesAway(a.departure_time ?? a.arrival_time),
    });
  }
  rows.sort((x, y) => (x.minutes_away ?? 9999) - (y.minutes_away ?? 9999));
  return rows.slice(0, opts.limit);
}

// ---------------------------------------------------------------------------
// mbta_routes

async function routes(args: Record<string, unknown>, apiKey?: string) {
  const type = String(args.type ?? '0,1,2,4').replace(/\s+/g, '');
  if (!/^[0-4](,[0-4])*$/.test(type)) {
    throw new Error('mbta_routes: type must be comma-separated digits 0-4, e.g. "0,1" (subway) or "2" (commuter rail) or "3" (bus).');
  }
  const doc = await api('/routes', new URLSearchParams({ 'filter[type]': type }), apiKey);
  return {
    type_filter: type,
    count: doc.data.length,
    routes: doc.data.map((r) => {
      const a = r.attributes as {
        long_name?: string;
        short_name?: string;
        type: number;
        direction_destinations?: string[];
        direction_names?: string[];
      };
      return {
        id: r.id,
        name: a.long_name || a.short_name,
        short_name: a.short_name || undefined,
        type: a.type,
        type_label: ROUTE_TYPE_LABELS[a.type] ?? String(a.type),
        direction_destinations: a.direction_destinations,
        direction_names: a.direction_names,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// mbta_stops

async function stops(args: Record<string, unknown>, apiKey?: string) {
  const route = String(args.route ?? '').trim();
  if (!route) throw new Error('mbta_stops requires a route id, e.g. { route: "Red" } — see mbta_routes for ids.');
  const doc = await api('/stops', new URLSearchParams({ 'filter[route]': route }), apiKey);
  if (doc.data.length === 0) {
    throw new Error(`MBTA: no stops found for route "${route}". Route ids are case-sensitive, e.g. "Red", "Green-B", "CR-Providence", "66" — list them with mbta_routes.`);
  }
  return {
    route,
    count: doc.data.length,
    stops: doc.data.map((s) => {
      const a = s.attributes as { name?: string; municipality?: string; wheelchair_boarding?: number };
      return {
        id: s.id,
        name: a.name,
        municipality: a.municipality,
        wheelchair_boarding: WHEELCHAIR_LABELS[a.wheelchair_boarding ?? 0] ?? 'unknown',
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// mbta_alerts

async function alerts(args: Record<string, unknown>, apiKey?: string) {
  const limit = clampLimit(args.limit, 15, 50);
  const params = new URLSearchParams({ 'filter[datetime]': 'NOW' });
  const route = args.route ? String(args.route).trim() : undefined;
  if (route) params.set('filter[route]', route);

  const doc = await api('/alerts', params, apiKey);
  const shaped = doc.data.slice(0, limit).map((al) => {
    const a = al.attributes as {
      header?: string;
      effect?: string;
      severity?: number;
      description?: string | null;
      active_period?: Array<{ start?: string | null; end?: string | null }>;
      informed_entity?: Array<{ route?: string }>;
      updated_at?: string;
    };
    const desc = (a.description ?? '').trim();
    const routesAffected = [...new Set((a.informed_entity ?? []).map((e) => e.route).filter(Boolean))];
    return {
      id: al.id,
      effect: a.effect,
      severity: a.severity,
      header: a.header,
      description: desc ? (desc.length > 300 ? `${desc.slice(0, 300)}…` : desc) : undefined,
      routes: routesAffected.length ? routesAffected : undefined,
      active_period: (a.active_period ?? []).slice(0, 3),
      updated_at: a.updated_at,
    };
  });
  return {
    route: route ?? 'all',
    count: doc.data.length,
    note: doc.data.length === 0 ? `No active MBTA alerts${route ? ` for route ${route}` : ''} right now.` : undefined,
    alerts: shaped,
  };
}

// ---------------------------------------------------------------------------

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const apiKey = typeof args._apiKey === 'string' && args._apiKey.trim() ? args._apiKey.trim() : undefined;
  delete args._apiKey;
  switch (name) {
    case 'mbta_departures':
      return departures(args, apiKey);
    case 'mbta_routes':
      return routes(args, apiKey);
    case 'mbta_stops':
      return stops(args, apiKey);
    case 'mbta_alerts':
      return alerts(args, apiKey);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
