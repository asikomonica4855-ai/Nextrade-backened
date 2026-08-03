const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const DERIV_CLIENT_ID = process.env.DERIV_CLIENT_ID;
const DERIV_REDIRECT_URI = process.env.DERIV_REDIRECT_URI;

const FRONTEND_ORIGIN =
  "https://asikomonica4855-ai.github.io";

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

/* ---------------- CORS ---------------- */

function setCors(res) {
  res.setHeader(
    "Access-Control-Allow-Origin",
    FRONTEND_ORIGIN
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  res.setHeader(
    "Access-Control-Allow-Credentials",
    "true"
  );
}

/* ---------------- JSON ---------------- */

function sendJson(res, status, data) {
  setCors(res);

  res.writeHead(status, {
    "Content-Type": "application/json"
  });

  res.end(JSON.stringify(data));
}

/* ---------------- RANDOM IDs ---------------- */

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
  return crypto
    .randomBytes(32)
    .toString("hex");
}

function createSessionId() {
  return crypto
    .randomBytes(48)
    .toString("base64url");
}

/* ---------------- COOKIES ---------------- */

function getCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};

  header.split(";").forEach(part => {
    const index = part.indexOf("=");

    if (index === -1) return;

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    cookies[key] = decodeURIComponent(value);
  });

  return cookies;
}

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
    Date.now() > session.expiresAt
  ) {
    sessions.delete(sessionId);
    return null;
  }

  return {
    id: sessionId,
    data: session
  };
}

/* ---------------- CLEANUP ---------------- */

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
      now > session.expiresAt
    ) {
      sessions.delete(sessionId);
    }
  }
}

setInterval(cleanupStorage, 5 * 60 * 1000);

/* ---------------- HTTP SERVER ---------------- */

