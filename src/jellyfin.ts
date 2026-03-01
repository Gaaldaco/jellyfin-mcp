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
  IndexNumber?: number;       // Episode/season number
  ParentIndexNumber?: number; // Season number for episodes
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
  UserName?: string;
  DeviceName?: string;
  Client?: string;
  PlayState?: {
    PositionTicks?: number;
    CanSeek?: boolean;
    IsPaused?: boolean;
    IsMuted?: boolean;
    VolumeLevel?: number;
  };
  NowPlayingItem?: JellyfinItem;
  LastActivityDate?: string;
  SupportsRemoteControl?: boolean;
}

export interface JellyfinServerInfo {
  ServerName?: string;
  Version?: string;
  OperatingSystem?: string;
  Id?: string;
  StartupWizardCompleted?: boolean;
}

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

  private async post(path: string, body?: unknown): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.authHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
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

  // ── Server ───────────────────────────────────────────────────────────────

  async getServerInfo(): Promise<JellyfinServerInfo> {
    return this.get("/System/Info");
  }

  // ── Libraries ────────────────────────────────────────────────────────────

  async getLibraries(): Promise<JellyfinItemsResponse> {
    return this.get("/Library/MediaFolders");
  }

  // ── Items ────────────────────────────────────────────────────────────────

  async searchItems(
    searchTerm: string,
    includeItemTypes?: string,
    limit = 20
  ): Promise<JellyfinItemsResponse> {
    return this.get("/Items", {
      searchTerm,
      includeItemTypes,
      limit,
      recursive: true,
      fields:
        "Overview,Genres,DateCreated,CommunityRating,OfficialRating,RunTimeTicks,ProductionYear",
    });
  }

  async getItem(itemId: string): Promise<JellyfinItem> {
    const userId = await this.getUserId();
    return this.get(`/Users/${userId}/Items/${itemId}`, {
      fields:
        "Overview,Genres,DateCreated,CommunityRating,OfficialRating,RunTimeTicks,MediaStreams,People,ProductionYear,UserData",
    });
  }

  async getLatestItems(
    parentId?: string,
    limit = 20
  ): Promise<JellyfinItem[]> {
    const userId = await this.getUserId();
    return this.get(`/Users/${userId}/Items/Latest`, {
      parentId,
      limit,
      fields: "Overview,DateCreated,CommunityRating,ProductionYear",
    });
  }

  async getResumeItems(limit = 10): Promise<JellyfinItemsResponse> {
    const userId = await this.getUserId();
    return this.get(`/Users/${userId}/Items/Resume`, {
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
      seasonId,
      userId,
      fields: "Overview,DateCreated,RunTimeTicks,UserData",
    });
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  async getSessions(): Promise<JellyfinSession[]> {
    return this.get("/Sessions");
  }

  // ── Remote control ───────────────────────────────────────────────────────

  async sendPlayStateCommand(
    sessionId: string,
    command: "Pause" | "Unpause" | "Stop" | "NextTrack" | "PreviousTrack" | "Seek",
    seekPositionTicks?: number
  ): Promise<void> {
    const body: Record<string, unknown> = { Command: command };
    if (command === "Seek" && seekPositionTicks !== undefined) {
      body.SeekPositionTicks = seekPositionTicks;
    }
    return this.post(`/Sessions/${sessionId}/Playing/Unpause`, body).catch(
      () =>
        // Fallback: some clients use the GeneralCommand path
        this.post(`/Sessions/${sessionId}/Command`, { Name: command })
    );
  }

  async playItem(
    sessionId: string,
    itemIds: string[],
    startPositionTicks = 0
  ): Promise<void> {
    return this.post(`/Sessions/${sessionId}/Playing`, {
      PlayCommand: "PlayNow",
      ItemIds: itemIds,
      StartPositionTicks: startPositionTicks,
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
  return ` (${pos}${total})`;
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
    const summary = item.Overview.length > 200
      ? item.Overview.slice(0, 197) + "..."
      : item.Overview;
    line += `\n   ${summary}`;
  }

  return line;
}
