import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import {
  JellyfinClient,
  PlayStateCommand,
  formatItem,
  formatRuntime,
  formatProgress,
} from "./jellyfin.js";

// ── Config ───────────────────────────────────────────────────────────────────

const JELLYFIN_URL = process.env.JELLYFIN_URL;
const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY;
const JELLYFIN_USER_ID = process.env.JELLYFIN_USER_ID;
const PORT = process.env.PORT ?? "3000";

if (!JELLYFIN_URL || !JELLYFIN_API_KEY) {
  console.error(
    "Error: JELLYFIN_URL and JELLYFIN_API_KEY environment variables are required."
  );
  process.exit(1);
}

const jellyfin = new JellyfinClient(JELLYFIN_URL, JELLYFIN_API_KEY, JELLYFIN_USER_ID);

// ── MCP server factory ───────────────────────────────────────────────────────

function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: "jellyfin-mcp",
    version: "1.0.0",
  });

  // ── get_server_info ───────────────────────────────────────────────────────
  server.tool(
    "get_server_info",
    "Get Jellyfin server name, version, and OS",
    {},
    async () => {
      const info = await jellyfin.getServerInfo();
      const text = [
        `Server: ${info.ServerName ?? "Unknown"}`,
        `Version: ${info.Version ?? "Unknown"}`,
        `OS: ${info.OperatingSystem ?? "Unknown"}`,
        `ID: ${info.Id ?? "Unknown"}`,
      ].join("\n");
      return { content: [{ type: "text", text }] };
    }
  );

  // ── get_libraries ─────────────────────────────────────────────────────────
  server.tool(
    "get_libraries",
    "List all media libraries (Movies, TV Shows, Music, etc.) with their IDs",
    {},
    async () => {
      const result = await jellyfin.getLibraries();
      if (!result.Items.length) {
        return { content: [{ type: "text", text: "No libraries found." }] };
      }
      const lines = result.Items.map(
        (lib) => `• ${lib.Name} [${lib.Type}] — ID: ${lib.Id}`
      );
      return {
        content: [{ type: "text", text: `Libraries:\n${lines.join("\n")}` }],
      };
    }
  );

  // ── search_media ──────────────────────────────────────────────────────────
  server.tool(
    "search_media",
    "Search the Jellyfin library for movies, TV shows, episodes, music, etc.",
    {
      query: z.string().describe("Search term"),
      type: z
        .enum(["Movie", "Series", "Episode", "MusicAlbum", "MusicArtist", "Audio", ""])
        .optional()
        .describe(
          "Filter by item type. Leave empty to search all types."
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Max results to return (default 10)"),
    },
    async ({ query, type, limit }) => {
      const result = await jellyfin.searchItems(query, type || undefined, limit);
      if (!result.Items.length) {
        return {
          content: [{ type: "text", text: `No results for "${query}".` }],
        };
      }
      const lines = result.Items.map((item, i) => formatItem(item, i));
      return {
        content: [
          {
            type: "text",
            text: `Found ${result.TotalRecordCount} result(s) for "${query}" (showing ${result.Items.length}):\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    }
  );

  // ── get_item ──────────────────────────────────────────────────────────────
  server.tool(
    "get_item",
    "Get full details for a specific media item by its Jellyfin ID",
    {
      item_id: z.string().describe("Jellyfin item ID"),
    },
    async ({ item_id }) => {
      const item = await jellyfin.getItem(item_id);
      const details: string[] = [formatItem(item)];

      if (item.SeriesName) {
        details.push(
          `Series: ${item.SeriesName}` +
            (item.ParentIndexNumber ? ` S${item.ParentIndexNumber}` : "") +
            (item.IndexNumber ? `E${item.IndexNumber}` : "")
        );
      }
      if (item.DateCreated) {
        details.push(`Added: ${new Date(item.DateCreated).toLocaleDateString()}`);
      }
      if (item.UserData) {
        const ud = item.UserData;
        if (ud.PlayCount) details.push(`Play count: ${ud.PlayCount}`);
        if (ud.Played) details.push("Status: Watched");
        if (ud.PlaybackPositionTicks && !ud.Played) {
          details.push(`Progress: ${formatRuntime(ud.PlaybackPositionTicks)} watched`);
        }
      }

      return { content: [{ type: "text", text: details.join("\n") }] };
    }
  );

  // ── get_latest ────────────────────────────────────────────────────────────
  server.tool(
    "get_latest",
    "Get recently added items, optionally filtered to a specific library",
    {
      library_id: z
        .string()
        .optional()
        .describe("Library ID to filter by (from get_libraries). Omit for all libraries."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Max results (default 10)"),
    },
    async ({ library_id, limit }) => {
      const items = await jellyfin.getLatestItems(library_id, limit);
      if (!items.length) {
        return { content: [{ type: "text", text: "No recent items found." }] };
      }
      const lines = items.map((item, i) => formatItem(item, i));
      return {
        content: [
          {
            type: "text",
            text: `Recently added (${items.length}):\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    }
  );

  // ── get_resume_items ──────────────────────────────────────────────────────
  server.tool(
    "get_resume_items",
    "Get in-progress items the user has started but not finished (Continue Watching)",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Max results (default 10)"),
    },
    async ({ limit }) => {
      const result = await jellyfin.getResumeItems(limit);
      if (!result.Items.length) {
        return {
          content: [{ type: "text", text: "No in-progress items found." }],
        };
      }
      const lines = result.Items.map((item, i) => {
        const progress = formatProgress(
          item.UserData?.PlaybackPositionTicks,
          item.RunTimeTicks
        );
        return formatItem(item, i) + (progress ? `\n   Progress: ${progress}` : "");
      });
      return {
        content: [
          {
            type: "text",
            text: `Continue watching (${result.Items.length}):\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    }
  );

  // ── get_seasons ───────────────────────────────────────────────────────────
  server.tool(
    "get_seasons",
    "List all seasons for a TV series",
    {
      series_id: z.string().describe("Jellyfin series ID"),
    },
    async ({ series_id }) => {
      const result = await jellyfin.getSeasons(series_id);
      if (!result.Items.length) {
        return { content: [{ type: "text", text: "No seasons found." }] };
      }
      const lines = result.Items.map(
        (s) =>
          `• ${s.Name} — ID: ${s.Id}` +
          (s.UserData?.Played ? " ✓" : "") +
          (s.Overview ? `\n  ${s.Overview.slice(0, 120)}` : "")
      );
      return {
        content: [
          {
            type: "text",
            text: `Seasons (${result.TotalRecordCount}):\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    }
  );

  // ── get_episodes ──────────────────────────────────────────────────────────
  server.tool(
    "get_episodes",
    "List episodes for a TV series, optionally filtered to a specific season",
    {
      series_id: z.string().describe("Jellyfin series ID"),
      season_id: z
        .string()
        .optional()
        .describe("Season ID to filter by (from get_seasons). Omit to get all episodes."),
    },
    async ({ series_id, season_id }) => {
      const result = await jellyfin.getEpisodes(series_id, season_id);
      if (!result.Items.length) {
        return { content: [{ type: "text", text: "No episodes found." }] };
      }
      const lines = result.Items.map((ep) => {
        const s = ep.ParentIndexNumber ?? "?";
        const e = ep.IndexNumber ?? "?";
        const runtime = ep.RunTimeTicks ? ` | ${formatRuntime(ep.RunTimeTicks)}` : "";
        const watched = ep.UserData?.Played ? " ✓" : "";
        let line = `S${s}E${e} — ${ep.Name}${watched}${runtime} — ID: ${ep.Id}`;
        if (ep.Overview) line += `\n   ${ep.Overview.slice(0, 150)}`;
        return line;
      });
      return {
        content: [
          {
            type: "text",
            text: `Episodes (${result.TotalRecordCount}):\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    }
  );

  // ── get_sessions ──────────────────────────────────────────────────────────
  server.tool(
    "get_sessions",
    "Get active Jellyfin player sessions — who is watching what, and where",
    {},
    async () => {
      const sessions = await jellyfin.getSessions();
      const active = sessions.filter((s) => s.NowPlayingItem);
      const idle = sessions.filter((s) => !s.NowPlayingItem);

      const lines: string[] = [];

      if (active.length) {
        lines.push(`Active sessions (${active.length}):`);
        for (const s of active) {
          const np = s.NowPlayingItem!;
          const state = s.PlayState?.IsPaused ? "⏸ Paused" : "▶ Playing";
          const progress = formatProgress(
            s.PlayState?.PositionTicks,
            np.RunTimeTicks
          );
          lines.push(
            `\n• ${s.UserName ?? "Unknown"} on ${s.DeviceName ?? "Unknown"} (${s.Client ?? "?"})` +
              `\n  ${state}: ${np.Name}${progress}` +
              `\n  Session ID: ${s.Id}` +
              (s.SupportsRemoteControl ? "\n  (supports remote control)" : "")
          );
        }
      }

      if (idle.length) {
        lines.push(`\nIdle sessions (${idle.length}):`);
        for (const s of idle) {
          lines.push(`• ${s.UserName ?? "Unknown"} — ${s.DeviceName ?? "Unknown"} (${s.Client ?? "?"})`);
        }
      }

      if (!sessions.length) {
        return { content: [{ type: "text", text: "No active sessions." }] };
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ── control_playback ──────────────────────────────────────────────────────
  server.tool(
    "control_playback",
    "Send a playback command to a session (pause, resume, stop, skip). Use get_sessions first to get the session ID.",
    {
      session_id: z.string().describe("Session ID from get_sessions"),
      command: z
        .enum(["Stop", "Pause", "Unpause", "PlayPause", "NextTrack", "PreviousTrack", "Seek", "Rewind", "FastForward"])
        .describe("Playback command to send"),
      seek_seconds: z
        .number()
        .optional()
        .describe("Seek target in seconds (only used with Seek command)"),
    },
    async ({ session_id, command, seek_seconds }) => {
      const seekTicks =
        command === "Seek" && seek_seconds !== undefined
          ? seek_seconds * 10_000_000
          : undefined;
      await jellyfin.sendPlayStateCommand(session_id, command as PlayStateCommand, seekTicks);
      return {
        content: [
          {
            type: "text",
            text: `Sent "${command}" to session ${session_id}.`,
          },
        ],
      };
    }
  );

  // ── play_on_session ───────────────────────────────────────────────────────
  server.tool(
    "play_on_session",
    "Start playing a specific media item on a remote Jellyfin session",
    {
      session_id: z.string().describe("Session ID from get_sessions"),
      item_id: z.string().describe("Jellyfin item ID to play"),
      start_seconds: z
        .number()
        .optional()
        .default(0)
        .describe("Start position in seconds (default 0)"),
    },
    async ({ session_id, item_id, start_seconds }) => {
      await jellyfin.playItem(session_id, [item_id], (start_seconds ?? 0) * 10_000_000);
      return {
        content: [
          {
            type: "text",
            text: `Started playing item ${item_id} on session ${session_id}.`,
          },
        ],
      };
    }
  );

  return server;
}

// ── Express + SSE transport ──────────────────────────────────────────────────

const app = express();
const sessions = new Map<string, SSEServerTransport>();

app.get("/", (_req, res) => {
  res.json({
    name: "jellyfin-mcp",
    version: "1.0.0",
    status: "ok",
    tools: [
      "get_server_info",
      "get_libraries",
      "search_media",
      "get_item",
      "get_latest",
      "get_resume_items",
      "get_seasons",
      "get_episodes",
      "get_sessions",
      "control_playback",
      "play_on_session",
    ],
  });
});

app.get("/sse", async (_req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  sessions.set(transport.sessionId, transport);
  res.on("close", () => sessions.delete(transport.sessionId));

  const server = buildMcpServer();
  await server.connect(transport);
});

app.post("/messages", express.json(), async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = sessions.get(sessionId);
  if (!transport) {
    res.status(404).json({ error: "Session not found. Connect via /sse first." });
    return;
  }
  await transport.handlePostMessage(req, res);
});

app.listen(PORT, () => {
  console.log(`Jellyfin MCP server listening on port ${PORT}`);
  console.log(`Jellyfin: ${JELLYFIN_URL}`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
});
