export class EmoteAndBadgeManager {
  constructor(backendUrl) {
    this.backendUrl = backendUrl;
    this.twitchBadges = null;
    this.sevenTvEmotes = new Map();
  }

  reset() {
    this.twitchBadges = null;
    this.sevenTvEmotes = new Map();
  }

  resolveSevenTvEmoteUrl(emoteData) {
    const host = emoteData?.data?.host;
    const files = Array.isArray(host?.files) ? host.files : [];
    const baseUrl = host?.url
      ? host.url.startsWith("http")
        ? host.url
        : `https:${host.url}`
      : "";

    if (baseUrl) {
      const preferred =
        files.find((f) => f.name === "2x.webp") ||
        files.find((f) => f.name === "1x.webp") ||
        files.find((f) => f.name === "2x.avif") ||
        files.find((f) => f.name === "1x.avif") ||
        files[0];

      return preferred?.name
        ? `${baseUrl}/${preferred.name}`
        : `${baseUrl}/2x.webp`;
    }

    return emoteData?.id
      ? `https://cdn.7tv.app/emote/${emoteData.id}/2x.webp`
      : "";
  }

  indexSevenTvEmoteList(emotes = [], targetMap) {
    for (const item of emotes) {
      const code = String(item?.name || "").trim();
      const url = this.resolveSevenTvEmoteUrl(item);
      if (code && url && !targetMap.has(code)) {
        targetMap.set(code, url);
      }
    }
  }

  async loadSevenTvEmotes(broadcasterId = "", isSessionValid = () => true) {
    const nextMap = new Map();

    try {
      const globalRes = await fetch("https://7tv.io/v3/emote-sets/global");
      if (globalRes.ok) {
        const globalJson = await globalRes.json();
        this.indexSevenTvEmoteList(globalJson?.emotes, nextMap);
      }
    } catch (_) {}

    if (broadcasterId) {
      try {
        const userRes = await fetch(
          `https://7tv.io/v3/users/twitch/${encodeURIComponent(broadcasterId)}`,
        );
        if (userRes.ok) {
          const userJson = await userRes.json();
          this.indexSevenTvEmoteList(userJson?.emote_set?.emotes, nextMap);
        }
      } catch (_) {}
    }

    if (isSessionValid()) {
      this.sevenTvEmotes = nextMap;
    }
  }

  async loadChannelMetadata(twitchChannel, isSessionValid = () => true) {
    this.reset();
    if (!twitchChannel) return;

    try {
      const res = await fetch(
        `${this.backendUrl}/api/badges?channel=${encodeURIComponent(twitchChannel)}&global=true`,
        { cache: "default" },
      );
      if (!isSessionValid()) return;

      if (!res.ok) {
        await this.loadSevenTvEmotes("", isSessionValid);
        return;
      }

      const json = await res.json();
      if (!isSessionValid()) return;

      if (json?.ok && json?.badges) {
        this.twitchBadges = json.badges;
      }
      await this.loadSevenTvEmotes(json?.broadcasterId || "", isSessionValid);
    } catch (_) {
      await this.loadSevenTvEmotes("", isSessionValid);
    }
  }

  resolveOfficialBadge(setName, preferredVersions = []) {
    const badgeSet = this.twitchBadges?.[setName];
    if (!badgeSet) return null;

    for (const ver of preferredVersions) {
      if (!ver) continue;
      const item = badgeSet[String(ver)];
      if (item?.url2x || item?.url1x) {
        return {
          url: item.url2x || item.url1x,
          title: item.title || setName,
        };
      }
    }

    const keys = Object.keys(badgeSet).sort((a, b) => Number(a) - Number(b));
    if (keys.length > 0) {
      const first = badgeSet[keys[0]];
      if (first?.url2x || first?.url1x) {
        return {
          url: first.url2x || first.url1x,
          title: first.title || setName,
        };
      }
    }

    return null;
  }

  parseTwitchEmotePositions(rawEmotesTag, text, theme = "dark") {
    if (!rawEmotesTag || !text) return [];
    const placements = [];
    const emoteTheme = theme === "light" ? "light" : "dark";
    const groups = String(rawEmotesTag).split("/");

    for (const group of groups) {
      const colonIdx = group.indexOf(":");
      if (colonIdx === -1) continue;
      const emoteId = group.slice(0, colonIdx);
      const rangesPart = group.slice(colonIdx + 1);
      if (!emoteId || !rangesPart) continue;

      for (const range of rangesPart.split(",")) {
        const dashIdx = range.indexOf("-");
        if (dashIdx === -1) continue;
        const start = Number(range.slice(0, dashIdx));
        const end = Number(range.slice(dashIdx + 1));
        if (
          !Number.isInteger(start) ||
          !Number.isInteger(end) ||
          start < 0 ||
          end < start ||
          end >= text.length
        ) {
          continue;
        }
        placements.push({
          start,
          end: end + 1,
          code: text.slice(start, end + 1),
          url: `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(emoteId)}/default/${emoteTheme}/2.0`,
        });
      }
    }

    placements.sort((a, b) => a.start - b.start);
    return placements;
  }

  createEmoteImage(url, code) {
    const img = document.createElement("img");
    img.className = "chat-emote";
    img.src = url;
    img.alt = code;
    img.title = code;
    img.loading = "lazy";
    img.decoding = "async";
    img.onerror = () => {
      const fallbackSpan = document.createElement("span");
      fallbackSpan.textContent = code;
      img.replaceWith(fallbackSpan);
    };
    return img;
  }

  appendTextWithSevenTvEmotes(container, plainSegment) {
    if (!this.sevenTvEmotes || this.sevenTvEmotes.size === 0) {
      container.appendChild(document.createTextNode(plainSegment));
      return;
    }

    const tokens = String(plainSegment).split(/(\s+)/);
    for (const token of tokens) {
      if (!token) continue;
      if (/^\s+$/.test(token)) {
        container.appendChild(document.createTextNode(token));
        continue;
      }

      const emoteUrl = this.sevenTvEmotes.get(token);
      if (emoteUrl) {
        container.appendChild(this.createEmoteImage(emoteUrl, token));
      } else {
        container.appendChild(document.createTextNode(token));
      }
    }
  }

  appendFormattedMessageText(
    container,
    text,
    twitchEmotesRaw = "",
    theme = "dark",
  ) {
    const rawText = String(text || "");
    const twitchPlacements = this.parseTwitchEmotePositions(
      twitchEmotesRaw,
      rawText,
      theme,
    );

    if (!twitchPlacements.length) {
      this.appendTextWithSevenTvEmotes(container, rawText);
      return;
    }

    let cursor = 0;
    for (const item of twitchPlacements) {
      if (item.start < cursor) continue;
      if (item.start > cursor) {
        this.appendTextWithSevenTvEmotes(
          container,
          rawText.slice(cursor, item.start),
        );
      }
      container.appendChild(this.createEmoteImage(item.url, item.code));
      cursor = item.end;
    }

    if (cursor < rawText.length) {
      this.appendTextWithSevenTvEmotes(container, rawText.slice(cursor));
    }
  }
}
