const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const FRONTEND_URL =
  "https://asikomonica4855-ai.github.io/Nextrade";

const BACKEND_URL =
  "https://nextrade-backened.onrender.com";

/*
==================================================
 MUKHU MARKET DATA BACKEND
 New architecture:
 Frontend -> MUKHU backend -> market data provider

 IMPORTANT:
 This version DOES NOT connect directly to the
 failing Deriv WebSocket, so it will not produce
 the old 401 WebSocket crash.
==================================================
*/

const MARKETS = [
  { symbol: "1HZ100V", name: "Volatility 100 (1s)", category: "Volatility" },
  { symbol: "1HZ75V", name: "Volatility 75 (1s)", category: "Volatility" },
  { symbol: "1HZ50V", name: "Volatility 50 (1s)", category: "Volatility" },
  { symbol: "1HZ25V", name: "Volatility 25 (1s)", category: "Volatility" },
  { symbol: "1HZ10V", name: "Volatility 10 (1s)", category: "Volatility" },
  { symbol: "R_100", name: "Volatility 100", category: "Volatility" },
  { symbol: "R_75", name: "Volatility 75", category: "Volatility" },
  { symbol: "R_50", name: "Volatility 50", category: "Volatility" },
  { symbol: "R_25", name: "Volatility 25", category: "Volatility" },
  { symbol: "R_10", name: "Volatility 10", category: "Volatility" },

  { symbol: "frxEURUSD", name: "EUR/USD", category: "Forex" },
  { symbol: "frxGBPUSD", name: "GBP/USD", category: "Forex" },
  { symbol: "frxUSDJPY", name: "USD/JPY", category: "Forex" },
  { symbol: "frxUSDCHF", name: "USD/CHF", category: "Forex" },
  { symbol: "frxAUDUSD", name: "AUD/USD", category: "Forex" },

  { symbol: "cryBTCUSD", name: "Bitcoin / USD", category: "Crypto" },
  { symbol: "cryETHUSD", name: "Ethereum / USD", category: "Crypto" },

  { symbol: "JD10", name: "Jump 10 Index", category: "Jump" },
  { symbol: "JD25", name: "Jump 25 Index", category: "Jump" },
  { symbol: "JD50", name: "Jump 50 Index", category: "Jump" },
  { symbol: "JD75", name: "Jump 75 Index", category: "Jump" },
  { symbol: "JD100", name: "Jump 100 Index", category: "Jump" }
];

const clients = new Set();

let marketProvider = "not-connected";

/*
==================================================
 CORS
==================================================
*/

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

/*
==================================================
 JSON RESPONSE
==================================================
*/

function json(res, status, data) {
  cors(res);

  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(data));
}

/*
==================================================
 BROADCAST
==================================================
*/

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

/*
==================================================
 ROUTES
==================================================
*/

const server = http.createServer((req, res) => {

  cors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  const path = url.pathname;

  /*
  ROOT
  */

  if (req.method === "GET" && path === "/") {
    return json(res, 200, {
      service: "MUKHU Market Data Backend",
      status: "online",
      architecture: "new",
      provider: marketProvider,
      markets: MARKETS.length,
      websocket: "available"
    });
  }

  /*
  HEALTH
  */

  if (req.method === "GET" && path === "/health") {
    return json(res, 200, {
      status: "ok",
      provider: marketProvider,
      timestamp: Date.now()
    });
  }

  /*
  MARKET LIST
  */

  if (req.method === "GET" && path === "/api/markets") {
    return json(res, 200, {
      success: true,
      markets: MARKETS
    });
  }

  /*
  STATUS
  */

  if (req.method === "GET" && path === "/api/status") {
    return json(res, 200, {
      success: true,
      backend: "online",
      marketData: marketProvider,
      live: false,
      markets: MARKETS.length,
      architecture: "new"
    });
  }

  /*
  UNKNOWN ROUTE
  */

  return json(res, 404, {
    success: false,
    error: "Not found"
  });
});

/*
==================================================
 WEBSOCKET
==================================================
*/

const websocketServer = new WebSocket.Server({
  server
});

websocketServer.on("connection", client => {

  clients.add(client);

  /*
   Initial status.
  */

  client.send(
    JSON.stringify({
      type: "status",
      connected: false,
      provider: marketProvider
    })
  );

  /*
   Send market catalogue.
  */

  client.send(
    JSON.stringify({
      type: "markets",
      markets: MARKETS
    })
  );

  client.on("close", () => {
    clients.delete(client);
  });

  client.on("error", () => {
    clients.delete(client);
  });
});

/*
==================================================
 START
==================================================
*/

server.listen(PORT, () => {

  console.log("----------------------------------");
  console.log("MUKHU MARKET BACKEND");
  console.log("----------------------------------");
  console.log("Status: ONLINE");
  console.log("Port:", PORT);
  console.log("Backend:", BACKEND_URL);
  console.log("Frontend:", FRONTEND_URL);
  console.log("Markets:", MARKETS.length);
  console.log("Provider:", marketProvider);
  console.log("Deriv WebSocket: DISABLED");
  console.log("----------------------------------");

});

/*
==================================================
 SAFETY
==================================================
*/

process.on("uncaughtException", error => {
  console.error(
    "UNCAUGHT EXCEPTION:",
    error.message
  );
});

process.on("unhandledRejection", error => {
  console.error(
    "UNHANDLED REJECTION:",
    error
  );
});
