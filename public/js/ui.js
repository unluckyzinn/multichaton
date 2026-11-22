const FONT_SIZES = [
  { label: "P", size: "14px" },
  { label: "M", size: "16px" },
  { label: "G", size: "19px" },
  { label: "GG", size: "22px" },
];

const TWITCH_ICON_SVG = `<svg viewBox="0 0 24 24" fill="#9146ff" aria-hidden="true"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/></svg>`;
const KICK_ICON_SVG = `<svg viewBox="0 0 24 24" fill="#53fc18" aria-hidden="true"><path d="M3 2h6v7h2V6h2V3h7v6h-3v3h-3v2h3v3h3v5h-7v-3h-2v-3H9v6H3V2z"/></svg>`;
const MOD_BADGE_SVG = `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M12.8 1.5l1.7 1.7-6.4 6.4 1.4 1.4-1.2 1.2-1.4-1.4-3.7 3.7-1.4-1.4 3.7-3.7-1.4-1.4 1.2-1.2 1.4 1.4 6.1-6.5z"/></svg>`;
const VIP_BADGE_SVG = `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5l5.5 6.5L8 14.5 2.5 8 8 1.5z"/></svg>`;

function buildSubSwordSvg(subMonths = 1) {
  let bladeColor = "#c084fc";
  let guardColor = "#9146ff";
  let gemColor = "#f3e8ff";

  if (subMonths >= 12) {
    bladeColor = "#fde047";
    guardColor = "#d97706";
    gemColor = "#38bdf8";
  } else if (subMonths >= 3) {
    bladeColor = "#67e8f9";
    guardColor = "#0284c7";
    gemColor = "#f472b6";
  }

  return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.7 1.4l1.9 1.9-6.6 6.6-1.9-1.9 6.6-6.6z" fill="${bladeColor}"/><path d="M5.2 7.4l3.4 3.4-1.2 1.2-3.4-3.4 1.2-1.2z" fill="${guardColor}"/><circle cx="6.9" cy="9.1" r="1.1" fill="${gemColor}"/><path d="M4.3 10.3l1.4 1.4-2.8 2.8-1.4-1.4 2.8-2.8z" fill="#a855f7"/></svg>`;
}

export class ChatUIController {
  constructor({
    maxMessages = 250,
    emoteManager,
    onChannelSubmit,
    onRecentSelect,
    onRecentRemove,
    onPrefsChange,
  }) {
    this.maxMessages = maxMessages;
    this.emoteManager = emoteManager;
    this.onChannelSubmit = onChannelSubmit;
    this.onRecentSelect = onRecentSelect;
    this.onRecentRemove = onRecentRemove;
    this.onPrefsChange = onPrefsChange;

    this.theme = "dark";
    this.fontIdx = 1;
    this.activeFilters = new Set();
    this.autoScroll = true;
    this.wakeLock = null;
    this.seenIds = new Set();
    this.mentionTerms = [];
    this.kickStreamConnected = false;
    this.kickAuthorized = false;
    this.twitchEnabled = true;
    this.kickEnabled = true;

    this.el = {
      btnChannelPicker: document.getElementById("btn-channel-picker"),
      activeChannelLabel: document.getElementById("active-channel-label"),
      channelDrawer: document.getElementById("channel-drawer"),
      channelForm: document.getElementById("channel-form"),
      boxTwitch: document.getElementById("box-twitch"),
      boxKick: document.getElementById("box-kick"),
      inputTwitch: document.getElementById("input-twitch"),
      inputKick: document.getElementById("input-kick"),
      toggleTwitch: document.getElementById("toggle-twitch"),
      toggleKick: document.getElementById("toggle-kick"),
      btnKickOauth: document.getElementById("btn-kick-oauth"),
      kickAuthBanner: document.getElementById("kick-auth-banner"),
      kickAuthText: document.getElementById("kick-auth-text"),
      recentChannelsWrap: document.getElementById("recent-channels-wrap"),
      recentChannelsList: document.getElementById("recent-channels-list"),
      chatContainer: document.getElementById("chat-container"),
      scrollResume: document.getElementById("scroll-resume"),
      badgeTwitch: document.getElementById("badge-twitch"),
      badgeKick: document.getElementById("badge-kick"),
      badgeKickLabel: document.getElementById("badge-kick-label"),
      badgeLive: document.getElementById("badge-live"),
      liveLabel: document.getElementById("live-label"),
      btnTheme: document.getElementById("btn-theme"),
      iconSun: document.getElementById("icon-sun"),
      iconMoon: document.getElementById("icon-moon"),
      btnFont: document.getElementById("btn-font"),
      btnWakeLock: document.getElementById("btn-wakelock"),
      btnClear: document.getElementById("btn-clear"),
      filterAllBtn: document.getElementById("filter-all"),
      filterButtons: document.querySelectorAll(".filter-btn"),
      metaTheme: document.querySelector('meta[name="theme-color"]'),
    };

    this.bindEvents();
  }

