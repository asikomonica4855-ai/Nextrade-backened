const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const DERIV_CLIENT_ID = process.env.DERIV_CLIENT_ID || "";

const BACKEND_URL =
  "https://nextrade-backened.onrender.com";

const FRONTEND_URL =
  "https://asikomonica4855-ai.github.io/Nextrade";

const DERIV_REDIRECT_URI =
  process.env.DERIV_REDIRECT_URI ||
  BACKEND_URL + "/oauth/callback";

/* =========================
   DERIV WEBSOCKET
========================= */

const DERIV_WS_URL =
  "wss://ws.derivws.com/websockets/v3?app_id=" +
  encodeURIComponent(DERIV_CLIENT_ID);

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

function cors(res) {
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

function json(res, status, data) {
  cors(res);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function redirect(res, url) {
  cors(res);
  res.writeHead(302, {
    Location: url,
    "Cache-Control": "no-store"
  });
  res.end();
}

function randomHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function createSessionId() {
  return crypto.randomBytes(48).toString("base64url");
}

function createVerifier() {
  return crypto.randomBytes(64).toString("base64url");
}

function createChallenge(verifier) {
  return crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
}

/* =========================
   COOKIES
========================= */

function cookies(req) {
  const result = {};
  const header = req.headers.cookie || "";

  header.split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i < 0) return;

    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();

    result[key] = decodeURIComponent(value);
  });

  return result;
}

function getSession(req) {
  const id = cookies(req).nextrade_session;

  if (!id) return null;

  const session = sessions.get(id);

  if (!session) return null;

  if (
    session.expiresAt &&
    Date.now() > session.expiresAt
  ) {
    sessions.delete(id);
    return null;
  }

  return {
    id,
    data: session
  };
}

function setCookie(res, id) {
  res.setHeader(
    "Set-Cookie",
    "nextrade_session=" +
      encodeURIComponent(id) +
      "; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=604800"
  );
}

function clearCookie(res) {
  res.setHeader(
    "Set-Cookie",
    "nextrade_session=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0"
  );
}

/* =========================
   MARKET BROADCAST
========================= */

function broadcast(data) {
  const message = JSON.stringify(data);

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch {}
    }
  }
}

/* =========================
   DERIV PUBLIC DATA
========================= */