const server = http.createServer(
  async (req, res) => {

    setCors(res);

    /* CORS preflight */

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    /* ROOT */

    if (
      req.method === "GET" &&
      req.url === "/"
    ) {
      sendJson(res, 200, {
        service: "NEXTRADE Live Data",
        status: "online",
        derivConnected
      });

      return;
    }

    /* HEALTH */

    if (
      req.method === "GET" &&
      req.url === "/health"
    ) {
      sendJson(res, 200, {
        status: "ok",
        derivConnected
      });

      return;
    }

    /* OAUTH STATUS */

    if (
      req.method === "GET" &&
      req.url === "/oauth/status"
    ) {
      sendJson(res, 200, {
        oauthConfigured:
          Boolean(
            DERIV_CLIENT_ID &&
            DERIV_REDIRECT_URI
          )
      });

      return;
    }

    /* ---------------- OAUTH START ---------------- */

    if (
      req.method === "GET" &&
      req.url === "/oauth/authorize"
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

      const verifier =
        createCodeVerifier();

      const challenge =
        createCodeChallenge(verifier);

      const state =
        createState();

      oauthStates.set(
        state,
        {
          verifier,
          createdAt: Date.now()
        }
      );

      const params =
        new URLSearchParams({
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

      res.writeHead(302, {
        Location: authorizationUrl
      });

      res.end();

      return;
    }

    /* ---------------- OAUTH CALLBACK ---------------- */

    if (
      req.method === "GET" &&
      req.url.startsWith("/oauth/callback")
    ) {

      const parsed =
        new URL(
          req.url,
          `http://${req.headers.host}`
        );

      const code =
        parsed.searchParams.get("code");

      const state =
        parsed.searchParams.get("state");

      const error =
        parsed.searchParams.get("error");

      if (error) {
        sendJson(res, 400, {
          error
        });

        return;
      }

      if (!code || !state) {
        sendJson(res, 400, {
          error:
            "Missing OAuth code or state."
        });

        return;
      }

      const saved =
        oauthStates.get(state);

      if (!saved) {
        sendJson(res, 400, {
          error:
            "Invalid or expired OAuth state."
        });

        return;
      }

      oauthStates.delete(state);

      try {

        const tokenResponse =
          await fetch(
            "https://auth.deriv.com/oauth2/token",
            {
              method: "POST",

              headers: {
                "Content-Type":
                  "application/x-www-form-urlencoded"
              },

              body:
                new URLSearchParams({
                  grant_type:
                    "authorization_code",

                  client_id:
                    DERIV_CLIENT_ID,

                  code,

                  code_verifier:
                    saved.verifier,

                  redirect_uri:
                    DERIV_REDIRECT_URI
                })
            }
          );

        const tokenData =
          await tokenResponse.json();

        if (!tokenResponse.ok) {

          console.error(
            "OAuth token exchange failed"
          );

          sendJson(res, 400, {
            error:
              "OAuth token exchange failed.",
            details:
              tokenData
          });

          return;
        }

        if (!tokenData.access_token) {

          sendJson(res, 400, {
            error:
              "Deriv did not return an access token."
          });

          return;
        }

        const sessionId =
          createSessionId();

        const expiresIn =
          Number(
            tokenData.expires_in || 3600
          );

        sessions.set(
          sessionId,
          {
            accessToken:
              tokenData.access_token,

            createdAt:
              Date.now(),

            expiresAt:
              Date.now() +
              expiresIn * 1000
          }
        );

        res.setHeader(
          "Set-Cookie",
          [
            `nextrade_session=${encodeURIComponent(sessionId)}`,
            "HttpOnly",
            "Secure",
            "SameSite=None",
            "Path=/",
            `Max-Age=${expiresIn}`
          ].join("; ")
        );

        sendJson(res, 200, {
          success: true,
          authenticated: true,
          expires_in: expiresIn
        });

        return;

      } catch (error) {

        console.error(
          "OAuth callback error:",
          error.message
        );

        sendJson(res, 500, {
          error:
            "OAuth callback failed."
        });

        return;
      }
    }

    /* ---------------- SESSION ---------------- */

    if (
      req.method === "GET" &&
      req.url === "/api/session"
    ) {

      const session =
        getSession(req);

      if (!session) {

        sendJson(res, 200, {
          authenticated: false
        });

        return;
      }

      sendJson(res, 200, {
        authenticated: true,
        expiresAt:
          session.data.expiresAt
      });

      return;
    }

    /* ---------------- LOGOUT ---------------- */

    if (
      req.method === "POST" &&
      req.url === "/api/logout"
    ) {

      const cookies =
        getCookies(req);

      const sessionId =
        cookies.nextrade_session;

      if (sessionId) {
        sessions.delete(sessionId);
      }

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

      sendJson(res, 200, {
        success: true
      });

      return;
    }

    /* ---------------- DERIV ACCOUNT ---------------- */

    if (
      req.method === "GET" &&
      req.url === "/api/accounts"
    ) {

      const session =
        getSession(req);

      if (!session) {

        sendJson(res, 401, {
          error:
            "Not authenticated."
        });

        return;
      }

      try {

        const response =
          await fetch(
            "https://api.derivws.com/trading/v1/options/accounts",
            {
              method: "GET",

              headers: {
                Authorization:
                  `Bearer ${session.data.accessToken}`,

                Accept:
                  "application/json"
              }
            }
          );

        const data =
          await response.json();

        if (!response.ok) {

          sendJson(
            res,
            response.status,
            {
              error:
                "Unable to retrieve Deriv accounts.",
              details:
                data
            }
          );

          return;
        }

        sendJson(res, 200, {
          success: true,
          accounts: data
        });

        return;

      } catch (error) {

        console.error(
          "Account request failed:",
          error.message
        );

        sendJson(res, 500, {
          error:
            "Account request failed."
        });

        return;
      }
    }

    /* ---------------- AUTH CHECK ---------------- */

    if (
      req.method === "GET" &&
      req.url === "/api/otp"
    ) {

      const session =
        getSession(req);

      if (!session) {

        sendJson(res, 401, {
          error:
            "Not authenticated."
        });

        return;
      }

      sendJson(res, 200, {
        success: true,
        authenticated: true,
        message:
          "Authenticated Deriv account confirmed."
      });

      return;
    }

    /* ---------------- 404 ---------------- */

    sendJson(res, 404, {
      error: "Not found"
    });
  }
);

/* ---------------- BROWSER WEBSOCKET ---------------- */

const wss =
  new WebSocket.Server({
    server
  });

function broadcast(message) {

  const text =
    JSON.stringify(message);

  clients.forEach(client => {

    if (
      client.readyState ===
      WebSocket.OPEN
    ) {
      client.send(text);
    }

  });
}

/* ---------------- DERIV PUBLIC DATA ---------------- */

function connectToDeriv() {

  if (deriv) {

    try {
      deriv.close();
    } catch (e) {}

  }

  derivConnected = false;

  broadcast({
    type: "status",
    connected: false
  });

  console.log(
    "Connecting to Deriv..."
  );

  deriv =
    new WebSocket(
      "wss://api.derivws.com/trading/v1/options/ws/public"
    );

  deriv.on("open", () => {

    console.log(
      "Deriv WebSocket connected"
    );

    derivConnected = true;

    broadcast({
      type: "status",
      connected: true
    });

    symbols.forEach(symbol => {

      deriv.send(
        JSON.stringify({
          ticks: symbol,
          subscribe: 1
        })
      );

    });

  });

  deriv.on("message", raw => {

    try {

      const data =
        JSON.parse(
          raw.toString()
        );

      if (
        data.msg_type === "tick" &&
        data.tick
      ) {

        broadcast({
          type: "tick",

          data: {
            symbol:
              data.tick.symbol,

            price:
              Number(
                data.tick.quote
              ),

            epoch:
              Number(
                data.tick.epoch
              )
          }
        });

      }

      if (data.error) {

        console.error(
          "Deriv API error:",
          data.error
        );

        broadcast({
          type: "deriv_error",
          error:
            data.error
        });
      }

    } catch (error) {

      console.error(
        "Unable to parse Deriv message:",
        error.message
      );

    }

  });

  deriv.on("error", error => {

    console.error(
      "Deriv WebSocket error:",
      error.message
    );

    derivConnected = false;

    broadcast({
      type: "status",
      connected: false,
      error:
        error.message
    });

  });

  deriv.on("close", (code, reason) => {

    console.log(
      "Deriv connection closed:",
      code,
      reason
        ? reason.toString()
        : ""
    );

    derivConnected = false;

    broadcast({
      type: "status",
      connected: false,
      closeCode: code
    });

    setTimeout(
      connectToDeriv,
      5000
    );

  });

}

/* ---------------- BROWSER CONNECTION ---------------- */

wss.on("connection", client => {

  console.log(
    "NEXTRADE browser connected"
  );

  clients.add(client);

  client.send(
    JSON.stringify({
      type: "status",
      connected:
        derivConnected
    })
  );

  client.on("close", () => {

    clients.delete(client);

    console.log(
      "NEXTRADE browser disconnected"
    );

  });

});

/* ---------------- START ---------------- */

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `NEXTRADE backend listening on ${PORT}`
    );

    console.log(
      "OAuth configured:",
      Boolean(
        DERIV_CLIENT_ID &&
        DERIV_REDIRECT_URI
      )
    );

    connectToDeriv();

  }
);
