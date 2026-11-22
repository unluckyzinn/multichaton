import { EmoteAndBadgeManager } from "./emotes.js";
import { TwitchIrcClient } from "./twitch.js";
import { ChatUIController } from "./ui.js";
import { RaffleManager } from "./raffle.js";

const DEFAULT_CHANNEL = "aspaszin";
const BACKEND_URL = window.location.origin;
const MAX_MESSAGES = 250;
const MAX_RECENT_CHANNELS = 5;
const STORAGE_KEY = "multichat_prefs_v1";

function sanitizeChannelSlug(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/^https?:\/\/(www\.)?(twitch\.tv|kick\.com)\//i, "")
    .replace(/[^a-z0-9_-]/g, "");
}

function buildRecentKey(item) {
  const tw = item.twitchEnabled !== false ? item.twitch || "" : "";
  const kk = item.kickEnabled !== false ? item.kick || "" : "";
  return `${tw}|${kk}`;
}

const appState = {
  twitchChannel: DEFAULT_CHANNEL,
  kickChannel: DEFAULT_CHANNEL,
  twitchEnabled: true,
  kickEnabled: true,
  recentChannels: [],
  sessionId: 0,
  eventSource: null,
};

const emoteManager = new EmoteAndBadgeManager(BACKEND_URL);
const raffleManager = new RaffleManager();

const ui = new ChatUIController({
  maxMessages: MAX_MESSAGES,
  emoteManager,
  onChannelSubmit: (cfg) => applyChannelSelection(cfg),
  onRecentSelect: (item) =>
    applyChannelSelection({
      twitch: item.twitch,
      kick: item.kick,
      twitchEnabled: item.twitchEnabled !== false,
      kickEnabled: item.kickEnabled !== false,
    }),
  onRecentRemove: (item) => removeRecentChannel(item),
  onPrefsChange: () => savePrefs(),
});

function handleIncomingChatMessage(msg) {
  ui.appendMessage(msg);
  raffleManager.processIncomingMessage(msg);
}

const twitchClient = new TwitchIrcClient({
  onStatusChange: (status) => ui.setTwitchStatus(status),
  onMessage: (msg) => handleIncomingChatMessage(msg),
});

function loadInitialPrefs() {
  const params = new URLSearchParams(window.location.search);
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");

  const sharedParam = sanitizeChannelSlug(
    params.get("channel") || params.get("c"),
  );
  const twitchParam = sanitizeChannelSlug(
    params.get("twitch") || params.get("tw"),
  );
  const kickParam = sanitizeChannelSlug(params.get("kick") || params.get("kk"));

  const twitch =
    twitchParam ||
    sharedParam ||
    sanitizeChannelSlug(saved.twitchChannel) ||
    DEFAULT_CHANNEL;
  const kick =
    kickParam ||
    sharedParam ||
    sanitizeChannelSlug(saved.kickChannel) ||
    twitch;

  const twEnabledParam = params.get("tw_on");
  const kkEnabledParam = params.get("kk_on");

  const twitchEnabled =
    twEnabledParam !== null
      ? twEnabledParam !== "0"
      : typeof saved.twitchEnabled === "boolean"
        ? saved.twitchEnabled
        : true;

  const kickEnabled =
    kkEnabledParam !== null
      ? kkEnabledParam !== "0"
      : typeof saved.kickEnabled === "boolean"
        ? saved.kickEnabled
        : true;

  appState.twitchChannel = twitch;
  appState.kickChannel = kick;
  appState.twitchEnabled = twitchEnabled || !kickEnabled ? twitchEnabled : true;
  appState.kickEnabled = kickEnabled;

  const loadedRecents = Array.isArray(saved.recentChannels)
    ? saved.recentChannels
    : [];
  appState.recentChannels = loadedRecents.slice(0, MAX_RECENT_CHANNELS);

  ui.setFontIndex(typeof saved.fontIdx === "number" ? saved.fontIdx : 1);
  ui.setTheme(saved.theme === "light" ? "light" : "dark");
  ui.syncFilterButtonsUI();
  ui.renderRecentChannels(appState.recentChannels);
}

function savePrefs() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      twitchChannel: appState.twitchChannel,
      kickChannel: appState.kickChannel,
      twitchEnabled: appState.twitchEnabled,
      kickEnabled: appState.kickEnabled,
      recentChannels: appState.recentChannels.slice(0, MAX_RECENT_CHANNELS),
      fontIdx: ui.fontIdx,
      theme: ui.theme,
    }),
  );
}

function syncUrlWithChannels() {
  const url = new URL(window.location.href);
  url.searchParams.delete("c");
  url.searchParams.delete("tw");
  url.searchParams.delete("kk");

  if (appState.twitchChannel)
    url.searchParams.set("twitch", appState.twitchChannel);
  else url.searchParams.delete("twitch");

  if (appState.kickChannel) url.searchParams.set("kick", appState.kickChannel);
  else url.searchParams.delete("kick");

  url.searchParams.delete("channel");

  if (appState.twitchEnabled) url.searchParams.delete("tw_on");
  else url.searchParams.set("tw_on", "0");

  if (appState.kickEnabled) url.searchParams.delete("kk_on");
  else url.searchParams.set("kk_on", "0");

  window.history.replaceState({}, "", url.toString());
}

