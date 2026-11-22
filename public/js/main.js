import { EmoteAndBadgeManager } from "./emotes.js";
import { TwitchIrcClient } from "./twitch.js";
import { ChatUIController } from "./ui.js";

const DEFAULT_CHANNEL = "aspaszin";
const BACKEND_URL = window.location.origin;
const MAX_MESSAGES = 250;
const MAX_RECENT_CHANNELS = 8;
const STORAGE_KEY = "multichat_prefs_v1";

function sanitizeChannelSlug(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/^https?:\/\/(www\.)?(twitch\.tv|kick\.com)\//i, "")
    .replace(/[^a-z0-9_-]/g, "");
}

const appState = {
  twitchChannel: DEFAULT_CHANNEL,
  kickChannel: DEFAULT_CHANNEL,
  recentChannels: [],
  sessionId: 0,
  eventSource: null,
};

const emoteManager = new EmoteAndBadgeManager(BACKEND_URL);

const ui = new ChatUIController({
  maxMessages: MAX_MESSAGES,
  emoteManager,
  onChannelSubmit: (tw, kk) => switchChannels(tw, kk),
  onRecentSelect: (tw, kk) => switchChannels(tw, kk),
  onPrefsChange: () => savePrefs(),
});

const twitchClient = new TwitchIrcClient({
  onStatusChange: (status) => ui.setTwitchStatus(status),
  onMessage: (msg) => ui.appendMessage(msg),
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

  appState.twitchChannel = twitch;
  appState.kickChannel = kick;
  appState.recentChannels = Array.isArray(saved.recentChannels)
    ? saved.recentChannels
    : [];

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
      recentChannels: appState.recentChannels,
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

  if (appState.twitchChannel === appState.kickChannel) {
    url.searchParams.set("channel", appState.twitchChannel);
    url.searchParams.delete("twitch");
    url.searchParams.delete("kick");
  } else {
    url.searchParams.delete("channel");
    if (appState.twitchChannel)
      url.searchParams.set("twitch", appState.twitchChannel);
    if (appState.kickChannel)
      url.searchParams.set("kick", appState.kickChannel);
  }

  window.history.replaceState({}, "", url.toString());
}

function recordRecentChannel(twitch, kick) {
  const key = `${twitch}|${kick}`;
  const filtered = appState.recentChannels.filter(
    (item) => `${item.twitch}|${item.kick}` !== key,
  );
  filtered.unshift({ twitch, kick });
  appState.recentChannels = filtered.slice(0, MAX_RECENT_CHANNELS);
  ui.renderRecentChannels(appState.recentChannels);
}

function connectKickStream(kickChannel, currentSession) {
  if (appState.eventSource) {
    appState.eventSource.close();
    appState.eventSource = null;
  }

  ui.setKickConnected(false);
  if (!kickChannel) return;

  const streamUrl = new URL(`${BACKEND_URL}/api/stream`);
  streamUrl.searchParams.set("channel", kickChannel);

  const es = new EventSource(streamUrl.toString());
  appState.eventSource = es;

  es.onopen = () => {
    if (currentSession !== appState.sessionId) return;
    ui.setKickConnected(true);
  };

  es.addEventListener("status", (e) => {
    if (currentSession !== appState.sessionId) return;
    try {
      ui.setLiveBadge(JSON.parse(e.data));
    } catch (_) {}
  });

  es.addEventListener("message", (e) => {
    if (currentSession !== appState.sessionId) return;
    try {
      const msg = JSON.parse(e.data);
      const msgChannel = sanitizeChannelSlug(msg.channel || "");
      if (msgChannel && msgChannel !== kickChannel) return;
      ui.appendMessage(msg);
    } catch (_) {}
  });

  es.onerror = () => {
    if (currentSession !== appState.sessionId) return;
    ui.setKickConnected(false);
  };
}

function switchChannels(rawTwitch, rawKick) {
  const cleanTwitch = sanitizeChannelSlug(rawTwitch);
  const cleanKick = sanitizeChannelSlug(rawKick) || cleanTwitch;
  if (!cleanTwitch && !cleanKick) return;

  appState.twitchChannel = cleanTwitch || cleanKick;
  appState.kickChannel = cleanKick || appState.twitchChannel;
  appState.sessionId += 1;
  const currentSession = appState.sessionId;

  ui.setMentionTerms([appState.twitchChannel, appState.kickChannel]);
  ui.updateChannelHeader({
    twitchChannel: appState.twitchChannel,
    kickChannel: appState.kickChannel,
    backendUrl: BACKEND_URL,
  });

  recordRecentChannel(appState.twitchChannel, appState.kickChannel);
  savePrefs();
  syncUrlWithChannels();

  ui.resetForChannelSwitch(`Conectando em #${appState.twitchChannel}...`);
  ui.setLiveBadge({ anyLive: false });

  emoteManager.loadChannelMetadata(
    appState.twitchChannel,
    () => currentSession === appState.sessionId,
  );
  twitchClient.connect(appState.twitchChannel);
  connectKickStream(appState.kickChannel, currentSession);
}

loadInitialPrefs();
switchChannels(appState.twitchChannel, appState.kickChannel);
