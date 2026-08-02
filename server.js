const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

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

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "application/json"
  });

  res.end(JSON.stringify({
    service: "NEXTRADE Live Data",
    status: "online",
    derivConnected
  }));
});

const wss = new WebSocket.Server({
  server
});

function broadcast(message) {

  const text = JSON.stringify(message);

  clients.forEach(client => {

    if (client.readyState === WebSocket.OPEN) {
      client.send(text);
    }

  });

}

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

  console.log("Connecting to Deriv...");

  /*
   * Public Deriv market-data WebSocket.
   */
  deriv = new WebSocket(
    "wss://api.derivws.com/trading/v1/options/ws/public"
  );

  deriv.on("open", () => {

    console.log("Deriv WebSocket connected");

    derivConnected = true;

    broadcast({
      type: "status",
      connected: true
    });

    /*
     * Subscribe to each market.
     */
    symbols.forEach(symbol => {

      deriv.send(JSON.stringify({
        ticks: symbol,
        subscribe: 1
      }));

    });

  });

  deriv.on("message", raw => {

    try {

      const data =
        JSON.parse(raw.toString());

      console.log(
        "DERIV MESSAGE:",
        JSON.stringify(data)
      );

      /*
       * Forward actual tick messages.
       */
      if (
        data.msg_type === "tick" &&
        data.tick
      ) {

        broadcast({
          type: "tick",
          data: {
            symbol: data.tick.symbol,
            price: Number(data.tick.quote),
            epoch: Number(data.tick.epoch)
          }
        });

      }

      /*
       * Forward API errors to the browser.
       */
      if (data.error) {

        broadcast({
          type: "deriv_error",
          error: data.error
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
      error: error.message
    });

  });

  deriv.on("close", (code, reason) => {

    console.log(
      "Deriv connection closed:",
      code,
      reason ? reason.toString() : ""
    );

    derivConnected = false;

    broadcast({
      type: "status",
      connected: false,
      closeCode: code
    });

    /*
     * Reconnect after 5 seconds.
     */
    setTimeout(
      connectToDeriv,
      5000
    );

  });

}

wss.on("connection", client => {

  console.log(
    "NEXTRADE browser connected"
  );

  clients.add(client);

  client.send(
    JSON.stringify({
      type: "status",
      connected: derivConnected
    })
  );

  client.on("close", () => {

    clients.delete(client);

    console.log(
      "NEXTRADE browser disconnected"
    );

  });

});

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `NEXTRADE backend listening on ${PORT}`
    );

    connectToDeriv();

  }
);
