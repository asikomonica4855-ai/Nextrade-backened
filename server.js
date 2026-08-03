const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const DERIV_CLIENT_ID = process.env.DERIV_CLIENT_ID;
const DERIV_REDIRECT_URI = process.env.DERIV_REDIRECT_URI;

const FRONTEND_ORIGIN = "https://asikomonica4855-ai.github.io";
const BACKEND_URL = "https://nextrade-backened.onrender.com";

const symbols = [
  "1HZ100V",
  "1HZ75V",
  "1HZ50V",
  "1HZ25V",
  "1HZ10V",
  "R_100",
  "R_75",
  "R_50",
  "R_25",
  "R_10"
];

let deriv = null;
let derivConnected = false;

const clients = new Set();
const oauthStates = new Map();
const sessions = new Map();

/* --------------------------------------------------
   CORS
-------------------------------------------------- */

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", FRONTEND_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  res.setHeader("Access-Control-Allow-Credentials", "true");
}

/* --------------------------------------------------
   JSON RESPONSE
-------------------------------------------------- */

function sendJson(res, status, data) {
  setCors(res);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(data));
}

/* --------------------------------------------------
   REDIRECT
-------------------------------------------------- */

function redirect(res, location) {
  setCors(res);

  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store"
  });

  res.end();
}

/* --------------------------------------------------
   PKCE
-------------------------------------------------- */

function createCodeVerifier() {
  return crypto
    .randomBytes(64)
    .toString("base64url")
    .slice(0, 128);
}

function createCodeChallenge(verifier) {
  return crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
}

function createState() {
  return crypto.randomBytes(32).toString("hex");
}

function createSessionId() {
  return crypto.randomBytes(48).toString("base64url");
}

/* --------------------------------------------------
   COOKIE PARSER
-------------------------------------------------- */

function getCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};

  header.split(";").forEach((part) => {
    const index = part.indexOf("=");

    if (index === -1) return;

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  });

  return cookies;
}

/* --------------------------------------------------
   SESSION
-------------------------------------------------- */

function getSession(req) {
  const cookies = getCookies(req);
  const sessionId = cookies.nextrade_session;

  if (!sessionId) {
    return null;
  }

  const session = sessions.get(sessionId);

  if (!session) {
    return null;
  }

  if (
    session.expiresAt &&
    Date.now() >= session.expiresAt
  ) {
    sessions.delete(sessionId);
    return null;
  }

  return {
    id: sessionId,
    data: session
  };
}

/* --------------------------------------------------
   SESSION COOKIE
-------------------------------------------------- */

function setSessionCookie(res, sessionId, maxAge) {
  res.setHeader(
    "Set-Cookie",
    [
      `nextrade_session=${encodeURIComponent(sessionId)}`,
      "HttpOnly",
      "Secure",
      "SameSite=None",
      "Path=/",
      `Max-Age=${maxAge}`
    ].join("; ")
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    [
      "nextrade_session=",
      "HttpOnly",
      "Secure",
      "SameSite=None",
      "Path=/",
      "Max-Age=0"
    ].join("; ")
  );
}

/* --------------------------------------------------
   CLEANUP
-------------------------------------------------- */

function cleanupStorage() {
  const now = Date.now();

  for (const [state, data] of oauthStates.entries()) {
    if (
      now - data.createdAt >
      10 * 60 * 1000
    ) {
      oauthStates.delete(state);
    }
  }

  for (const [sessionId, session] of sessions.entries()) {
    if (
      session.expiresAt &&
      now >= session.expiresAt
    ) {
      sessions.delete(sessionId);
    }
  }
}

setInterval(cleanupStorage, 5 * 60 * 1000);

/* --------------------------------------------------
   HTTP SERVER
-------------------------------------------------- */

