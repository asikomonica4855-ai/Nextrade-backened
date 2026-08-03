const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");

/* =========================================================
   NEXTRADE BACKEND
   ========================================================= */

const PORT = Number(process.env.PORT || 10000);

const DERIV_CLIENT_ID =
  process.env.DERIV_CLIENT_ID;

const DERIV_REDIRECT_URI =
  process.env.DERIV_REDIRECT_URI;

const FRONTEND_ORIGIN =
  "https://asikomonica4855-ai.github.io";

const FRONTEND_URL =
  "https://asikomonica4855-ai.github.io/Nextrade";

const BACKEND_URL =
  "https://nextrade-backened.onrender.com";

const DERIV_OAUTH_AUTHORIZE =
  "https://auth.deriv.com/oauth2/auth";

const DERIV_OAUTH_TOKEN =
  "https://auth.deriv.com/oauth2/token";

const DERIV_API =
  "https://api.derivws.com/trading/v1/options/accounts";

const DERIV_PUBLIC_WS =
  "wss://api.derivws.com/trading/v1/options/ws/public";


/* =========================================================
   MARKETS
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
   GLOBAL STORAGE
   ========================================================= */

let deriv = null;
let derivConnected = false;

const browserClients = new Set();

const oauthStates = new Map();

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
      "no-store"
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

    "Cache-Control":
      "no-store, no-cache, must-revalidate"
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
    .forEach(part => {

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
   SESSION
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

    sessions.delete(
      sessionId
    );

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
      `nextrade_session=${encodeURIComponent(sessionId)}`,
      "HttpOnly",
      "Secure",
      "SameSite=None",
      "Path=/",
      `Max-Age=${Math.max(1, Math.floor(maxAge))}`
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
      now - data.createdAt >
      10 * 60 * 1000
    ) {

      oauthStates.delete(
        state
      );

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

      sessions.delete(
        sessionId
      );

    }

  }

}


setInterval(
  cleanupStorage,
  5 * 60 * 1000
);


/* =========================================================
   BROADCAST
   ========================================================= */