  bindEvents() {
    this.el.btnChannelPicker.addEventListener("click", () =>
      this.toggleChannelDrawer(),
    );
    this.el.badgeKick.addEventListener("click", () =>
      this.toggleChannelDrawer(true),
    );

    this.el.toggleTwitch.addEventListener("click", () => {
      this.setPlatformEnabled("twitch", !this.twitchEnabled);
    });

    this.el.toggleKick.addEventListener("click", () => {
      this.setPlatformEnabled("kick", !this.kickEnabled);
    });

    this.el.channelForm.addEventListener("submit", (e) => {
      e.preventDefault();
      this.onChannelSubmit?.({
        twitch: this.el.inputTwitch.value,
        kick: this.el.inputKick.value,
        twitchEnabled: this.twitchEnabled,
        kickEnabled: this.kickEnabled,
      });
      this.toggleChannelDrawer(false);
    });

    this.el.chatContainer.addEventListener(
      "scroll",
      () => {
        const threshold = 60;
        const distanceFromBottom =
          this.el.chatContainer.scrollHeight -
          this.el.chatContainer.scrollTop -
          this.el.chatContainer.clientHeight;

        if (distanceFromBottom > threshold) {
          this.autoScroll = false;
          this.el.scrollResume.classList.add("visible");
        } else {
          this.autoScroll = true;
          this.el.scrollResume.classList.remove("visible");
        }
      },
      { passive: true },
    );

    this.el.scrollResume.addEventListener("click", () => {
      this.autoScroll = true;
      this.el.scrollResume.classList.remove("visible");
      this.el.chatContainer.scrollTop = this.el.chatContainer.scrollHeight;
    });

    this.el.filterButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const chosen = btn.dataset.filter;
        if (chosen === "all") {
          this.activeFilters.clear();
        } else if (this.activeFilters.has(chosen)) {
          this.activeFilters.delete(chosen);
        } else {
          this.activeFilters.add(chosen);
        }
        this.applyFilterToAll();
      });
    });

    this.el.btnTheme.addEventListener("click", () => {
      this.setTheme(this.theme === "dark" ? "light" : "dark");
      this.onPrefsChange?.();
    });

    this.el.btnFont.addEventListener("click", () => {
      this.setFontIndex((this.fontIdx + 1) % FONT_SIZES.length);
      this.onPrefsChange?.();
    });

    this.el.btnClear.addEventListener("click", () => this.clearMessages());
    this.el.btnWakeLock.addEventListener("click", () => this.toggleWakeLock());

    document.addEventListener("visibilitychange", async () => {
      if (
        document.visibilityState === "visible" &&
        this.el.btnWakeLock.classList.contains("active") &&
        !this.wakeLock
      ) {
        try {
          this.wakeLock = await navigator.wakeLock.request("screen");
        } catch (_) {}
      }
    });
  }

  setPlatformEnabled(platform, enabled) {
    const isEnabled = Boolean(enabled);
    if (platform === "twitch") {
      this.twitchEnabled = isEnabled;
      this.el.boxTwitch.classList.toggle("active", isEnabled);
      this.el.boxTwitch.classList.toggle("disabled", !isEnabled);
      this.el.inputTwitch.disabled = !isEnabled;
      this.el.toggleTwitch.classList.toggle("active", isEnabled);
      this.el.toggleTwitch.setAttribute("aria-pressed", String(isEnabled));
      this.el.toggleTwitch.textContent = isEnabled ? "ON" : "OFF";
    } else if (platform === "kick") {
      this.kickEnabled = isEnabled;
      this.el.boxKick.classList.toggle("active", isEnabled);
      this.el.boxKick.classList.toggle("disabled", !isEnabled);
      this.el.inputKick.disabled = !isEnabled;
      this.el.toggleKick.classList.toggle("active", isEnabled);
      this.el.toggleKick.setAttribute("aria-pressed", String(isEnabled));
      this.el.toggleKick.textContent = isEnabled ? "ON" : "OFF";
    }
  }

  setTheme(theme) {
    this.theme = theme === "light" ? "light" : "dark";
    const isLight = this.theme === "light";
    document.body.classList.toggle("light", isLight);
    this.el.iconSun.style.display = isLight ? "none" : "block";
    this.el.iconMoon.style.display = isLight ? "block" : "none";
    if (this.el.metaTheme) {
      this.el.metaTheme.setAttribute(
        "content",
        isLight ? "#ffffff" : "#09090b",
      );
    }
  }

  setFontIndex(idx) {
    this.fontIdx = typeof idx === "number" ? idx : 1;
    const preset = FONT_SIZES[this.fontIdx] || FONT_SIZES[1];
    document.documentElement.style.setProperty("--font-size", preset.size);
    this.el.btnFont.textContent = preset.label;
  }

  setMentionTerms(terms = []) {
    this.mentionTerms = terms.filter(Boolean).map((t) => t.toLowerCase());
  }

  isMention(text) {
    if (!text || !this.mentionTerms.length) return false;
    const lower = text.toLowerCase();
    return this.mentionTerms.some((term) => lower.includes(term));
  }

  formatChannelDisplay({
    twitchChannel,
    kickChannel,
    twitchEnabled,
    kickEnabled,
  }) {
    const parts = [];
    if (twitchEnabled && twitchChannel) parts.push(twitchChannel);
    if (
      kickEnabled &&
      kickChannel &&
      (!twitchEnabled || kickChannel !== twitchChannel)
    ) {
      parts.push(kickChannel);
    }
    return parts.join(" / ") || twitchChannel || kickChannel || "chat";
  }

  updateChannelHeader({
    twitchChannel,
    kickChannel,
    twitchEnabled = true,
    kickEnabled = true,
    backendUrl,
  }) {
    const label = this.formatChannelDisplay({
      twitchChannel,
      kickChannel,
      twitchEnabled,
      kickEnabled,
    });

    this.el.activeChannelLabel.textContent = label;
    document.title = `Chat • ${label}`;
    this.el.inputTwitch.value = twitchChannel;
    this.el.inputKick.value = kickChannel;
    this.setPlatformEnabled("twitch", twitchEnabled);
    this.setPlatformEnabled("kick", kickEnabled);

    if (this.el.btnKickOauth) {
      const oauthUrl = new URL(`${backendUrl}/auth/kick`);
      if (kickChannel) oauthUrl.searchParams.set("channel", kickChannel);
      this.el.btnKickOauth.href = oauthUrl.toString();
    }

    if (this.el.kickAuthText) {
      this.el.kickAuthText.textContent = `O canal #${kickChannel} ainda não autorizou a Kick. Apenas o chat da Twitch aparecerá.`;
    }
  }

  renderRecentChannels(recentChannels = []) {
    if (!recentChannels.length) {
      this.el.recentChannelsWrap.hidden = true;
      return;
    }

    this.el.recentChannelsWrap.hidden = false;
    this.el.recentChannelsList.innerHTML = "";

    for (const item of recentChannels) {
      const chip = document.createElement("div");
      chip.className = "recent-chip";

      const selectBtn = document.createElement("button");
      selectBtn.type = "button";
      selectBtn.className = "recent-select-btn";

      const twActive = item.twitchEnabled !== false && Boolean(item.twitch);
      const kkActive = item.kickEnabled !== false && Boolean(item.kick);
      const textParts = [];
      if (twActive) textParts.push(item.twitch);
      if (kkActive && (!twActive || item.kick !== item.twitch))
        textParts.push(item.kick);
      selectBtn.textContent = textParts.join(" / ") || item.twitch || item.kick;

      selectBtn.addEventListener("click", () => {
        this.onRecentSelect?.(item);
        this.toggleChannelDrawer(false);
      });

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "recent-remove-btn";
      removeBtn.textContent = "×";
      removeBtn.title = "Remover dos recentes";
      removeBtn.setAttribute("aria-label", "Remover dos recentes");
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.onRecentRemove?.(item);
      });

      chip.appendChild(selectBtn);
      chip.appendChild(removeBtn);
      this.el.recentChannelsList.appendChild(chip);
    }
  }

  toggleChannelDrawer(forceState) {
    const isOpen = !this.el.channelDrawer.hidden;
    const nextOpen = typeof forceState === "boolean" ? forceState : !isOpen;
    this.el.channelDrawer.hidden = !nextOpen;
    this.el.btnChannelPicker.setAttribute("aria-expanded", String(nextOpen));
    if (nextOpen) {
      this.el.inputTwitch.focus();
      this.el.inputTwitch.select();
    }
  }

  resetForChannelSwitch(bootMessage) {
    this.seenIds.clear();
    this.autoScroll = true;
    this.kickStreamConnected = false;
    this.kickAuthorized = false;
    this.syncKickStatusUI();
    this.el.scrollResume.classList.remove("visible");
    this.el.chatContainer.innerHTML = "";
    const note = document.createElement("div");
    note.id = "boot-note";
    note.className = "boot-note";
    note.textContent = bootMessage;
    this.el.chatContainer.appendChild(note);
  }

  dismissBootNote() {
    const note = document.getElementById("boot-note");
    if (note && note.parentNode) note.remove();
  }

  clearMessages() {
    this.el.chatContainer.innerHTML = "";
    this.autoScroll = true;
    this.el.scrollResume.classList.remove("visible");
  }

  setTwitchStatus(status) {
    this.el.badgeTwitch.classList.remove("connected", "connecting");
    if (status === "connected") {
      this.el.badgeTwitch.classList.add("connected");
      this.dismissBootNote();
    } else if (status === "connecting") {
      this.el.badgeTwitch.classList.add("connecting");
    }
  }

  setKickConnectionState({ connected, authorized }) {
    if (typeof connected === "boolean") {
      this.kickStreamConnected = connected;
    }
    if (typeof authorized === "boolean") {
      this.kickAuthorized = authorized;
    }
    this.syncKickStatusUI();
  }

  syncKickStatusUI() {
    this.el.badgeKick.classList.remove("connected", "unauthorized");

    if (!this.kickStreamConnected) {
      if (this.el.badgeKickLabel) this.el.badgeKickLabel.textContent = "Kick";
      this.el.badgeKick.title = this.kickEnabled
        ? "Kick desconectada do servidor"
        : "Kick desativada";
      if (this.el.kickAuthBanner) this.el.kickAuthBanner.hidden = true;
      return;
    }

    if (this.kickAuthorized) {
      this.el.badgeKick.classList.add("connected");
      if (this.el.badgeKickLabel) this.el.badgeKickLabel.textContent = "Kick";
      this.el.badgeKick.title = "Kick autorizada e ativa";
      if (this.el.kickAuthBanner) this.el.kickAuthBanner.hidden = true;
      if (this.el.btnKickOauth)
        this.el.btnKickOauth.textContent = "Reautorizar Kick";
    } else {
      this.el.badgeKick.classList.add("unauthorized");
      if (this.el.badgeKickLabel)
        this.el.badgeKickLabel.textContent = "Kick • Sem Auth";
      this.el.badgeKick.title =
        "Canal sem autorização na Kick — clique para conectar";
      if (this.el.kickAuthBanner) this.el.kickAuthBanner.hidden = false;
      if (this.el.btnKickOauth)
        this.el.btnKickOauth.textContent = "Autorizar Kick";
    }
  }

  setLiveBadge(liveState) {
    const isLive = Boolean(liveState?.anyLive);
    const pingOn = Boolean(liveState?.autoPingActive);
    this.el.badgeLive.classList.toggle("on", isLive);
    this.el.liveLabel.textContent = isLive
      ? pingOn
        ? "LIVE • PING"
        : "LIVE"
      : "OFF";
  }

  hashColor(name) {
    const palette = [
      "#ff6b6b",
      "#4ecdc4",
      "#ffe66d",
      "#a29bfe",
      "#fd79a8",
      "#55efc4",
      "#74b9ff",
      "#fab1a0",
      "#81ecec",
      "#ff9f43",
      "#00d2d3",
      "#c8d6e5",
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return palette[Math.abs(hash) % palette.length];
  }

  sanitizeColor(color, username) {
    if (!color) return this.hashColor(username);
    if (/^#[0-9a-fA-F]{6}$/.test(color)) return color;
    if (/^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/.test(color)) return color;
    return this.hashColor(username);
  }

  rowMatchesSingleFilter(row, f) {
    if (f === "donates") return row.dataset.donate === "1";
    if (f === "mentions") return row.dataset.mention === "1";
    if (f === "subs") return row.dataset.sub === "1";
    if (f === "mod") return row.dataset.mod === "1";
    if (f === "vip") return row.dataset.vip === "1";
    if (f === "twitch") return row.dataset.platform === "twitch";
    if (f === "kick") return row.dataset.platform === "kick";
    return false;
  }

  matchesCurrentFilter(row) {
    if (this.activeFilters.size === 0) return true;
    for (const f of this.activeFilters) {
      if (this.rowMatchesSingleFilter(row, f)) return true;
    }
    return false;
  }

  syncFilterButtonsUI() {
    const isDefault = this.activeFilters.size === 0;
    this.el.filterAllBtn.classList.toggle("active", isDefault);
    this.el.filterButtons.forEach((btn) => {
      const f = btn.dataset.filter;
      if (f === "all") return;
      btn.classList.toggle("active", this.activeFilters.has(f));
    });
  }

  applyFilterToAll() {
    this.syncFilterButtonsUI();
    for (const row of this.el.chatContainer.querySelectorAll(".msg")) {
      row.classList.toggle("hidden-by-filter", !this.matchesCurrentFilter(row));
    }
    if (this.autoScroll) {
      this.el.chatContainer.scrollTop = this.el.chatContainer.scrollHeight;
    }
  }

  createRoleBadgeElement({
    platform,
    type,
    fallbackSvg,
    setName,
    versions = [],
  }) {
    const tag = document.createElement("span");
    tag.className = `role-tag ${type}`;

    const official =
      platform === "twitch"
        ? this.emoteManager.resolveOfficialBadge(setName, versions)
        : null;
    if (official?.url) {
      const img = document.createElement("img");
      img.src = official.url;
      img.alt = official.title;
      img.title = official.title;
      img.loading = "lazy";
      img.decoding = "async";
      img.onerror = () => {
        tag.innerHTML = fallbackSvg;
      };
      tag.appendChild(img);
    } else {
      tag.innerHTML = fallbackSvg;
    }

    return tag;
  }

  createSubBadgeElement({ platform, subSet, subVersion, subMonths }) {
    const months = Number(subMonths) || 1;
    const setOrder =
      subSet === "founder"
        ? ["founder", "subscriber"]
        : ["subscriber", "founder"];
    const versions = [subVersion, String(months), "0", "1"];

    for (const setName of setOrder) {
      const found =
        platform === "twitch"
          ? this.emoteManager.resolveOfficialBadge(setName, versions)
          : null;
      if (found?.url) {
        const tag = document.createElement("span");
        tag.className = "role-tag sub-twitch";
        const img = document.createElement("img");
        img.src = found.url;
        img.alt = found.title;
        img.title = found.title;
        img.loading = "lazy";
        img.decoding = "async";
        img.onerror = () => {
          tag.innerHTML = buildSubSwordSvg(months);
        };
        tag.appendChild(img);
        return tag;
      }
    }

    const tag = document.createElement("span");
    tag.className = "role-tag sub-twitch";
    tag.innerHTML = buildSubSwordSvg(months);
    return tag;
  }

  appendMessage({
    id,
    platform,
    username,
    color,
    text,
    twitchEmotes = "",
    isSub = false,
    subSet = "subscriber",
    subVersion = "",
    subMonths = 1,
    isMod = false,
    isBroadcaster = false,
    isVip = false,
    isDonate = false,
    donateLabel = "",
  }) {
    if (!text || !username) return;
    if (id && this.seenIds.has(id)) return;
    if (id) {
      this.seenIds.add(id);
      if (this.seenIds.size > 600) {
        const first = this.seenIds.values().next().value;
        this.seenIds.delete(first);
      }
    }

    this.dismissBootNote();
    const mentioned = this.isMention(text);

    const row = document.createElement("div");
    row.className = `msg ${platform}${isDonate ? " donate" : mentioned ? " mention" : ""}`;
    row.dataset.platform = platform;
    row.dataset.donate = isDonate ? "1" : "0";
    row.dataset.mention = mentioned ? "1" : "0";
    row.dataset.sub = isSub ? "1" : "0";
    row.dataset.mod = isMod ? "1" : "0";
    row.dataset.vip = isVip ? "1" : "0";

    if (!this.matchesCurrentFilter(row)) {
      row.classList.add("hidden-by-filter");
    }

    const iconSpan = document.createElement("span");
    iconSpan.className = "msg-platform-icon";
    iconSpan.innerHTML =
      platform === "twitch" ? TWITCH_ICON_SVG : KICK_ICON_SVG;

    const body = document.createElement("div");
    body.className = "msg-body";

    if (isDonate) {
      const tag = document.createElement("span");
      tag.className = "role-tag donate";
      tag.textContent = donateLabel || "$";
      body.appendChild(tag);
    }

    if (isBroadcaster) {
      body.appendChild(
        this.createRoleBadgeElement({
          platform,
          type: "mod",
          fallbackSvg: MOD_BADGE_SVG,
          setName: "broadcaster",
          versions: ["1", "0"],
        }),
      );
    } else if (isMod) {
      body.appendChild(
        this.createRoleBadgeElement({
          platform,
          type: "mod",
          fallbackSvg: MOD_BADGE_SVG,
          setName: "moderator",
          versions: ["1", "0"],
        }),
      );
    }

    if (isVip) {
      body.appendChild(
        this.createRoleBadgeElement({
          platform,
          type: "vip",
          fallbackSvg: VIP_BADGE_SVG,
          setName: "vip",
          versions: ["1", "0"],
        }),
      );
    }

    if (isSub && !isDonate) {
      body.appendChild(
        this.createSubBadgeElement({ platform, subSet, subVersion, subMonths }),
      );
    }

    const userSpan = document.createElement("span");
    userSpan.className = "msg-user";
    userSpan.textContent = `${username}:`;
    userSpan.style.color = this.sanitizeColor(color, username);

    const textSpan = document.createElement("span");
    textSpan.className = "msg-text";
    this.emoteManager.appendFormattedMessageText(
      textSpan,
      text,
      twitchEmotes,
      this.theme,
    );

    body.appendChild(userSpan);
    body.appendChild(textSpan);
    row.appendChild(iconSpan);
    row.appendChild(body);

    this.el.chatContainer.appendChild(row);

    while (this.el.chatContainer.children.length > this.maxMessages) {
      this.el.chatContainer.removeChild(this.el.chatContainer.firstChild);
    }

    if (this.autoScroll) {
      this.el.chatContainer.scrollTop = this.el.chatContainer.scrollHeight;
    }
  }

  async toggleWakeLock() {
    if (!("wakeLock" in navigator)) return;
    if (this.wakeLock) {
      await this.wakeLock.release();
      this.wakeLock = null;
      this.el.btnWakeLock.classList.remove("active");
      return;
    }
    try {
      this.wakeLock = await navigator.wakeLock.request("screen");
      this.el.btnWakeLock.classList.add("active");
      this.wakeLock.addEventListener("release", () => {
        this.wakeLock = null;
        this.el.btnWakeLock.classList.remove("active");
      });
    } catch (_) {}
  }
}
