interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
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
  const res = await fetch(`${BASE_URL}${path}?${params}`, { headers });
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
