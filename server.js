const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const DERIV_CLIENT_ID =
  process.env.DERIV_CLIENT_ID || "";

const BACKEND_URL =
  "https://nextrade-backened.onrender.com";

const FRONTEND_URL =
  "https://asikomonica4855-ai.github.io/Nextrade";

const DERIV_REDIRECT_URI =
  process.env.DERIV_REDIRECT_URI ||
  BACKEND_URL + "/oauth/callback";

/*
 * CURRENT PUBLIC DERIV MARKET DATA
 * No App ID or authentication required.
 */
const DERIV_PUBLIC_WS =
  "wss://api.derivws.com/trading/v1/options/ws/public";

const DERIV_API =
  "https://api.derivws.com";

const SYMBOLS = [
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

let derivSocket = null;
let derivConnected = false;

const clients = new Set();
const sessions = new Map();
const oauthStates = new Map();

/* =========================
   HELPERS
========================= */

function setCors(res) {
  res.setHeader(
    "Access-Control-Allow-Origin",
    FRONTEND_URL
  );

  res.setHeader(
    "Access-Control-Allow-Credentials",
    "true"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
}

function sendJson(res, status, data) {
  setCors(res);

  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(data));
}

function redirect(res, url) {
  setCors(res);

  res.writeHead(302, {
    Location: url,
    "Cache-Control": "no-store"
  });

  res.end();
}

function randomHex(bytes = 32) {
  return crypto
    .randomBytes(bytes)
    .toString("hex");
}

function createSessionId() {
  return crypto
    .randomBytes(48)
    .toString("base64url");
}

function createVerifier() {
  return crypto
    .randomBytes(64)
    .toString("base64url");
}

function createChallenge(verifier) {
  return crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
}

/* =========================
   COOKIES / SESSIONS
========================= */

function getCookies(req) {
  const result = {};
  const header =
    req.headers.cookie || "";

  header
    .split(";")
    .forEach(part => {
      const index =
        part.indexOf("=");

      if (index === -1) return;

      const key =
        part
          .slice(0, index)
          .trim();

      const value =
        part
          .slice(index + 1)
          .trim();

      try {
        result[key] =
          decodeURIComponent(value);
      } catch {
        result[key] = value;
      }
    });

  return result;
}

function getSession(req) {
  const cookies =
    getCookies(req);

  const id =
    cookies.nextrade_session;

  if (!id) return null;

  const session =
    sessions.get(id);

  if (!session) return null;

  if (
    session.expiresAt &&
    Date.now() >
      session.expiresAt
  ) {
    sessions.delete(id);
    return null;
  }

  return {
    id,
    data: session
  };
}

function setSessionCookie(
  res,
  sessionId
) {
  res.setHeader(
    "Set-Cookie",
    [
      "nextrade_session=" +
        encodeURIComponent(
          sessionId
        ),
      "HttpOnly",
      "Secure",
      "SameSite=None",
      "Path=/",
      "Max-Age=604800"
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

/* =========================
   FRONTEND BROADCAST
========================= */

function broadcast(data) {
  const message =
    JSON.stringify(data);

  for (
    const client of clients
  ) {
    if (
      client.readyState ===
      WebSocket.OPEN
    ) {
      try {
        client.send(message);
      } catch {}
    }
  }
}

/* =========================
   PUBLIC DERIV WEBSOCKET
========================= */

function connectDeriv() {
  if (derivSocket) {
    try {
      derivSocket.close();
    } catch {}
  }

  console.log(
    "Connecting to current Deriv public WebSocket..."
  );

  console.log(
    DERIV_PUBLIC_WS
  );

  derivSocket =
    new WebSocket(
      DERIV_PUBLIC_WS
    );

  derivSocket.on(
    "open",
    () => {
      console.log(
        "Deriv public WebSocket connected"
      );

      derivConnected = true;

      broadcast({
        type: "status",
        connected: true
      });

      /*
       * Subscribe to all supported
       * public market symbols.
       */

      for (
        const symbol of SYMBOLS
      ) {
        try {
          derivSocket.send(
            JSON.stringify({
              ticks: symbol,
              subscribe: 1
            })
          );
        } catch (error) {
          console.error(
            "Subscription error:",
            error.message
          );
        }
      }
    }
  );

  derivSocket.on(
    "message",
    raw => {
      try {
        const data =
          JSON.parse(
            raw.toString()
          );

        /*
         * Tick received.
         */

        if (
          data.msg_type ===
            "tick" &&
          data.tick
        ) {
          const price =
            Number(
              data.tick.quote
            );

          const symbol =
            data.tick.symbol;

          if (
            symbol &&
            Number.isFinite(price)
          ) {
            broadcast({
              type: "tick",

              data: {
                symbol,
                price,
                epoch:
                  data.tick.epoch
              }
            });
          }
        }

        /*
         * API error.
         */

        if (data.error) {
          console.error(
            "Deriv public error:",
            data.error
          );

          broadcast({
            type:
              "deriv_error",

            error:
              data.error
          });
        }
      } catch (error) {
        console.error(
          "Deriv message error:",
          error.message
        );
      }
    }
  );

  derivSocket.on(
    "close",
    () => {
      derivConnected = false;

      console.log(
        "Deriv public WebSocket closed"
      );

      broadcast({
        type: "status",
        connected: false
      });

      setTimeout(
        connectDeriv,
        5000
      );
    }
  );

  derivSocket.on(
    "error",
    error => {
      derivConnected = false;

      console.error(
        "Deriv public WebSocket error:",
        error.message
      );
    }
  );
}

/* =========================
   CURRENT DERIV ACCOUNT API
========================= */

async function getDerivAccounts(
  accessToken
) {
  if (!accessToken) {
    return [];
  }

  try {
    const response =
      await fetch(
        DERIV_API +
          "/trading/v1/options/accounts",
        {
          method: "GET",

          headers: {
            "Authorization":
              "Bearer " +
              accessToken,

            "Deriv-App-ID":
              DERIV_CLIENT_ID,

            "Accept":
              "application/json"
          }
        }
      );

    const data =
      await response.json();

    if (!response.ok) {
      console
