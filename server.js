const WebSocket = require("ws");
const http = require("http");

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "application/json"
  });

  res.end(JSON.stringify({
    service: "NEXTRADE Live Data",
    status: "online"
  }));
});

const wss = new WebSocket.Server({
  server
});

let deriv;
let derivConnected = false;

const clients = new Set();

function connectToDeriv() {

  console.log("Connecting to Deriv...");

  deriv = new WebSocket(
    "wss://ws.binaryws.com/websockets/v3"
  );

  deriv.on("open", () => {

    console.log("Connected to Deriv");

    derivConnected = true;

    // Subscribe to the markets NEXTRADE uses
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

    symbols.forEach(symbol => {

      deriv.send(JSON.stringify({
        ticks: symbol,
        subscribe: 1
      }));

    });

  });


  deriv.on("message", message => {

    try {

      const data =
        JSON.parse(message.toString());

      if (data.msg_type !== "tick") {
        return;
      }

      const tick = {

        symbol:
          data.tick.symbol,

        price:
          Number(data.tick.quote),

        epoch:
          Number(data.tick.epoch)

      };


      // Send the live tick to every NEXTRADE browser
      clients.forEach(client => {

        if (
          client.readyState ===
          WebSocket.OPEN
        ) {

          client.send(
            JSON.stringify({
              type: "tick",
              data: tick
            })
          );

        }

      });

    }

    catch(error) {

      console.error(
        "Message error:",
        error.message
      );

    }

  });


  deriv.on("close", () => {

    console.log(
      "Deriv connection closed"
    );

    derivConnected = false;

    setTimeout(
      connectToDeriv,
      3000
    );

  });


  deriv.on("error", error => {

    console.error(
      "Deriv error:",
      error.message
    );

  });

}


wss.on("connection", client => {

  console.log(
    "NEXTRADE client connected"
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
      "NEXTRADE client disconnected"
    );

  });

});


connectToDeriv();


server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `NEXTRADE backend running on port ${PORT}`
    );

  }
);