function broadcast(message) {

  const text =
    JSON.stringify(message);

  browserClients.forEach(
    client => {

      if (
        client.readyState ===
        WebSocket.OPEN
      ) {

        try {

          client.send(text);

        } catch {}

      }

    }
  );

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
          `http://${req.headers.host || "localhost"}`
        );

      const pathname =
        parsedUrl.pathname;


      /* =====================================================
         OPTIONS
         ===================================================== */

      if (
        req.method ===
        "OPTIONS"
      ) {

        res.writeHead(204);
        res.end();

        return;

      }


      /* =====================================================
         ROOT
         ===================================================== */

      if (
        req.method === "GET" &&
        pathname === "/"
      ) {

        sendJson(
          res,
          200,
          {

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

            websocket:
              "available"

          }
        );

        return;

      }


      /* =====================================================
         HEALTH
         ===================================================== */

      if (
        req.method === "GET" &&
        pathname === "/health"
      ) {

        sendJson(
          res,
          200,
          {

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

          }
        );

        return;

      }


      /* =====================================================
         API STATUS
         ===================================================== */

      if (
        req.method === "GET" &&
        pathname === "/api/status"
      ) {

        sendJson(
          res,
          200,
          {

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

          }
        );

        return;

      }


      /* =====================================================
         OAUTH STATUS
         ===================================================== */

      if (
        req.method === "GET" &&
        pathname === "/oauth/status"
      ) {

        sendJson(
          res,
          200,
          {

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
              )

          }
        );

        return;

      }


      /* =====================================================
         START DERIV OAUTH
         ===================================================== */

      if (
        req.method === "GET" &&
        pathname === "/oauth/authorize"
      ) {

        if (
          !DERIV_CLIENT_ID ||
          !DERIV_REDIRECT_URI
        ) {

          redirect(
            res,
            `${FRONTEND_URL}/login.html?oauth_error=server_not_configured`
          );

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


      /* =====================================================
         DERIV OAUTH CALLBACK

         IMPORTANT:
         Deriv returns directly to this backend.

         Backend exchanges the code,
         creates the session,
         sets the HttpOnly cookie,
         then redirects to markets.html.

         The browser does NOT need to fetch
         /oauth/callback from JavaScript.
         ===================================================== */

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


        if (error) {

          console.error(
            "Deriv OAuth error:",
            error
          );

          redirect(
            res,
            `${FRONTEND_URL}/login.html?oauth_error=${encodeURIComponent(error)}`
          );

          return;

        }


        if (
          !code ||
          !state
        ) {

          console.error(
            "OAuth callback missing code or state"
          );

          redirect(
            res,
            `${FRONTEND_URL}/login.html?oauth_error=missing_authorization_data`
          );

          return;

        }


        const saved =
          oauthStates.get(
            state
          );


        if (!saved) {

          console.error(
            "OAuth state missing or expired"
          );

          redirect(
            res,
            `${FRONTEND_URL}/login.html?oauth_error=invalid_or_expired_state`
          );

          return;

        }


        /* State is single-use. */

        oauthStates.delete(
          state
        );


        try {

          console.log(
            "Exchanging Deriv OAuth authorization code..."
          );


          const tokenResponse =
            await fetch(
              DERIV_OAUTH_TOKEN,
              {

                method:
                  "POST",

                headers: {

                  "Content-Type":
                    "application/x-www-form-urlencoded",

                  "Accept":
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


          const tokenText =
            await tokenResponse.text();


          let tokenData;

          try {

            tokenData =
              JSON.parse(
                tokenText
              );

          } catch {

            tokenData = {
              raw:
                tokenText
            };

          }


          if (
            !tokenResponse.ok ||
            !tokenData.access_token
          ) {

            console.error(
              "Deriv token exchange failed:",
              tokenResponse.status
            );

            redirect(
              res,
              `${FRONTEND_URL}/login.html?oauth_error=token_exchange_failed`
            );

            return;

          }


          /*
           * NEVER log the access token.
           */


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
           * Set secure HttpOnly cookie.
           */

          setSessionCookie(
            res,
            sessionId,
            expiresIn
          );


          console.log(
            "Deriv OAuth successful. Session created."
          );


          /*
           * IMPORTANT:
           *
           * We go directly to markets.
           *
           * oauth-callback.html is no longer
           * required for authentication.
           */

          redirect(
            res,
            `${FRONTEND_URL}/markets.html?connected=1`
          );

          return;


        } catch (error) {

          console.error(
            "OAuth callback exception:",
            error.message
          );

          redirect(
            res,
            `${FRONTEND_URL}/login.html?oauth_error=oauth_callback_failed`
          );

          return;

        }

      }


      /* =====================================================
         SESSION STATUS
         ===================================================== */

      if (
        req.method === "GET" &&
        pathname === "/api/session"
      ) {

        const session =
          getSession(req);


        if (!session) {

          sendJson(
            res,
            200,
            {

              authenticated:
                false

            }
          );

          return;

        }


        sendJson(
          res,
          200,
          {

            authenticated:
              true,

            expiresAt:
              session.data.expiresAt

          }
        );

        return;

      }


      /* =====================================================
         LOGOUT
         ===================================================== */

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


        sendJson(
          res,
          200,
          {

            success:
              true

          }
        );

        return;

      }


      /* =====================================================
         DERIV ACCOUNTS
         ===================================================== */

      if (
        req.method === "GET" &&
        pathname === "/api/accounts"
      ) {

        const session =
          getSession(req);


        if (!session) {

          sendJson(
            res,
            401,
            {

              error:
                "Not authenticated."

            }
          );

          return;

        }


        try {

          const response =
            await fetch(
              DERIV_API,
              {

                method:
                  "GET",

                headers: {

                  Authorization:
                    `Bearer ${session.data.accessToken}`,

                  Accept:
                    "application/json"

                }

              }
            );


          const text =
            await response.text();


          let data;

          try {

            data =
              JSON.parse(
                text
              );

          } catch {

            data = {
              raw:
                text
            };

          }


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


          sendJson(
            res,
            200,
            {

              success:
                true,

              accounts:
                data

            }
          );

          return;


        } catch (error) {

          console.error(
            "Account request failed:",
            error.message
          );

          sendJson(
            res,
            500,
            {

              error:
                "Account request failed."

            }
          );

          return;

        }

      }


      /* =====================================================
         AUTHENTICATED CONNECTION CHECK
         ===================================================== */

      if (
        req.method === "GET" &&
        pathname === "/api/otp"
      ) {

        const session =
          getSession(req);


        if (!session) {

          sendJson(
            res,
            401,
            {

              error:
                "Not authenticated."

            }
          );

          return;

        }


        try {

          const response =
            await fetch(
              DERIV_API,
              {

                method:
                  "GET",

                headers: {

                  Authorization:
                    `Bearer ${session.data.accessToken}`,

                  Accept:
                    "application/json"

                }

              }
            );


          if (!response.ok) {

            sendJson(
              res,
              response.status,
              {

                success:
                  false,

                authenticated:
                  false,

                error:
                  "Deriv account authorization is no longer valid."

              }
            );

            return;

          }


          sendJson(
            res,
            200,
            {

              success:
                true,

              authenticated:
                true,

              message:
                "Authenticated Deriv account confirmed."

            }
          );

          return;


        } catch (error) {

          console.error(
            "Authenticated Deriv check failed:",
            error.message
          );

          sendJson(
            res,
            500,
            {

              success:
                false,

              authenticated:
                true,

              error:
                "Authenticated Deriv check failed."

            }
          );

          return;

        }

      }


      /* =====================================================
         UNKNOWN ROUTE
         ===================================================== */

      sendJson(
        res,
        404,
        {

          error:
            "Not found",

          path:
            pathname

        }
      );

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
   DERIV PUBLIC MARKET CONNECTION
   ========================================================= */

function connectToDeriv() {

  if (deriv) {

    try {

      deriv.removeAllListeners();

      deriv.close();

    } catch {}

    deriv =
      null;

  }


  derivConnected =
    false;


  broadcast({

    type:
      "status",

    connected:
      false

  });


  console.log(
    "Connecting to Deriv public market data..."
  );


  try {

    deriv =
      new WebSocket(
        DERIV_PUBLIC_WS
      );


  } catch (error) {

    console.error(
      "Unable to create Deriv WebSocket:",
      error.message
    );

    scheduleDerivReconnect();

    return;

  }


  deriv.on(
    "open",
    () => {

      console.log(
        "Deriv public WebSocket connected"
      );


      derivConnected =
        true;


      broadcast({

        type:
          "status",

        connected:
          true

      });


      symbols.forEach(
        symbol => {

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
              `Unable to subscribe ${symbol}:`,
              error.message
            );

          }

        }
      );

    }
  );


  deriv.on(
    "message",
    raw => {

      try {

        const data =
          JSON.parse(
            raw.toString()
          );


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
            symbol &&
            Number.isFinite(price)
          ) {

            broadcast({

              type:
                "tick",

              data: {

                symbol,

                price,

                epoch

              }

            });

          }

        }


        if (
          data.error
        ) {

          console.error(
            "Deriv market error:",
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
          "Unable to parse Deriv message:",
          error.message
        );

      }

    }
  );


  deriv.on(
    "error",
    error => {

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


      scheduleDerivReconnect();

    }
  );

}