function recordRecentChannel(entry) {
  const cleanEntry = {
    twitch: entry.twitch,
    kick: entry.kick,
    twitchEnabled: entry.twitchEnabled,
    kickEnabled: entry.kickEnabled,
  };
  const targetKey = buildRecentKey(cleanEntry);
  const filtered = appState.recentChannels.filter(
    (item) => buildRecentKey(item) !== targetKey,
  );
  filtered.unshift(cleanEntry);
  appState.recentChannels = filtered.slice(0, MAX_RECENT_CHANNELS);
  ui.renderRecentChannels(appState.recentChannels);
}

function removeRecentChannel(entryToRemove) {
  const targetKey = buildRecentKey(entryToRemove);
  appState.recentChannels = appState.recentChannels.filter(
    (item) => buildRecentKey(item) !== targetKey,
  );
  ui.renderRecentChannels(appState.recentChannels);
  savePrefs();
}

function disconnectKickStream() {
  if (appState.eventSource) {
    appState.eventSource.close();
    appState.eventSource = null;
  }
  ui.setKickConnectionState({ connected: false, authorized: false });
  ui.setLiveBadge({ anyLive: false });
}

function connectKickStream(kickChannel, currentSession) {
  disconnectKickStream();
  if (!appState.kickEnabled || !kickChannel) return;

  const streamUrl = new URL(`${BACKEND_URL}/api/stream`);
  streamUrl.searchParams.set("channel", kickChannel);

  const es = new EventSource(streamUrl.toString());
  appState.eventSource = es;

  es.onopen = () => {
    if (currentSession !== appState.sessionId) return;
    ui.setKickConnectionState({ connected: true });
  };

  es.addEventListener("status", (e) => {
    if (currentSession !== appState.sessionId) return;
    try {
      const statusData = JSON.parse(e.data);
      ui.setKickConnectionState({
        connected: true,
        authorized: Boolean(statusData?.kickAuthorized),
      });
      ui.setLiveBadge(statusData);
    } catch (_) {}
  });

  es.addEventListener("message", (e) => {
    if (currentSession !== appState.sessionId) return;
    try {
      const msg = JSON.parse(e.data);
      const msgChannel = sanitizeChannelSlug(msg.channel || "");
      if (msgChannel && msgChannel !== kickChannel) return;
      handleIncomingChatMessage(msg);
    } catch (_) {}
  });

  es.onerror = () => {
    if (currentSession !== appState.sessionId) return;
    ui.setKickConnectionState({ connected: false, authorized: false });
  };
}

function applyChannelSelection({ twitch, kick, twitchEnabled, kickEnabled }) {
  const cleanTwitch = sanitizeChannelSlug(twitch);
  const cleanKick = sanitizeChannelSlug(kick);

  const activeTwitch = Boolean(twitchEnabled) && Boolean(cleanTwitch);
  const activeKick = Boolean(kickEnabled) && Boolean(cleanKick);

  if (!activeTwitch && !activeKick) return;

  appState.twitchChannel = cleanTwitch || appState.twitchChannel;
  appState.kickChannel = cleanKick || appState.kickChannel;
  appState.twitchEnabled = activeTwitch;
  appState.kickEnabled = activeKick;

  appState.sessionId += 1;
  const currentSession = appState.sessionId;

  const mentionTerms = [];
  if (activeTwitch && appState.twitchChannel)
    mentionTerms.push(appState.twitchChannel);
  if (activeKick && appState.kickChannel)
    mentionTerms.push(appState.kickChannel);
  ui.setMentionTerms(mentionTerms);

  ui.updateChannelHeader({
    twitchChannel: appState.twitchChannel,
    kickChannel: appState.kickChannel,
    twitchEnabled: appState.twitchEnabled,
    kickEnabled: appState.kickEnabled,
    backendUrl: BACKEND_URL,
  });

  recordRecentChannel({
    twitch: appState.twitchChannel,
    kick: appState.kickChannel,
    twitchEnabled: appState.twitchEnabled,
    kickEnabled: appState.kickEnabled,
  });

  savePrefs();
  syncUrlWithChannels();

  const bootTarget = activeTwitch
    ? `#${appState.twitchChannel}`
    : `#${appState.kickChannel} (Kick)`;
  ui.resetForChannelSwitch(`Conectando em ${bootTarget}...`);

  if (activeTwitch) {
    emoteManager.loadChannelMetadata(
      appState.twitchChannel,
      () => currentSession === appState.sessionId,
    );
    twitchClient.connect(appState.twitchChannel);
  } else {
    emoteManager.reset();
    twitchClient.disconnect();
    ui.setTwitchStatus("offline");
  }

  if (activeKick) {
    connectKickStream(appState.kickChannel, currentSession);
  } else {
    disconnectKickStream();
  }
}

loadInitialPrefs();
applyChannelSelection({
  twitch: appState.twitchChannel,
  kick: appState.kickChannel,
  twitchEnabled: appState.twitchEnabled,
  kickEnabled: appState.kickEnabled,
});
