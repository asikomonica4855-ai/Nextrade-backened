const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");

/* =========================================================
   CONFIGURATION
========================================================= */

const PORT = process.env.PORT || 10000;

const DERIV_CLIENT_ID =
  process.env.DERIV_CLIENT_ID || "";

const DERIV_REDIRECT_URI =
  process.env.DERIV_REDIRECT_URI || "";

const FRONTEND_ORIGIN =
  "https://asikomonica4855-ai.github.io";

const BACKEND_URL =
  "https://nextrade-backened.onrender.com";

const DERIV_PUBLIC_WS =
  "wss://api.derivws.com/trading/v1/options/ws/public";

const DERIV_AUTH_API =
  "https://api.derivws.com/trading/v1/options/accounts";

const DERIV_OAUTH_AUTHORIZE =
  "https://auth.deriv.com/oauth2/auth";

const DERIV_OAUTH_TOKEN =
  "https://auth.deriv.com/oauth2/token";

/* =========================================================
   NEXTRADE MARKETS
========================================================= */

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

/* =========================================================
   STATE
========================================================= */

let deriv = null;
let derivConnected = false;

const clients = new Set();

/*
  OAuth state storage

  state -> {
    verifier,
    createdAt
  }
*/
const oauthStates = new Map();

/*
  Login sessions

  sessionId -> {
    accessToken,
    createdAt,
    expiresAt
  }

  The Deriv access token never goes to the browser.
*/
const sessions = new Map();

/* =========================================================
   CORS
========================================================= */

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
    "Content-Type, Authorization"
  );

  res.setHeader(
    "Access-Control-Allow-Credentials",
    "true"
  );
}

/* =========================================================
   JSON RESPONSE
========================================================= */

function sendJson(res, status, data) {
  setCors(res);

  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",

    "Cache-Control":
      "no-store, no-cache, must-revalidate"
  });

  res.end(
    JSON.stringify(data)
  );
}

/* =========================================================
   REDIRECT
========================================================= */

function redirect(res, location) {
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store"
  });

  res.end();
}

/* =========================================================
   PKCE
========================================================= */

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

/* =========================================================
   RANDOM STATE
========================================================= */

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

/* =========================================================
   COOKIE PARSER
========================================================= */

function getCookies(req) {
  const header =
    req.headers.cookie || "";

  const cookies = {};

  header
    .split(";")
    .forEach((part) => {
      const index =
        part.indexOf("=");

      if (index === -1) {
        return;
      }

      const key =
        part
          .slice(0, index)
          .trim();

      const value =
        part
          .slice(index + 1)
          .trim();

      try {
        cookies[key] =
          decodeURIComponent(value);
      } catch {
        cookies[key] =
          value;
      }
    });

  return cookies;
}

/* =========================================================
   SESSION LOOKUP
========================================================= */

