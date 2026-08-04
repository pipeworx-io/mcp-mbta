# mcp-mbta

MBTA MCP — Boston real-time transit via the MBTA v3 API (api-v3.mbta.com)

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Mbta data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
