export interface JellyfinItem {
  Id: string;
  Name: string;
  Type: string;
  Overview?: string;
  Genres?: string[];
  CommunityRating?: number;
  OfficialRating?: string;
  RunTimeTicks?: number;
  ProductionYear?: number;
  SeriesName?: string;
  SeasonName?: string;
  IndexNumber?: number;       // episode/season number
  ParentIndexNumber?: number; // season number (for episodes)
  DateCreated?: string;
  UserData?: {
    PlaybackPositionTicks?: number;
    PlayCount?: number;
    Played?: boolean;
    IsFavorite?: boolean;
  };
}

export interface JellyfinItemsResponse {
  Items: JellyfinItem[];
  TotalRecordCount: number;
  StartIndex: number;
}

export interface JellyfinSession {
  Id: string;
  UserId?: string;
  UserName?: string;
  DeviceName?: string;
  DeviceId?: string;
  Client?: string;
  IsActive?: boolean;
  SupportsRemoteControl?: boolean;
  SupportsMediaControl?: boolean;
  PlayState?: {
    PositionTicks?: number;
    CanSeek?: boolean;
    IsPaused?: boolean;
    IsMuted?: boolean;
    VolumeLevel?: number;
    AudioStreamIndex?: number;
    SubtitleStreamIndex?: number;
    PlayMethod?: string;
  };
  NowPlayingItem?: JellyfinItem;
  LastActivityDate?: string;
}

export interface JellyfinUser {
  Id: string;
  Name: string;
  HasPassword?: boolean;
  HasConfiguredPassword?: boolean;
  LastLoginDate?: string;
  LastActivityDate?: string;
  Policy?: {
    IsAdministrator?: boolean;
    IsDisabled?: boolean;
    EnableRemoteAccess?: boolean;
    MaxStreamingBitrate?: number;
  };
}

export interface JellyfinServerInfo {
  ServerName?: string;
  Version?: string;
  OperatingSystem?: string;
  Id?: string;
  ProductName?: string;
  HasUpdateAvailable?: boolean;
}

// PlayState commands accepted by POST /Sessions/{sessionId}/Playing/{command}
export type PlayStateCommand =
  | "Stop"
  | "Pause"
  | "Unpause"
  | "PlayPause"
  | "NextTrack"
  | "PreviousTrack"
  | "Seek"
  | "Rewind"
  | "FastForward";

type Params = Record<string, string | number | boolean | undefined>;

export class JellyfinClient {
  private baseUrl: string;
  private apiKey: string;
  private _userId: string | null;

  constructor(baseUrl: string, apiKey: string, userId?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this._userId = userId ?? null;
  }

  private get authHeaders(): Record<string, string> {
    return {
      "X-MediaBrowser-Token": this.apiKey,
      "Content-Type": "application/json",
    };
  }