/* =========================================================
   DERIV RECONNECT
   ========================================================= */

let derivReconnectTimer =
  null;


function scheduleDerivReconnect() {

  if (
    derivReconnectTimer
  ) {

    return;

  }


  derivReconnectTimer =
    setTimeout(
      () => {

        derivReconnectTimer =
          null;

        connectToDeriv();

      },
      5000
    );

}


/* =========================================================
   BROWSER WEBSOCKET
   ========================================================= */

wss.on(
  "connection",
  client => {

    console.log(
      "NEXTRADE browser WebSocket connected"
    );


    browserClients.add(
      client
    );


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

        browserClients.delete(
          client
        );

        console.log(
          "NEXTRADE browser WebSocket disconnected"
        );

      }
    );


    client.on(
      "error",
      () => {

        browserClients.delete(
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
      "======================================"
    );

    console.log(
      "NEXTRADE BACKEND STARTED"
    );

    console.log(
      "======================================"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Backend: ${BACKEND_URL}`
    );

    console.log(
      `Frontend: ${FRONTEND_URL}`
    );

    console.log(
      `OAuth configured: ${Boolean(
        DERIV_CLIENT_ID &&
        DERIV_REDIRECT_URI
      )}`
    );

    console.log(
      `OAuth redirect: ${
        DERIV_REDIRECT_URI || "NOT SET"
      }`
    );

    console.log(
      `Markets: ${symbols.length}`
    );

    console.log(
      "======================================"
    );


    connectToDeriv();

  });


/* =========================================================
   PROCESS SAFETY
   ========================================================= */

process.on(
  "uncaughtException",
  error => {

    console.error(
      "Uncaught exception:",
      error.message
    );

  }
);


process.on(
  "unhandledRejection",
  error => {

    console.error(
      "Unhandled rejection:",
      error
    );

  }
);
