import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

// Credenciais Kick OAuth
const KICK_CLIENT_ID = process.env.KICK_CLIENT_ID || "";
const KICK_CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || "";
const KICK_REDIRECT_URI = process.env.KICK_REDIRECT_URI || "";
const KICK_AUTH_URL = "https://id.kick.com/oauth/authorize";
const KICK_TOKEN_URL = "https://id.kick.com/oauth/token";
const KICK_API_BASE = "https://api.kick.com/public/v1";

// Credenciais Twitch API (para /api/badges)
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || "";
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || "";

const STORE_FILE = path.join(__dirname, "kick-channels.json");
const PUBLIC_DIR = path.join(__dirname, "public");

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ============================================================================
// Estado Multi-Canal (Kick) & Cache de Badges (Twitch)
// ============================================================================
const channelsBySlug = new Map();
const slugByBroadcasterId = new Map();
const pendingPkce = new Map();
const sseClients = new Set();

let twitchAppToken = { token: "", expiresAt: 0 };
const twitchBadgesCache = new Map();

function getBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  const host = req.get("x-forwarded-host") || req.get("host");
  return `${proto}://${host}`;
}

function getKickRedirectUri(req) {
  if (KICK_REDIRECT_URI) return KICK_REDIRECT_URI;
  return `${getBaseUrl(req)}/auth/kick/callback`;
}

function sanitizeSlug(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9_-]/g, "");
}

