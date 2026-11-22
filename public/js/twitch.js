export class TwitchIrcClient {
  constructor({ onStatusChange, onMessage }) {
    this.onStatusChange = onStatusChange;
    this.onMessage = onMessage;
    this.ws = null;
    this.retryTimer = null;
    this.backoff = 1500;
    this.sessionToken = 0;
  }

  disconnect() {
    this.sessionToken += 1;
    clearTimeout(this.retryTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
  }

  connect(channelName) {
    this.disconnect();
    const currentToken = this.sessionToken;

    if (!channelName) {
      this.onStatusChange?.("offline");
      return;
    }

    this.backoff = 1500;
    this.attemptConnection(channelName, currentToken);
  }

  attemptConnection(channelName, token) {
    if (token !== this.sessionToken) return;
    this.onStatusChange?.("connecting");

    const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    this.ws = ws;

    ws.onopen = () => {
      if (token !== this.sessionToken) {
        ws.close();
        return;
      }
      const anonNick = `justinfan${Math.floor(10000 + Math.random() * 89999)}`;
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      ws.send("PASS SCHMOOPIIE");
      ws.send(`NICK ${anonNick}`);
      ws.send(`JOIN #${channelName}`);
    };

    ws.onmessage = (event) => {
      if (token !== this.sessionToken) return;
      const lines = event.data.split("\r\n");

      for (const rawLine of lines) {
        if (!rawLine) continue;
        if (rawLine.startsWith("PING")) {
          ws.send(rawLine.replace("PING", "PONG"));
          continue;
        }
        if (
          rawLine.includes(" 001 ") ||
          rawLine.includes(` JOIN #${channelName}`)
        ) {
          this.backoff = 1500;
          this.onStatusChange?.("connected");
        }
        if (rawLine.includes(" PRIVMSG ")) {
          const parsed = this.parsePrivmsg(rawLine);
          if (parsed) {
            this.onStatusChange?.("connected");
            this.onMessage?.(parsed);
          }
        } else if (rawLine.includes(" USERNOTICE ")) {
          const parsedNotice = this.parseUsernotice(rawLine);
          if (parsedNotice) {
            this.onStatusChange?.("connected");
            this.onMessage?.(parsedNotice);
          }
        }
      }
    };

    ws.onerror = () => ws.close();

    ws.onclose = () => {
      if (token !== this.sessionToken) return;
      this.onStatusChange?.("connecting");
      this.retryTimer = setTimeout(() => {
        if (token !== this.sessionToken) return;
        this.backoff = Math.min(this.backoff * 1.5, 15000);
        this.attemptConnection(channelName, token);
      }, this.backoff);
    };
  }

  parseTags(rawTagPart) {
    const tags = {};
    for (const pair of rawTagPart.split(";")) {
      const eq = pair.indexOf("=");
      if (eq !== -1) {
        tags[pair.slice(0, eq)] = pair.slice(eq + 1).replace(/\\s/g, " ");
      }
    }
    return tags;
  }

  extractSubBadgeInfo(badges) {
    const match = badges.match(/(subscriber|founder)\/([^,\s]+)/);
    if (!match) {
      return { subSet: "subscriber", subVersion: "", subMonths: 1 };
    }
    const subSet = match[1];
    const subVersion = match[2];
    const numericVersion = Number(subVersion);
    const subMonths =
      Number.isFinite(numericVersion) && numericVersion > 0
        ? numericVersion >= 2000
          ? numericVersion % 1000 || 1
          : numericVersion
        : 1;
    return { subSet, subVersion, subMonths };
  }

  parsePrivmsg(line) {
    let idx = 0;
    let tags = {};

    if (line[0] === "@") {
      const spaceIdx = line.indexOf(" ");
      tags = this.parseTags(line.slice(1, spaceIdx));
      idx = spaceIdx + 1;
    }

    let login = "";
    if (line[idx] === ":") {
      const exclIdx = line.indexOf("!", idx);
      const spaceIdx = line.indexOf(" ", idx);
      if (exclIdx !== -1 && exclIdx < spaceIdx) {
        login = line.slice(idx + 1, exclIdx);
      }
      idx = spaceIdx + 1;
    }

    const msgMarker = line.indexOf(" :", idx);
    if (msgMarker === -1) return null;

    let text = line.slice(msgMarker + 2);
    if (text.startsWith("\u0001ACTION ") && text.endsWith("\u0001")) {
      text = text.slice(8, -1);
    }

    const badges = tags["badges"] || "";
    const isBroadcaster = badges.includes("broadcaster/");
    const isSub =
      tags["subscriber"] === "1" ||
      badges.includes("subscriber/") ||
      badges.includes("founder/");
    const { subSet, subVersion, subMonths } = this.extractSubBadgeInfo(badges);
    const isMod =
      isBroadcaster || tags["mod"] === "1" || badges.includes("moderator/");
    const isVip = badges.includes("vip/");
    const bits = Number(tags["bits"] || 0);
    const isDonate = bits > 0;

    return {
      id: tags["id"] ? `tw-${tags["id"]}` : undefined,
      platform: "twitch",
      username: tags["display-name"] || login || "Usuário",
      color: tags["color"] || "",
      text,
      twitchEmotes: tags["emotes"] || "",
      isSub,
      subSet,
      subVersion,
      subMonths,
      isMod,
      isBroadcaster,
      isVip,
      isDonate,
      donateLabel: isDonate ? `${bits} BITS` : "",
    };
  }

  parseUsernotice(line) {
    if (line[0] !== "@") return null;
    const spaceIdx = line.indexOf(" ");
    const tags = this.parseTags(line.slice(1, spaceIdx));
    const msgId = tags["msg-id"] || "";

    const validEvents = new Set([
      "sub",
      "resub",
      "subgift",
      "submysterygift",
      "giftpaidupgrade",
      "primepaidupgrade",
    ]);
    if (!validEvents.has(msgId)) return null;

    const msgMarker = line.indexOf(" :", spaceIdx + 1);
    const userMessage =
      msgMarker !== -1 ? line.slice(msgMarker + 2).trim() : "";
    const systemMsg = (tags["system-msg"] || "").trim();
    const months = Number(
      tags["msg-param-cumulative-months"] || tags["msg-param-months"] || 1,
    );
    const giftCount = Number(tags["msg-param-mass-gift-count"] || 1);
    const { subSet, subVersion } = this.extractSubBadgeInfo(
      tags["badges"] || "",
    );

    let donateLabel = "SUB";
    if (msgId === "resub") donateLabel = `RESUB ${months}M`;
    else if (msgId === "subgift") donateLabel = "GIFT SUB";
    else if (msgId === "submysterygift") donateLabel = `${giftCount} GIFT SUBS`;

    const text = userMessage
      ? `${systemMsg} — "${userMessage}"`
      : systemMsg || "Assinou o canal!";

    return {
      id: tags["id"]
        ? `tw-notice-${tags["id"]}`
        : `tw-notice-${Date.now()}-${Math.random()}`,
      platform: "twitch",
      username: tags["display-name"] || tags["login"] || "Inscrito",
      color: tags["color"] || "#fbbf24",
      text,
      twitchEmotes: tags["emotes"] || "",
      isSub: true,
      subSet,
      subVersion,
      subMonths: months,
      isMod: false,
      isBroadcaster: false,
      isVip: false,
      isDonate: true,
      donateLabel,
    };
  }
}