function connectDeriv() {
  if (!DERIV_CLIENT_ID) {
    console.error(
      "DERIV_CLIENT_ID is missing."
    );

    derivConnected = false;

    broadcast({
      type: "status",
      connected: false
    });

    setTimeout(connectDeriv, 10000);
    return;
  }

  if (derivSocket) {
    try {
      derivSocket.close();
    } catch {}
  }

  console.log(
    "Connecting to Deriv..."
  );

  console.log(
    "App ID:",
    DERIV_CLIENT_ID
  );

  derivSocket = new WebSocket(
    DERIV_WS_URL
  );

  derivSocket.on("open", () => {
    console.log(
      "Deriv WebSocket connected"
    );

    derivConnected = true;

    broadcast({
      type: "status",
      connected: true
    });

    for (const symbol of SYMBOLS) {
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
  });

  derivSocket.on("message", raw => {
    try {
      const data = JSON.parse(
        raw.toString()
      );

      if (
        data.msg_type === "tick" &&
        data.tick
      ) {
        const price =
          Number(data.tick.quote);

        if (
          data.tick.symbol &&
          Number.isFinite(price)
        ) {
          broadcast({
            type: "tick",
            data: {
              symbol:
                data.tick.symbol,
              price,
              epoch:
                data.tick.epoch
            }
          });
        }
      }

      if (data.error) {
        console.error(
          "Deriv error:",
          data.error
        );

        broadcast({
          type: "deriv_error",
          error: data.error
        });
      }
    } catch (error) {
      console.error(
        "Message error:",
        error.message
      );
    }
  });

  derivSocket.on("close", () => {
    derivConnected = false;

    console.log(
      "Deriv WebSocket closed"
    );

    broadcast({
      type: "status",
      connected: false
    });

    setTimeout(
      connectDeriv,
      5000
    );
  });

  derivSocket.on("error", error => {
    derivConnected = false;

    console.error(
      "Deriv WebSocket error:",
      error.message
    );
  });
}

/* =========================
   HTTP SERVER
========================= */

const server = http.createServer(
  async (req, res) => {

    cors(res);

    const url = new URL(
      req.url,
      "http://" +
        (req.headers.host || "localhost")
    );

    const path = url.pathname;

    /* OPTIONS */

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    /* ROOT */

    if (
      req.method === "GET" &&
      path === "/"
    ) {
      json(res, 200, {
        service: "NEXTRADE Backend",
        status: "online",
        derivConnected,
        markets: SYMBOLS.length,
        websocket: "available"
      });
      return;
    }

    /* HEALTH */

    if (
      req.method === "GET" &&
      path === "/health"
    ) {
      json(res, 200, {
        status: "ok",
        derivConnected,
        oauthConfigured:
          Boolean(DERIV_CLIENT_ID),
        markets: SYMBOLS.length,
        timestamp: Date.now()
      });
      return;
    }

    /* STATUS */

    if (
      req.method === "GET" &&
      path === "/api/status"
    ) {
      json(res, 200, {
        success: true,
        backend: "online",
        derivConnected,
        oauthConfigured:
          Boolean(DERIV_CLIENT_ID),
        symbols: SYMBOLS
      });
      return;
    }

    /* SESSION */

    if (
      req.method === "GET" &&
      path === "/api/session"
    ) {
      const session =
        getSession(req);

      json(res, 200, {
        authenticated:
          Boolean(session),
        user:
          session?.data?.user ||
          null
      });

      return;
    }

    /* ACCOUNTS */

    if (
      req.method === "GET" &&
      path === "/api/accounts"
    ) {
      const session =
        getSession(req);

      if (!session) {
        json(res, 401, {
          success: false,
          error: "Not authenticated"
        });
        return;
      }

      json(res, 200, {
        success: true,
        accounts:
          session.data.accounts || []
      });

      return;
    }

    /* OAUTH STATUS */

    if (
      req.method === "GET" &&
      path === "/oauth/status"
    ) {
      json(res, 200, {
        oauthConfigured:
          Boolean(DERIV_CLIENT_ID),
        redirectUri:
          DERIV_REDIRECT_URI
      });

      return;
    }

    /* OAUTH LOGIN */

    if (
      req.method === "GET" &&
      path === "/oauth/authorize"
    ) {

      if (!DERIV_CLIENT_ID) {
        json(res, 500, {
          success: false,
          error:
            "DERIV_CLIENT_ID is not configured."
        });
        return;
      }

      const verifier =
        createVerifier();

      const challenge =
        createChallenge(verifier);

      const state =
        randomHex(32);

      oauthStates.set(state, {
        verifier,
        createdAt: Date.now()
      });

      const params =
        new URLSearchParams();

      params.set(
        "response_type",
        "code"
      );

      params.set(
        "client_id",
        DERIV_CLIENT_ID
      );

      params.set(
        "redirect_uri",
        DERIV_REDIRECT_URI
      );

      params.set(
        "scope",
        "trade"
      );

      params.set(
        "state",
        state
      );

      params.set(
        "code_challenge",
        challenge
      );

      params.set(
        "code_challenge_method",
        "S256"
      );

      const authUrl =
        "https://auth.deriv.com/oauth2/auth?" +
        params.toString();

      redirect(
        res,
        authUrl
      );

      return;
    }

    /* OAUTH CALLBACK */

    if (
      req.method === "GET" &&
      path === "/oauth/callback"
    ) {

      const code =
        url.searchParams.get("code");

      const state =
        url.searchParams.get("state");

      const error =
        url.searchParams.get("error");

      if (error) {
        redirect(
          res,
          FRONTEND_URL +
            "/login.html?oauth_error=" +
            encodeURIComponent(error)
        );
        return;
      }

      if (!code || !state) {
        json(res, 400, {
          success: false,
          error:
            "Missing OAuth code or state."
        });
        return;
      }

      const oauth =
        oauthStates.get(state);

      if (!oauth) {
        json(res, 400, {
          success: false,
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
                    oauth.verifier,
                  redirect_uri:
                    DERIV_REDIRECT_URI
                })
            }
          );

        const tokenData =
          await tokenResponse.json();

        if (
          !tokenResponse.ok ||
          !tokenData.access_token
        ) {
          console.error(
            "Token error:",
            tokenData
          );

          redirect(
            res,
            FRONTEND_URL +
              "/login.html?oauth_error=token_exchange_failed"
          );

          return;
        }

        const accessToken =
          tokenData.access_token;

        let accounts = [];

        try {

          const ws =
            new WebSocket(
              DERIV_WS_URL
            );

          accounts =
            await new Promise(resolve => {

              let done = false;

              const finish = value => {
                if (done) return;

                done = true;

                try {
                  ws.close();
                } catch {}

                resolve(value);
              };

              const timer =
                setTimeout(
                  () => finish([]),
                  10000
                );

              ws.on("open", () => {
                ws.send(
                  JSON.stringify({
                    authorize:
                      accessToken
                  })
                );
              });

              ws.on("message", raw => {

                try {

                  const data =
                    JSON.parse(
                      raw.toString()
                    );

                  if (data.error) {
                    clearTimeout(timer);
                    finish([]);
                    return;
                  }

                  if (
                    data.msg_type ===
                    "authorize"
                  ) {

                    clearTimeout(timer);

                    finish([
                      {
                        loginid:
                          data.authorize?.loginid,
                        fullname:
                          data.authorize?.fullname,
                        currency:
                          data.authorize?.currency,
                        balance:
                          data.authorize?.balance,
                        email:
                          data.authorize?.email
                      }
                    ]);
                  }

                } catch {
                  finish([]);
                }
              });

              ws.on("error", () => {
                clearTimeout(timer);
                finish([]);
              });

              ws.on("close", () => {
                clearTimeout(timer);
                finish([]);
              });
            });

        } catch {
          accounts = [];
        }

        const sessionId =
          createSessionId();

        sessions.set(
          sessionId,
          {
            accessToken,
            accounts,
            user:
              accounts[0] || null,
            createdAt:
              Date.now(),
            expiresAt:
              Date.now() +
              7 *
              24 *
              60 *
              60 *
              1000
          }
        );

        setCookie(
          res,
          sessionId
        );

        console.log(
          "OAuth login successful."
        );

        redirect(
          res,
          FRONTEND_URL +
            "/markets.html"
        );

        return;

      } catch (error) {

        console.error(
          "OAuth callback error:",
          error
        );

        redirect(
          res,
          FRONTEND_URL +
            "/login.html?oauth_error=oauth_callback_failed"
        );

        return;
      }
    }

    /* LOGOUT */

    if (
      req.method === "POST" &&
      path === "/api/logout"
    ) {

      const session =
        getSession(req);

      if (session) {
        sessions.delete(
          session.id
        );
      }

      clearCookie(res);

      json(res, 200, {
        success: true
      });

      return;
    }

    /* NOT FOUND */

    json(res, 404, {
      success: false,
      error: "Not found",
      path
    });
  }
);

/* =========================
   WEBSOCKET SERVER
========================= */

const websocketServer =
  new WebSocket.Server({
    server
  });

websocketServer.on(
  "connection",
  client => {

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
    });

    client.on("error", () => {
      clients.delete(client);
    });
  }
);

/* =========================
   START
========================= */

server.listen(
  PORT,
  () => {

    console.log(
      "================================"
    );

    console.log(
      "NEXTRADE BACKEND STARTED"
    );

    console.log(
      "Port:",
      PORT
    );

    console.log(
      "Backend:",
      BACKEND_URL
    );

    console.log(
      "Frontend:",
      FRONTEND_URL
    );

    console.log(
      "OAuth configured:",
      Boolean(DERIV_CLIENT_ID)
    );

    console.log(
      "Markets:",
      SYMBOLS.length
    );

    console.log(
      "================================"
    );

    connectDeriv();
  }
);

/* =========================
   ERROR HANDLERS
========================= */

process.on(
  "uncaughtException",
  error => {
    console.error(
      "UNCAUGHT EXCEPTION:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "UNHANDLED REJECTION:",
      error
    );
  }
);