const server = http.createServer(async (req, res) => {
  setCors(res);

  const parsedUrl = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  const pathname = parsedUrl.pathname;

  /* OPTIONS */

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  /* ------------------------------------------------
     ROOT
  ------------------------------------------------ */

  if (
    req.method === "GET" &&
    pathname === "/"
  ) {
    sendJson(res, 200, {
      service: "NEXTRADE Backend",
      status: "online",
      backend: BACKEND_URL,
      derivConnected,
      oauthConfigured: Boolean(
        DERIV_CLIENT_ID &&
        DERIV_REDIRECT_URI
      ),
      markets: symbols.length
    });

    return;
  }

  /* ------------------------------------------------
     HEALTH
  ------------------------------------------------ */

  if (
    req.method === "GET" &&
    pathname === "/health"
  ) {
    sendJson(res, 200, {
      status: "ok",
      service: "NEXTRADE Backend",
      derivConnected,
      oauthConfigured: Boolean(
        DERIV_CLIENT_ID &&
        DERIV_REDIRECT_URI
      ),
      markets: symbols.length,
      timestamp: Date.now()
    });

    return;
  }

  /* ------------------------------------------------
     API STATUS
  ------------------------------------------------ */

  if (
    req.method === "GET" &&
    pathname === "/api/status"
  ) {
    sendJson(res, 200, {
      success: true,
      backend: "online",
      derivConnected,
      oauthConfigured: Boolean(
        DERIV_CLIENT_ID &&
        DERIV_REDIRECT_URI
      ),
      symbols
    });

    return;
  }

  /* ------------------------------------------------
     OAUTH STATUS
  ------------------------------------------------ */

  if (
    req.method === "GET" &&
    pathname === "/oauth/status"
  ) {
    sendJson(res, 200, {
      oauthConfigured: Boolean(
        DERIV_CLIENT_ID &&
        DERIV_REDIRECT_URI
      ),
      clientIdConfigured: Boolean(
        DERIV_CLIENT_ID
      ),
      redirectUriConfigured: Boolean(
        DERIV_REDIRECT_URI
      ),
      redirectUri:
        DERIV_REDIRECT_URI || null
    });

    return;
  }

  /* ------------------------------------------------
     START DERIV OAUTH
  ------------------------------------------------ */

  if (
    req.method === "GET" &&
    pathname === "/oauth/authorize"
  ) {
    if (
      !DERIV_CLIENT_ID ||
      !DERIV_REDIRECT_URI
    ) {
      sendJson(res, 500, {
        error:
          "Deriv OAuth environment variables are not configured."
      });

      return;
    }

    const verifier = createCodeVerifier();
    const challenge = createCodeChallenge(verifier);
    const state = createState();

    oauthStates.set(state, {
      verifier,
      createdAt: Date.now()
    });

    const params = new URLSearchParams({
      response_type: "code",
      client_id: DERIV_CLIENT_ID,
      redirect_uri: DERIV_REDIRECT_URI,
      scope: "trade",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256"
    });

    const authorizationUrl =
      "https://auth.deriv.com/oauth2/auth?" +
      params.toString();

    redirect(res, authorizationUrl);

    return;
  }

  /* ------------------------------------------------
     OAUTH CALLBACK
  ------------------------------------------------ */

  if (
    req.method === "GET" &&
    pathname === "/oauth/callback"
  ) {
    const code =
      parsedUrl.searchParams.get("code");

    const state =
      parsedUrl.searchParams.get("state");

    const error =
      parsedUrl.searchParams.get("error");

    if (error) {
      redirect(
        res,
        `${FRONTEND_ORIGIN}/login.html?oauth_error=${encodeURIComponent(
          error
        )}`
      );

      return;
    }

    if (!code || !state) {
      redirect(
        res,
        `${FRONTEND_ORIGIN}/login.html?oauth_error=missing_authorization_data`
      );

      return;
    }

    const saved = oauthStates.get(state);

    if (!saved) {
      redirect(
        res,
        `${FRONTEND_ORIGIN}/login.html?oauth_error=invalid_or_expired_state`
      );

      return;
    }

    oauthStates.delete(state);

    try {
      const tokenResponse = await fetch(
        "https://auth.deriv.com/oauth2/token",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded"
          },

          body: new URLSearchParams({
            grant_type:
              "authorization_code",

            client_id:
              DERIV_CLIENT_ID,

            code,

            code_verifier:
              saved.verifier,

            redirect_uri:
              DERIV_RED