function getSession(req) {
  const cookies =
    getCookies(req);

  const sessionId =
    cookies.nextrade_session;

  if (!sessionId) {
    return null;
  }

  const session =
    sessions.get(sessionId);

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

/* =========================================================
   SESSION COOKIE
========================================================= */

function setSessionCookie(
  res,
  sessionId,
  maxAge
) {
  res.setHeader(
    "Set-Cookie",
    [
      `nextrade_session=${encodeURIComponent(
        sessionId
      )}`,

      "HttpOnly",

      "Secure",

      "SameSite=None",

      "Path=/",

      `Max-Age=${Math.max(
        0,
        Math.floor(maxAge)
      )}`
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

/* =========================================================
   STORAGE CLEANUP
========================================================= */

function cleanupStorage() {
  const now =
    Date.now();

  for (
    const [state, data]
    of oauthStates.entries()
  ) {
    if (
      now -
        data.createdAt >
      10 * 60 * 1000
    ) {
      oauthStates.delete(state);
    }
  }

  for (
    const [sessionId, session]
    of sessions.entries()
  ) {
    if (
      session.expiresAt &&
      now >= session.expiresAt
    ) {
      sessions.delete(sessionId);
    }
  }
}

setInterval(
  cleanupStorage,
  5 * 60 * 1000
);

/* =========================================================
   AUTHENTICATED DERIV REQUEST
========================================================= */

async function getDerivAccounts(
  accessToken
) {
  const response =
    await fetch(
      DERIV_AUTH_API,
      {
        method: "GET",

        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          Accept:
            "application/json"
        }
      }
    );

  let data;

  try {
    data =
      await response.json();
  } catch {
    data = null;
  }

  return {
    response,
    data
  };
}

/* =========================================================
   HTTP SERVER
========================================================= */

const server =
  http.createServer(
    async (req, res) => {

      setCors(res);

      const parsedUrl =
        new URL(
          req.url,
          `http://${
            req.headers.host ||
            "localhost"
          }`
        );

      const pathname =
        parsedUrl.pathname;

      /* ===================================================
         OPTIONS / CORS
      =================================================== */

      if (
        req.method === "OPTIONS"
      ) {
        res.writeHead(204);
        res.end();

        return;
      }

      /* ===================================================
         ROOT
      =================================================== */

      if (
        req.method === "GET" &&
        pathname === "/"
      ) {
        sendJson(res, 200, {
          service:
            "NEXTRADE Backend",

          status:
            "online",

          backend:
            BACKEND_URL,

          derivConnected,

          oauthConfigured:
            Boolean(
              DERIV_CLIENT_ID &&
              DERIV_REDIRECT_URI
            ),

          markets:
            symbols.length,

          symbols
        });

        return;
      }

      /* ===================================================
         HEALTH
      =================================================== */

      if (
        req.method === "GET" &&
        pathname === "/health"
      ) {
        sendJson(res, 200, {
          status:
            "ok",

          service:
            "NEXTRADE Backend",

          derivConnected,

          oauthConfigured:
            Boolean(
              DERIV_CLIENT_ID &&
              DERIV_REDIRECT_URI
            ),

          markets:
            symbols.length,

          timestamp:
            Date.now()
        });

        return;
      }

      /* ===================================================
         API STATUS
      =================================================== */

      if (
        req.method === "GET" &&
        pathname === "/api/status"
      ) {
        sendJson(res, 200, {
          success:
            true,

          backend:
            "online",

          derivConnected,

          oauthConfigured:
            Boolean(
              DERIV_CLIENT_ID &&
              DERIV_REDIRECT_URI
            ),

          symbols
        });

        return;
      }

      /* ===================================================
         OAUTH STATUS
      =================================================== */

      if (
        req.method === "GET" &&
        pathname === "/oauth/status"
      ) {
        sendJson(res, 200, {
          oauthConfigured:
            Boolean(
              DERIV_CLIENT_ID &&
              DERIV_REDIRECT_URI
            ),

          clientIdConfigured:
            Boolean(
              DERIV_CLIENT_ID
            ),

          redirectUriConfigured:
            Boolean(
              DERIV_REDIRECT_URI
            ),

          redirectUri:
            DERIV_REDIRECT_URI ||
            null
        });

        return;
      }

      /* ===================================================
         START OAUTH
      =================================================== */

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

        const verifier =
          createCodeVerifier();

        const challenge =
          createCodeChallenge(
            verifier
          );

        const state =
          createState();

        oauthStates.set(
          state,
          {
            verifier,

            createdAt:
              Date.now()
          }
        );

        const params =
          new URLSearchParams({
            response_type:
              "code",

            client_id:
              DERIV_CLIENT_ID,

            redirect_uri:
              DERIV_REDIRECT_URI,

            scope:
              "trade",

            state,

            code_challenge:
              challenge,

            code_challenge_method:
              "S256"
          });

        const authorizationUrl =
          DERIV_OAUTH_AUTHORIZE +
          "?" +
          params.toString();

        redirect(
          res,
          authorizationUrl
        );

        return;
      }

      /* ===================================================
         OAUTH CALLBACK
      =================================================== */

      if (
        req.method === "GET" &&
        pathname === "/oauth/callback"
      ) {

        const code =
          parsedUrl.searchParams.get(
            "code"
          );

        const state =
          parsedUrl.searchParams.get(
            "state"
          );

        const error =
          parsedUrl.searchParams.get(
            "error"
          );

        /* -----------------------------------------------
           DERIV RETURNED ERROR
        ------------------------------------------------ */

        if (error) {

          redirect(
            res,
            `${FRONTEND_ORIGIN}/login.html?oauth_error=${encodeURIComponent(
              error
            )}`
          );

          return;
        }

        /* -----------------------------------------------
           MISSING DATA
        ------------------------------------------------ */

        if (
          !code ||
          !state
        ) {

          redirect(
            res,
            `${FRONTEND_ORIGIN}/login.html?oauth_error=missing_authorization_data`
          );

          return;
        }

        /* -----------------------------------------------
           VERIFY STATE
        ------------------------------------------------ */

        const saved =
          oauthStates.get(
            state
          );

        if (!saved) {

          redirect(
            res,
            `${FRONTEND_ORIGIN}/login.html?oauth_error=invalid_or_expired_state`
          );

          return;
        }

        /*
         * State is single-use.
         */

        oauthStates.delete(
          state
        );

        try {

          /* ---------------------------------------------
             EXCHANGE CODE FOR TOKEN
          --------------------------------------------- */

          const tokenResponse =
            await fetch(
              DERIV_OAUTH_TOKEN,
              {
                method:
                  "POST",

                headers: {
                  "Content-Type":
                    "application/x-www-form-urlencoded",

                  Accept:
                    "application/json"
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

          let tokenData;

          try {
            tokenData =
              await tokenResponse.json();
          } catch {
            tokenData = {};
          }

          /* ---------------------------------------------
             TOKEN EXCHANGE FAILED
          --------------------------------------------- */

          if (
            !tokenResponse.ok ||
            !tokenData.access_token
          ) {

            console.error(
              "OAuth token exchange failed:",
              tokenData
            );

            redirect(
              res,
              `${FRONTEND_ORIGIN}/login.html?oauth_error=token_exchange_failed`
            );

            return;
          }

          /* ---------------------------------------------
             CREATE SESSION
          --------------------------------------------- */

          const sessionId =
            createSessionId();

          const expiresIn =
            Number(
              tokenData.expires_in ||
              3600
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

          /*
           * IMPORTANT:
           *
           * The Deriv token is NOT sent to
           * the frontend.
           */

          setSessionCookie(
            res,
            sessionId,
            expiresIn
          );

          /*
           * Redirect to the frontend.
           *
           * The browser keeps the HttpOnly
           * backend cookie.
           */

          redirect(
            res,
            `${FRONTEND_ORIGIN}/login.html?oauth=success`
          );

          return;

        } catch (error) {

          console.error(
            "OAuth callback error:",
            error.message
          );

          redirect(
            res,
            `${FRONTEND_ORIGIN}/login.html?oauth_error=callback_failed`
          );

          return;
        }
      }

      /* ===================================================
         SESSION STATUS
      =================================================== */

      if (
        req.method === "GET" &&
        pathname === "/api/session"
      ) {

        const session =
          getSession(req);

        if (!session) {

          sendJson(res, 200, {
            authenticated:
              false
          });

          return;
        }

        sendJson(res, 200, {
          authenticated:
            true,

          expiresAt:
            session.data.expiresAt
        });

        return;
      }

      /* ===================================================
         ACCOUNT STATUS
      =================================================== */

      if (
        req.method === "GET" &&
        pathname === "/api/account"
      ) {

        const session =
          getSession(req);

        if (!session) {

          sendJson(res, 200, {
            connected:
              false,

            authenticated:
              false
          });

          return;
        }

        try {

          const {
            response,
            data
          } =
            await getDerivAccounts(
              session.data.accessToken
            );

          if (
            !response.ok
          ) {

            sendJson(
              res,
              response.status,
              {
                connected:
                  false,

                authenticated:
                  false,

                error:
                  "Deriv account authorization is no longer valid."
              }
            );

            return;
          }

          sendJson(res, 200, {
            connected:
              true,

            authenticated:
              true,

            accounts:
              data
          });

          return;

        } catch (error) {

          console.error(
            "Account status error:",
            error.message
          );

          sendJson(res, 500, {
            connected:
              false,

            authenticated:
              true,

            error:
              "Unable to verify Deriv account."
          });

          return;
        }
      }

      /* ===================================================
         ACCOUNTS
      =================================================== */

      if (
        req.method === "GET" &&
        pathname === "/api/accounts"
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

          const {
            response,
            data
          } =
            await getDerivAccounts(
              session.data.accessToken
            );

          if (
            !response.ok
          ) {

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
            success:
              true,

            accounts:
              data
          });

          return;

        } catch (error) {

          console.error(
            "Accounts request failed:",
            error.message
          );

          sendJson(res, 500, {
            error:
              "Account request failed."
          });

          return;
        }
      }

      /* ===================================================
         AUTHENTICATED DERIV CONNECTION CHECK
      =================================================== */

      if (
        req.method === "GET" &&
        pathname === "/api/otp"
      ) {

        const session =
          getSession(req);

        if (!session) {

          sendJson(res, 401, {
            success:
              false,

            error:
              "Not authenticated."
          });

          return;
        }

        try {

          const {
            response,
            data
          } =
            await getDerivAccounts(
              session.data.accessToken
            );

          if (
            !response.ok
          ) {

            sendJson(
              res,
              response.status,
              {
                success:
                  false,

                error:
                  "Authenticated Deriv connection failed.",

                details:
                  data
              }
            );

            return;
          }

          sendJson(res, 200, {
            success:
              true,

            authenticated:
              true,

            message:
              "Authenticated Deriv account confirmed."
          });

          return;

        } catch (error) {

          console.error(
            "Authenticated connection error:",
            error.message
          );

          sendJson(res, 500, {
            success:
              false,

            error:
              "Authenticated connection failed."
          });

          return;
        }
      }

      /* ===================================================
         LOGOUT
      =================================================== */

      if (
        req.method === "POST" &&
        pathname === "/api/logout"
      ) {

        const cookies =
          getCookies(req);

        const sessionId =
          cookies.nextrade_session;

        if (sessionId) {

          sessions.delete(
            sessionId
          );
        }

        clearSessionCookie(
          res
        );

        sendJson(res, 200, {
          success:
            true
        });

        return;
      }

      /* ===================================================
         MARKET SNAPSHOT
      =================================================== */

      if (
        req.method === "GET" &&
        pathname === "/api/markets"
      ) {

        sendJson(res, 200, {
          success:
            true,

          connected:
            derivConnected,

          symbols
        });

        return;
      }

      /* ===================================================
         404
      =================================================== */

      sendJson(res, 404, {
        error:
          "Not found",

        path:
          pathname,

        service:
          "NEXTRADE Backend"
      });
    }
  );

/* =========================================================
   BROWSER WEBSOCKET SERVER
========================================================= */

const wss =
  new WebSocket.Server({
    server
  });

/* =========================================================
   BROADCAST
========================================================= */

function broadcast(message) {

  const text =
    JSON.stringify(message);

  clients.forEach(
    (client) => {

      if (
        client.readyState ===
        WebSocket.OPEN
      ) {

        try {
          client.send(text);
        } catch (error) {
          console.error(
            "Browser send error:",
            error.message
          );
        }
      }
    }
  );
}

/* =========================================================
   CONNECT TO DERIV PUBLIC MARKET DATA
========================================================= */

function connectToDeriv() {

  if (deriv) {

    try {
      deriv.removeAllListeners();
      deriv.close();
    } catch {}
  }

  deriv = null;

  derivConnected =
    false;

  broadcast({
    type:
      "status",

    connected:
      false
  });

  console.log(
    "Connecting to Deriv..."
  );

  deriv =
    new WebSocket(
      DERIV_PUBLIC_WS
    );

  /* -------------------------------------------------------
     OPEN
  ------------------------------------------------------- */

  deriv.on(
    "open",
    () => {

      console.log(
        "Deriv WebSocket connected"
      );

      derivConnected =
        true;

      broadcast({
        type:
          "status",

        connected:
          true
      });

      /*
       * Subscribe to all 10 markets.
       */

      symbols.forEach(
        (symbol) => {

          try {

            deriv.send(
              JSON.stringify({
                ticks:
                  symbol,

                subscribe:
                  1
              })
            );

          } catch (error) {

            console.error(
              "Subscription error:",
              symbol,
              error.message
            );
          }
        }
      );
    }
  );

  /* -------------------------------------------------------
     MESSAGE
  ------------------------------------------------------- */

  deriv.on(
    "message",
    (raw) => {

      try {

        const data =
          JSON.parse(
            raw.toString()
          );

        /* -----------------------------------------------
           TICK
        ------------------------------------------------ */

        if (
          data.msg_type ===
            "tick" &&
          data.tick
        ) {

          const symbol =
            data.tick.symbol;

          const price =
            Number(
              data.tick.quote
            );

          const epoch =
            Number(
              data.tick.epoch
            );

          if (
            !symbol ||
            !Number.isFinite(price)
          ) {
            return;
          }

          broadcast({
            type:
              "tick",

            data: {
              symbol,
              price,
              epoch
            }
          });

          return;
        }

        /* -----------------------------------------------
           DERIV ERROR
        ------------------------------------------------ */

        if (data.error) {

          console.error(
            "Deriv API error:",
            data.error
          );

          broadcast({
            type:
              "deriv_error",

            error:
              data.error
          });

          return;
        }

      } catch (error) {

        console.error(
          "Unable to parse Deriv message:",
          error.message
        );
      }
    }
  );

  /* -------------------------------------------------------
     ERROR
  ------------------------------------------------------- */

  deriv.on(
    "error",
    (error) => {

      console.error(
        "Deriv WebSocket error:",
        error.message
      );

      derivConnected =
        false;

      broadcast({
        type:
          "status",

        connected:
          false,

        error:
          error.message
      });
    }
  );

  /* -------------------------------------------------------
     CLOSE
  ------------------------------------------------------- */

  deriv.on(
    "close",
    (code, reason) => {

      console.log(
        "Deriv connection closed:",
        code,
        reason
          ? reason.toString()
          : ""
      );

      derivConnected =
        false;

      broadcast({
        type:
          "status",

        connected:
          false,

        closeCode:
          code
      });

      /*
       * Reconnect after 5 seconds.
       */

      setTimeout(
        () => {

          /*
           * Only reconnect if there
           * isn't an active connection.
           */

          if (
            !deriv ||
            deriv.readyState !==
              WebSocket.OPEN
          ) {
            connectToDeriv();
          }

        },
        5000
      );
    }
  );
}

/* =========================================================
   BROWSER CONNECTION
========================================================= */

wss.on(
  "connection",
  (client) => {

    console.log(
      "NEXTRADE browser connected"
    );

    clients.add(client);

    /*
     * Immediately tell browser whether
     * Deriv public market data is live.
     */

    client.send(
      JSON.stringify({
        type:
          "status",

        connected:
          derivConnected
      })
    );

    client.on(
      "close",
      () => {

        clients.delete(
          client
        );

        console.log(
          "NEXTRADE browser disconnected"
        );
      }
    );

    client.on(
      "error",
      () => {

        clients.delete(
          client
        );
      }
    );
  }
);

/* =========================================================
   SERVER START
========================================================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "================================================="
    );

    console.log(
      `NEXTRADE backend listening on ${PORT}`
    );

    console.log(
      `Backend URL: ${BACKEND_URL}`
    );

    console.log(
      `Frontend: ${FRONTEND_ORIGIN}`
    );

    console.log(
      "OAuth configured:",
      Boolean(
        DERIV_CLIENT_ID &&
        DERIV_REDIRECT_URI
      )
    );

    console.log(
      "Markets:",
      symbols.length
    );

    console.log(
      "================================================="
    );

    connectToDeriv();
  }
);

/* =========================================================
   PROCESS ERROR HANDLING
========================================================= */

process.on(
  "uncaughtException",
  (error) => {

    console.error(
      "UNCAUGHT EXCEPTION:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  (error) => {

    console.error(
      "UNHANDLED REJECTION:",
      error
    );
  }
);
