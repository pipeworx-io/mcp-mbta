# mcp-mbta

MBTA MCP — Boston real-time transit via the MBTA v3 API (api-v3.mbta.com)

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `mbta_departures` | Real-time MBTA train arrival and departure predictions at a Boston station — answers "when is the next train Boston", next Red Line subway at South Station, Green Line trolley, commuter rail departures, Silver Line and bus arrivals. Accepts a station name ("South Station", "Harvard") or a place id ("place-sstat"). Falls back to the published schedule when live predictions are empty (common for commuter rail off-peak). Example: mbta_departures({ stop: "South Station", route: "Red" }) |
| `mbta_routes` | List MBTA routes for the Boston subway T, commuter rail, bus, and ferry — route ids, names, and the destination each direction heads toward. type: 0-1 subway/light rail (Red, Orange, Blue, Green, Mattapan), 2 commuter rail, 3 bus (includes Silver Line), 4 ferry. Default returns subway + commuter rail + ferry; pass type 3 for buses. Example: mbta_routes({ type: "2" }) |
| `mbta_stops` | List the stops and stations on an MBTA route — Boston subway T lines, commuter rail lines, bus routes, ferries. Returns stop id, name, municipality, and wheelchair accessibility, in route order. Example: mbta_stops({ route: "Red" }) or mbta_stops({ route: "CR-Worcester" }) |
| `mbta_alerts` | Active MBTA service alerts — Boston subway T delays, commuter rail disruptions, shuttle replacements, track changes, detours, elevator outages. Filter by route to check one line, e.g. is the Red Line delayed right now. Example: mbta_alerts({ route: "Red" }) |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "mbta": {
      "url": "https://gateway.pipeworx.io/mbta/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/mbta/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Mbta data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