function loadStoreFromDisk() {
  try {
    if (!fs.existsSync(STORE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      if (!item?.slug) continue;
      channelsBySlug.set(item.slug, {
        slug: item.slug,
        broadcasterUserId: item.broadcasterUserId
          ? String(item.broadcasterUserId)
          : "",
        username: item.username || item.slug,
        accessToken: item.accessToken || "",
        refreshToken: item.refreshToken || "",
        expiresAt: Number(item.expiresAt || 0),
        isLive: Boolean(item.isLive),
      });
      if (item.broadcasterUserId) {
        slugByBroadcasterId.set(String(item.broadcasterUserId), item.slug);
      }
    }
  } catch (err) {
    console.error("[Store] Falha ao ler kick-channels.json:", err.message);
  }
}

function saveStoreToDisk() {
  try {
    const list = Array.from(channelsBySlug.values());
    fs.writeFileSync(STORE_FILE, JSON.stringify(list, null, 2), "utf8");
  } catch (err) {
    console.error("[Store] Falha ao salvar kick-channels.json:", err.message);
  }
}

loadStoreFromDisk();

setInterval(
  () => {
    const now = Date.now();
    for (const [key, val] of pendingPkce.entries()) {
      if (now - val.createdAt > 10 * 60 * 1000) {
        pendingPkce.delete(key);
      }
    }
  },
  5 * 60 * 1000,
);

// ============================================================================
// Helpers SSE Multi-Canal
// ============================================================================
function buildChannelStatusPayload(channelSlug) {
  const clean = sanitizeSlug(channelSlug);
  const record = clean ? channelsBySlug.get(clean) : null;
  return {
    channel: clean,
    kickAuthorized: Boolean(record?.accessToken),
    anyLive: Boolean(record?.isLive),
    autoPingActive: false,
  };
}

function sendSseEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastStatusForChannel(channelSlug) {
  const clean = sanitizeSlug(channelSlug);
  if (!clean) return;
  const payload = buildChannelStatusPayload(clean);
  for (const client of sseClients) {
    if (client.channel === clean) {
      sendSseEvent(client.res, "status", payload);
    }
  }
}

function broadcastMessageForChannel(channelSlug, messagePayload) {
  const clean = sanitizeSlug(channelSlug);
  if (!clean) return;
  const enriched = {
    ...messagePayload,
    channel: clean,
  };
  for (const client of sseClients) {
    if (client.channel === clean) {
      sendSseEvent(client.res, "message", enriched);
    }
  }
}

// ============================================================================
// Kick OAuth + Webhooks Multi-Tenant
// ============================================================================
function generatePkcePair() {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

async function fetchKickAuthenticatedUser(accessToken) {
  const res = await fetch(`${KICK_API_BASE}/users`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`GET /users falhou (${res.status}): ${txt}`);
  }

  const json = await res.json();
  const userObj = Array.isArray(json?.data) ? json.data[0] : json?.data || json;
  return {
    userId: String(userObj?.user_id || userObj?.id || ""),
    username: String(userObj?.name || userObj?.username || userObj?.slug || ""),
  };
}

async function subscribeKickWebhooks(accessToken, broadcasterUserId) {
  if (!accessToken || !broadcasterUserId) return;

  const events = [
    { name: "chat.message.sent", version: 1 },
    { name: "channel.subscription.new", version: 1 },
    { name: "channel.subscription.renewal", version: 1 },
    { name: "channel.subscription.gifts", version: 1 },
    { name: "livestream.status.updated", version: 1 },
  ];

  const payload = {
    broadcaster_user_id: Number(broadcasterUserId),
    events,
    method: "webhook",
  };

  const res = await fetch(`${KICK_API_BASE}/events/subscriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.warn(
      `[Kick Webhooks] Resposta para ${broadcasterUserId} (${res.status}):`,
      txt,
    );
  }
}

app.get("/auth/kick", (req, res) => {
  if (!KICK_CLIENT_ID || !KICK_CLIENT_SECRET) {
    return res
      .status(500)
      .send(
        "KICK_CLIENT_ID e KICK_CLIENT_SECRET não configurados no servidor.",
      );
  }

  const requestedChannel = sanitizeSlug(req.query.channel || "");
  const redirectUri = getKickRedirectUri(req);
  const state = crypto.randomBytes(16).toString("hex");
  const { codeVerifier, codeChallenge } = generatePkcePair();

  pendingPkce.set(state, {
    codeVerifier,
    requestedChannel,
    redirectUri,
    createdAt: Date.now(),
  });

  const authUrl = new URL(KICK_AUTH_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", KICK_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set(
    "scope",
    "user:read channel:read chat:write events:subscribe",
  );
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  res.redirect(authUrl.toString());
});

app.get("/auth/kick/callback", async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) {
      return res
        .status(400)
        .send(`Autorização negada pela Kick: ${String(error)}`);
    }
    if (!code || !state || !pendingPkce.has(String(state))) {
      return res
        .status(400)
        .send("Estado OAuth inválido ou expirado. Tente autorizar novamente.");
    }

    const session = pendingPkce.get(String(state));
    pendingPkce.delete(String(state));

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: KICK_CLIENT_ID,
      client_secret: KICK_CLIENT_SECRET,
      redirect_uri: session.redirectUri,
      code_verifier: session.codeVerifier,
      code: String(code),
    });

    const tokenRes = await fetch(KICK_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });

    if (!tokenRes.ok) {
      const errTxt = await tokenRes.text().catch(() => "");
      return res
        .status(502)
        .send(
          `Erro ao trocar code por token na Kick (${tokenRes.status}): ${errTxt}`,
        );
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token || "";
    const expiresAt = Date.now() + Number(tokenData.expires_in || 3600) * 1000;

    const userInfo = await fetchKickAuthenticatedUser(accessToken);
    const resolvedSlug =
      sanitizeSlug(userInfo.username) || session.requestedChannel;

    if (!resolvedSlug) {
      return res
        .status(400)
        .send("Não foi possível identificar o nome do canal autorizado.");
    }

    const record = {
      slug: resolvedSlug,
      broadcasterUserId: userInfo.userId,
      username: userInfo.username || resolvedSlug,
      accessToken,
      refreshToken,
      expiresAt,
      isLive: false,
    };

    channelsBySlug.set(resolvedSlug, record);
    if (session.requestedChannel && session.requestedChannel !== resolvedSlug) {
      channelsBySlug.set(session.requestedChannel, record);
    }
    if (userInfo.userId) {
      slugByBroadcasterId.set(String(userInfo.userId), resolvedSlug);
    }

    saveStoreToDisk();

    if (userInfo.userId) {
      await subscribeKickWebhooks(accessToken, userInfo.userId);
    }

    broadcastStatusForChannel(resolvedSlug);
    if (session.requestedChannel && session.requestedChannel !== resolvedSlug) {
      broadcastStatusForChannel(session.requestedChannel);
    }

    res.redirect(`/?kick=${encodeURIComponent(resolvedSlug)}`);
  } catch (err) {
    console.error("[Kick Callback Error]", err);
    res.status(500).send(`Erro interno no callback OAuth: ${err.message}`);
  }
});

// ============================================================================
// Recebimento de Webhooks da Kick
// ============================================================================
function parseKickWebhookToChatMessage(eventType, body) {
  const broadcasterId = String(
    body?.broadcaster?.user_id ||
      body?.broadcaster_user_id ||
      body?.channel?.user_id ||
      "",
  );
  const broadcasterSlug = sanitizeSlug(
    body?.broadcaster?.username ||
      body?.broadcaster?.slug ||
      slugByBroadcasterId.get(broadcasterId) ||
      "",
  );

  if (eventType === "livestream.status.updated") {
    const isLive = Boolean(body?.is_live);
    if (broadcasterSlug && channelsBySlug.has(broadcasterSlug)) {
      channelsBySlug.get(broadcasterSlug).isLive = isLive;
      saveStoreToDisk();
      broadcastStatusForChannel(broadcasterSlug);
    }
    return null;
  }

  if (eventType === "chat.message.sent") {
    const sender = body?.sender || {};
    const badges = Array.isArray(sender?.identity?.badges)
      ? sender.identity.badges
      : [];
    const badgeTypes = badges.map((b) => String(b?.type || "").toLowerCase());

    const isBroadcaster = badgeTypes.includes("broadcaster");
    const isMod = isBroadcaster || badgeTypes.includes("moderator");
    const isVip = badgeTypes.includes("vip");
    const isSub =
      badgeTypes.includes("subscriber") || badgeTypes.includes("founder");

    return {
      targetChannel: broadcasterSlug,
      payload: {
        id: body?.message_id
          ? `kk-${body.message_id}`
          : `kk-${Date.now()}-${Math.random()}`,
        platform: "kick",
        channel: broadcasterSlug,
        username: sender?.username || "Usuário Kick",
        color: sender?.identity?.username_color || "",
        text: String(body?.content || ""),
        isSub,
        isMod,
        isBroadcaster,
        isVip,
        isDonate: false,
      },
    };
  }

  if (
    eventType === "channel.subscription.new" ||
    eventType === "channel.subscription.renewal" ||
    eventType === "channel.subscription.gifts"
  ) {
    const subscriber = body?.subscriber || body?.gifter || {};
    const duration = Number(body?.duration || 1);
    const gifteesCount = Array.isArray(body?.giftees) ? body.giftees.length : 1;

    let donateLabel = "SUB";
    let text = "Assinou o canal na Kick!";
    if (eventType === "channel.subscription.renewal") {
      donateLabel = `RESUB ${duration}M`;
      text = `Renovou assinatura por ${duration} ${duration === 1 ? "mês" : "meses"} na Kick!`;
    } else if (eventType === "channel.subscription.gifts") {
      donateLabel = `${gifteesCount} GIFT SUB${gifteesCount > 1 ? "S" : ""}`;
      text = `Presenteou ${gifteesCount} assinatura${gifteesCount > 1 ? "s" : ""} na Kick!`;
    }

    return {
      targetChannel: broadcasterSlug,
      payload: {
        id: `kk-sub-${Date.now()}-${Math.random()}`,
        platform: "kick",
        channel: broadcasterSlug,
        username: subscriber?.username || "Inscrito Kick",
        color: "#53fc18",
        text,
        isSub: true,
        subMonths: duration,
        isMod: false,
        isBroadcaster: false,
        isVip: false,
        isDonate: true,
        donateLabel,
      },
    };
  }

  return null;
}

app.post("/webhooks/kick", (req, res) => {
  const eventType = String(
    req.header("Kick-Event-Type") || req.body?.event || "",
  );
  const parsed = parseKickWebhookToChatMessage(eventType, req.body || {});

  if (parsed?.targetChannel && parsed?.payload) {
    broadcastMessageForChannel(parsed.targetChannel, parsed.payload);
  }

  res.status(200).json({ ok: true });
});

// ============================================================================
// Endpoint SSE Filtrado por Canal
// ============================================================================
app.get("/api/stream", (req, res) => {
  const requestedChannel = sanitizeSlug(req.query.channel || "aspaszin");

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const client = { res, channel: requestedChannel };
  sseClients.add(client);

  sendSseEvent(res, "status", buildChannelStatusPayload(requestedChannel));

  const keepAlive = setInterval(() => {
    res.write(": ping\n\n");
  }, 20_000);

  req.on("close", () => {
    clearInterval(keepAlive);
    sseClients.delete(client);
  });
});

// ============================================================================
// Endpoint Twitch Badges (/api/badges?channel=<slug>&global=true)
// ============================================================================
async function getTwitchAppToken() {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) return "";
  if (twitchAppToken.token && Date.now() < twitchAppToken.expiresAt - 60_000) {
    return twitchAppToken.token;
  }

  const url = new URL("https://id.twitch.tv/oauth2/token");
  url.searchParams.set("client_id", TWITCH_CLIENT_ID);
  url.searchParams.set("client_secret", TWITCH_CLIENT_SECRET);
  url.searchParams.set("grant_type", "client_credentials");

  const res = await fetch(url.toString(), { method: "POST" });
  if (!res.ok) return "";

  const data = await res.json();
  twitchAppToken = {
    token: data.access_token || "",
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  return twitchAppToken.token;
}

function normalizeTwitchBadgeSets(setsArray = [], target = {}) {
  for (const setObj of setsArray) {
    const setId = String(setObj?.set_id || "");
    if (!setId) continue;
    if (!target[setId]) target[setId] = {};

    for (const ver of setObj?.versions || []) {
      const verId = String(ver?.id || "");
      if (!verId) continue;
      target[setId][verId] = {
        title: ver?.title || setId,
        url1x: ver?.image_url_1x || "",
        url2x: ver?.image_url_2x || "",
        url4x: ver?.image_url_4x || "",
      };
    }
  }
  return target;
}

app.get("/api/badges", async (req, res) => {
  try {
    const channelLogin = sanitizeSlug(req.query.channel || "");
    const includeGlobal = req.query.global !== "false";
    const cacheKey = `${channelLogin}|${includeGlobal}`;

    const cached = twitchBadgesCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return res.json(cached.data);
    }

    const token = await getTwitchAppToken();
    if (!token) {
      return res
        .status(503)
        .json({
          ok: false,
          error: "Credenciais Twitch não configuradas no backend.",
        });
    }

    const headers = {
      "Client-Id": TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`,
    };

    const mergedBadges = {};
    let broadcasterId = "";

    if (includeGlobal) {
      const globalRes = await fetch(
        "https://api.twitch.tv/helix/chat/badges/global",
        { headers },
      );
      if (globalRes.ok) {
        const globalJson = await globalRes.json();
        normalizeTwitchBadgeSets(globalJson?.data, mergedBadges);
      }
    }

    if (channelLogin) {
      const userRes = await fetch(
        `https://api.twitch.tv/helix/users?login=${encodeURIComponent(channelLogin)}`,
        { headers },
      );
      if (userRes.ok) {
        const userJson = await userRes.json();
        broadcasterId = String(userJson?.data?.[0]?.id || "");
      }

      if (broadcasterId) {
        const chRes = await fetch(
          `https://api.twitch.tv/helix/chat/badges?broadcaster_id=${encodeURIComponent(broadcasterId)}`,
          { headers },
        );
        if (chRes.ok) {
          const chJson = await chRes.json();
          normalizeTwitchBadgeSets(chJson?.data, mergedBadges);
        }
      }
    }

    const responsePayload = {
      ok: true,
      channel: channelLogin,
      broadcasterId,
      badges: mergedBadges,
    };

    twitchBadgesCache.set(cacheKey, {
      data: responsePayload,
      expiresAt: Date.now() + 15 * 60 * 1000,
    });

    res.json(responsePayload);
  } catch (err) {
    console.error("[Twitch Badges Error]", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================================
// Healthcheck & Frontend Estático (pasta public/)
// ============================================================================
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    authorizedKickChannels: Array.from(channelsBySlug.keys()),
    connectedSseClients: sseClients.size,
  });
});

app.use(express.static(PUBLIC_DIR));

app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Multi-Chat unificado rodando na porta ${PORT}`);
});