  private async get<T>(path: string, params: Params = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url.toString(), { headers: this.authHeaders });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Jellyfin ${res.status} ${res.statusText}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  // POST with a JSON body — used for creating resources
  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.authHeaders,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Jellyfin ${res.status} ${res.statusText}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  // POST with all params in the query string (no body) — used for session control
  private async postQuery(path: string, params: Params = {}): Promise<void> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: this.authHeaders,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Jellyfin ${res.status} ${res.statusText}: ${text}`);
    }
  }

  async getUserId(): Promise<string> {
    if (this._userId) return this._userId;
    const users = await this.get<
      Array<{ Id: string; Name: string; Policy?: { IsAdministrator: boolean } }>
    >("/Users");
    if (!users.length) throw new Error("No users found on Jellyfin server");
    const admin = users.find((u) => u.Policy?.IsAdministrator);
    this._userId = (admin ?? users[0]).Id;
    return this._userId;
  }

  // ── Users ────────────────────────────────────────────────────────────────

  async getUsers(): Promise<JellyfinUser[]> {
    return this.get("/Users");
  }

  async createUser(name: string, password: string): Promise<JellyfinUser> {
    return this.postJson("/Users/New", { Name: name, Password: password });
  }

  // ── Server ───────────────────────────────────────────────────────────────

  async getServerInfo(): Promise<JellyfinServerInfo> {
    return this.get("/System/Info");
  }

  // ── Libraries ────────────────────────────────────────────────────────────

  async getLibraries(): Promise<JellyfinItemsResponse> {
    return this.get("/Library/MediaFolders");
  }

  // ── Items ────────────────────────────────────────────────────────────────

  // GET /Items — search with optional type filter
  async searchItems(
    searchTerm: string,
    includeItemTypes?: string,
    limit = 20
  ): Promise<JellyfinItemsResponse> {
    const userId = await this.getUserId();
    return this.get("/Items", {
      userId,
      searchTerm,
      includeItemTypes,
      limit,
      recursive: true,
      fields:
        "Overview,Genres,DateCreated,CommunityRating,OfficialRating,RunTimeTicks,ProductionYear",
    });
  }

  // GET /Items?ids={itemId}&userId={userId} — fetch single item details
  async getItem(itemId: string): Promise<JellyfinItem> {
    const userId = await this.getUserId();
    const result = await this.get<JellyfinItemsResponse>("/Items", {
      ids: itemId,
      userId,
      fields:
        "Overview,Genres,DateCreated,CommunityRating,OfficialRating,RunTimeTicks,MediaStreams,People,ProductionYear,UserData",
    });
    if (!result.Items.length) throw new Error(`Item ${itemId} not found`);
    return result.Items[0];
  }

  // GET /Items/Latest — recently added (userId as query param)
  async getLatestItems(parentId?: string, limit = 20): Promise<JellyfinItem[]> {
    const userId = await this.getUserId();
    return this.get("/Items/Latest", {
      userId,
      parentId,
      limit,
      fields: "Overview,DateCreated,CommunityRating,ProductionYear",
    });
  }

  // GET /UserItems/Resume — continue watching (userId as query param)
  async getResumeItems(limit = 10): Promise<JellyfinItemsResponse> {
    const userId = await this.getUserId();
    return this.get("/UserItems/Resume", {
      userId,
      limit,
      mediaTypes: "Video",
      fields: "Overview,RunTimeTicks,UserData",
    });
  }

  // ── TV Shows ─────────────────────────────────────────────────────────────

  async getSeasons(seriesId: string): Promise<JellyfinItemsResponse> {
    const userId = await this.getUserId();
    return this.get(`/Shows/${seriesId}/Seasons`, {
      userId,
      fields: "Overview,DateCreated,UserData",
    });
  }

  async getEpisodes(
    seriesId: string,
    seasonId?: string
  ): Promise<JellyfinItemsResponse> {
    const userId = await this.getUserId();
    return this.get(`/Shows/${seriesId}/Episodes`, {
      userId,
      seasonId,
      fields: "Overview,DateCreated,RunTimeTicks,UserData",
    });
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  async getSessions(): Promise<JellyfinSession[]> {
    return this.get("/Sessions");
  }

  // ── Remote control ───────────────────────────────────────────────────────

  // POST /Sessions/{sessionId}/Playing/{command}?seekPositionTicks=...
  // command goes in the PATH, seekPositionTicks goes in the QUERY STRING
  async sendPlayStateCommand(
    sessionId: string,
    command: PlayStateCommand,
    seekPositionTicks?: number
  ): Promise<void> {
    const params: Params = {};
    if (command === "Seek" && seekPositionTicks !== undefined) {
      params.seekPositionTicks = seekPositionTicks;
    }
    return this.postQuery(`/Sessions/${sessionId}/Playing/${command}`, params);
  }

  // POST /Sessions/{sessionId}/Playing — ALL params are query string, NO body
  async playItem(
    sessionId: string,
    itemIds: string[],
    startPositionTicks = 0
  ): Promise<void> {
    return this.postQuery(`/Sessions/${sessionId}/Playing`, {
      playCommand: "PlayNow",
      itemIds: itemIds.join(","),
      startPositionTicks,
    });
  }
}

// ── Formatting helpers ───────────────────────────────────────────────────────

export function formatRuntime(ticks?: number): string {
  if (!ticks) return "Unknown";
  const minutes = Math.round(ticks / 10_000_000 / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function formatProgress(
  positionTicks?: number,
  totalTicks?: number
): string {
  if (!positionTicks) return "";
  const pos = formatRuntime(positionTicks);
  const total = totalTicks ? ` / ${formatRuntime(totalTicks)}` : "";
  return `${pos}${total}`;
}

export function formatItem(item: JellyfinItem, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : "";
  const year = item.ProductionYear ? ` (${item.ProductionYear})` : "";
  const type = item.Type ? ` [${item.Type}]` : "";
  let line = `${prefix}${item.Name}${year}${type} — ID: ${item.Id}`;

  const details: string[] = [];
  if (item.CommunityRating) details.push(`★ ${item.CommunityRating.toFixed(1)}`);
  if (item.OfficialRating) details.push(item.OfficialRating);
  if (item.RunTimeTicks) details.push(formatRuntime(item.RunTimeTicks));
  if (item.Genres?.length) details.push(item.Genres.join(", "));
  if (details.length) line += `\n   ${details.join(" | ")}`;

  if (item.Overview) {
    const summary =
      item.Overview.length > 200
        ? item.Overview.slice(0, 197) + "..."
        : item.Overview;
    line += `\n   ${summary}`;
  }

  return line;
}
