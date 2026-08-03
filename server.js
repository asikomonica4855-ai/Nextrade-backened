const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const DERIV_CLIENT_ID = process.env.DERIV_CLIENT_ID;
const DERIV_REDIRECT_URI = process.env.DERIV_REDIRECT_URI;

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

/*
 * Temporary OAuth state storage.
 *
 * Each login gets:
 * state -> code_verifier
 *
 * This is intentionally kept server-side so the
 * code_verifier is never exposed in the URL.
 */
const oauthStates = new Map();

/*
 * CORS
 */
function setCors(res) {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "https://asikomonica4855-ai.github.io"
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

/*
 * Generate a PKCE verifier.
 */
function createCodeVerifier() {
  return crypto
    .randomBytes(64)
    .toString("base64url")
    .slice(0, 128);
}

/*
 * Generate the PKCE challenge.
 */
function createCodeChallenge(verifier) {
  return crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
}

/*
 * Generate OAuth state.
 */
function createState() {
  return crypto
    .randomBytes(32)
    .toString("hex");
}

/*
 * JSON response helper.
 */
function sendJson(res, status, data) {

  setCors(res);

  res.writeHead(status, {
    "Content-Type": "application/json"
  });

  res.end(JSON.stringify(data));
}

/*
 * Read request body.
 */
function readBody(req) {

  return new Promise((resolve, reject) => {

    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", () => {
      resolve(body);
    });

    req.on("error", reject);

  });

}

/*
 * Main HTTP server.
 */
const server = http.createServer(async (req, res) => {

  setCors(res);

  if (req.method === "OPTIONS") {

    res.writeHead(204);
    res.end();

    return;
  }

  /*
   * Health endpoint
   */
  if (
    req.method === "GET" &&
    req.url === "/"
  ) {

    sendJson(res, 200, {
      service: "MUKHU Live Data",
      status: "online",
      derivConnected
    });

    return;
  }

  /*
   * OAuth configuration check.
   */
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

  /*
   * Start Deriv OAuth.
   *
   * The browser visits:
   *
   * /oauth/authorize
   *
   * We generate PKCE and state here.
   */
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

    /*
     * Store the verifier temporarily.
     */
    oauthStates.set(
      state,
      {
        verifier,
        createdAt: Date.now()
      }
    );

    /*
     * Remove very old OAuth states.
     */
    for (
      const [savedState, data]
      of oauthStates.entries()
    ) {

      if (
        Date.now() - data.createdAt >
        10 * 60 * 1000
      ) {

        oauthStates.delete(
          savedState
        );

      }

    }

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

  /*
   * OAuth callback exchange.
   *
   * oauth-callback.html will send:
   *
   * code
   * state
   *
   * back to this endpoint.
   */
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

    /*
     * Validate state.
     */
    const saved =
      oauthStates.get(state);

    if (!saved) {

      sendJson(res, 400, {
        error:
          "Invalid or expired OAuth state."
      });

      return;
    }

    /*
     * State is single-use.
     */
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
          "OAuth token exchange failed:",
          tokenData
        );

        sendJson(res, 400, {
          error:
            "OAuth token exchange failed.",
          details:
            tokenData
        });

        return;
      }

      /*
       * IMPORTANT:
       *
       * Do not log the access token.
       */
      sendJson(res, 200, {
        success: true,
        expires_in:
          tokenData.expires_in,
        token_type:
          tokenData.token_type
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

  /*
   * WebSocket upgrade is handled by ws.
   */
  if (
    req.url === "/health"
  ) {

    sendJson(res, 200, {
      status: "ok",
      derivConnected
    });

    return;
  }

  /*
   * Unknown HTTP route.
   */
  sendJson(res, 404, {
    error: "Not found"
  });

});

const wss = new WebSocket.Server({
  server
});

/*
 * Broadcast to connected browsers.
 */
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

/*
 * Connect to Deriv public market data.
 *
 * THIS PART REMAINS THE SAME WORKING
 * MARKET-DATA CONNECTION.
 */
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

      console.log(
        "DERIV MESSAGE:",
        JSON.stringify(data)
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

/*
 * Browser WebSocket connection.
 */
wss.on("connection", client => {

  console.log(
    "MUKHU browser connected"
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
      "MUKHU browser disconnected"
    );

  });

});

/*
 * Start server.
 */
server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `MUKHU backend listening on ${PORT}`
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
