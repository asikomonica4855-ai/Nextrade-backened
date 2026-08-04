const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const FRONTEND_URL =
  "https://asikomonica4855-ai.github.io/Nextrade";

const BACKEND_URL =
  "https://nextrade-backened.onrender.com";

/*
==================================================
 MUKHU LIVE MARKET DATA ARCHITECTURE
==================================================

MUKHU FRONTEND
      ↓
MUKHU RENDER BACKEND
      ↓
Deriv Public Market WebSocket
      ↓
LIVE TICKS
      ↓
MUKHU FRONTEND
==================================================
*/

/*
Official public market-data endpoint.
No authentication required.
*/
const MARKET_WS =
  "wss://api.derivws.com/trading/v1/options/ws/public";


/*
==================================================
 MARKETS
==================================================
*/

const MARKETS = [

  {symbol:"1HZ100V",name:"Volatility 100 (1s)",category:"Volatility"},
  {symbol:"1HZ75V",name:"Volatility 75 (1s)",category:"Volatility"},
  {symbol:"1HZ50V",name:"Volatility 50 (1s)",category:"Volatility"},
  {symbol:"1HZ25V",name:"Volatility 25 (1s)",category:"Volatility"},
  {symbol:"1HZ10V",name:"Volatility 10 (1s)",category:"Volatility"},

  {symbol:"R_100",name:"Volatility 100",category:"Volatility"},
  {symbol:"R_75",name:"Volatility 75",category:"Volatility"},
  {symbol:"R_50",name:"Volatility 50",category:"Volatility"},
  {symbol:"R_25",name:"Volatility 25",category:"Volatility"},
  {symbol:"R_10",name:"Volatility 10",category:"Volatility"},

  {symbol:"frxEURUSD",name:"EUR/USD",category:"Forex"},
  {symbol:"frxGBPUSD",name:"GBP/USD",category:"Forex"},
  {symbol:"frxUSDJPY",name:"USD/JPY",category:"Forex"},
  {symbol:"frxUSDCHF",name:"USD/CHF",category:"Forex"},
  {symbol:"frxAUDUSD",name:"AUD/USD",category:"Forex"},

  {symbol:"cryBTCUSD",name:"Bitcoin / USD",category:"Crypto"},
  {symbol:"cryETHUSD",name:"Ethereum / USD",category:"Crypto"},

  {symbol:"JD10",name:"Jump 10 Index",category:"Jump"},
  {symbol:"JD25",name:"Jump 25 Index",category:"Jump"},
  {symbol:"JD50",name:"Jump 50 Index",category:"Jump"},
  {symbol:"JD75",name:"Jump 75 Index",category:"Jump"},
  {symbol:"JD100",name:"Jump 100 Index",category:"Jump"}

];


/*
==================================================
 CLIENTS
==================================================
*/

const clients = new Set();

let derivSocket = null;

let marketConnected = false;

let reconnectTimer = null;


/*
==================================================
 CORS
==================================================
*/

function cors(res){

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
 JSON
==================================================
*/

function sendJson(res,status,data){

  cors(res);

  res.writeHead(status,{
    "Content-Type":
      "application/json; charset=utf-8",

    "Cache-Control":
      "no-store"
  });

  res.end(
    JSON.stringify(data)
  );

}


/*
==================================================
 BROADCAST
==================================================
*/

function broadcast(data){

  const message =
    JSON.stringify(data);

  for(const client of clients){

    if(
      client.readyState ===
      WebSocket.OPEN
    ){

      try{
        client.send(message);
      }catch{}

    }

  }

}


/*
==================================================
 DERIV PUBLIC MARKET CONNECTION
==================================================
*/

function connectMarketData(){

  if(derivSocket){

    try{
      derivSocket.close();
    }catch{}

  }


  console.log(
    "Connecting to official public market-data WebSocket..."
  );


  try{

    derivSocket =
      new WebSocket(
        MARKET_WS
      );

  }catch(error){

    console.error(
      "WebSocket creation error:",
      error.message
    );

    scheduleReconnect();

    return;

  }


  derivSocket.on(
    "open",
    () => {

      marketConnected =
        true;

      console.log(
        "LIVE MARKET DATA CONNECTED"
      );

      broadcast({
        type:"status",
        connected:true,
        provider:"deriv-public"
      });


      /*
      Subscribe to ticks.
      */

      for(
        const market of MARKETS
      ){

        try{

          derivSocket.send(
            JSON.stringify({

              ticks:
                market.symbol,

              subscribe:
                1

            })
          );

        }catch(error){

          console.error(
            "Subscription error:",
            market.symbol,
            error.message
          );

        }

      }

    }
  );


  derivSocket.on(
    "message",
    raw => {

      try{

        const data =
          JSON.parse(
            raw.toString()
          );


        /*
        LIVE TICK
        */

        if(
          data.msg_type === "tick" &&
          data.tick
        ){

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


          if(
            symbol &&
            Number.isFinite(price)
          ){

            broadcast({

              type:"tick",

              data:{

                symbol,

                price,

                epoch

              }

            });

          }

        }


        /*
        DERIV ERROR
        */

        if(data.error){

          console.error(
            "Market provider error:",
            data.error
          );

          broadcast({

            type:"deriv_error",

            error:data.error

          });

        }

      }catch(error){

        console.error(
          "Market message error:",
          error.message
        );

      }

    }
  );


  derivSocket.on(
    "error",
    error => {

      console.error(
        "Market WebSocket error:",
        error.message
      );

      marketConnected =
        false;

      broadcast({

        type:"status",

        connected:false,

        provider:"deriv-public"

      });

    }
  );


  derivSocket.on(
    "close",
    () => {

      marketConnected =
        false;

      console.log(
        "Market WebSocket closed"
      );

      broadcast({

        type:"status",

        connected:false,

        provider:"deriv-public"

      });

      scheduleReconnect();

    }
  );

}


/*
==================================================
 RECONNECT
==================================================
*/

function scheduleReconnect(){

  clearTimeout(
    reconnectTimer
  );

  reconnectTimer =
    setTimeout(
      connectMarketData,
      5000
    );

}


/*
==================================================
 HTTP SERVER
==================================================
*/

const server =
  http.createServer(
    (req,res) => {

      cors(res);

      if(
        req.method ===
        "OPTIONS"
      ){

        res.writeHead(204);

        res.end();

        return;

      }


      const url =
        new URL(
          req.url,
          `http://${
            req.headers.host ||
            "localhost"
          }`
        );


      const path =
        url.pathname;


      /*
      ROOT
      */

      if(
        req.method === "GET" &&
        path === "/"
      ){

        return sendJson(
          res,
          200,
          {

            service:
              "MUKHU Market Data Backend",

            status:
              "online",

            provider:
              "deriv-public",

            marketData:
              marketConnected,

            markets:
              MARKETS.length,

            websocket:
              "available"

          }
        );

      }


      /*
      HEALTH
      */

      if(
        req.method === "GET" &&
        path === "/health"
      ){

        return sendJson(
          res,
          200,
          {

            status:
              "ok",

            marketData:
              marketConnected,

            provider:
              "deriv-public",

            timestamp:
              Date.now()

          }
        );

      }


      /*
      MARKET STATUS
      */

      if(
        req.method === "GET" &&
        path === "/api/status"
      ){

        return sendJson(
          res,
          200,
          {

            success:
              true,

            backend:
              "online",

            live:
              marketConnected,

            provider:
              "deriv-public",

            markets:
              MARKETS.length

          }
        );

      }


      /*
      MARKET CATALOGUE
      */

      if(
        req.method === "GET" &&
        path === "/api/markets"
      ){

        return sendJson(
          res,
          200,
          {

            success:
              true,

            markets:
              MARKETS

          }
        );

      }


      /*
      NOT FOUND
      */

      return sendJson(
        res,
        404,
        {

          success:
            false,

          error:
            "Not found"

        }
      );

    }
  );


/*
==================================================
 FRONTEND WEBSOCKET
==================================================
*/

const websocketServer =
  new WebSocket.Server({
    server
  });


websocketServer.on(
  "connection",
  client => {

    clients.add(
      client
    );


    /*
    Immediately tell frontend
    current connection status.
    */

    client.send(
      JSON.stringify({

        type:
          "status",

        connected:
          marketConnected,

        provider:
          "deriv-public"

      })
    );


    /*
    Send catalogue.
    */

    client.send(
      JSON.stringify({

        type:
          "markets",

        markets:
          MARKETS

      })
    );


    client.on(
      "close",
      () => {

        clients.delete(
          client
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


/*
==================================================
 START
==================================================
*/

server.listen(
  PORT,
  () => {

    console.log(
      "================================"
    );

    console.log(
      "MUKHU MARKET BACKEND"
    );

    console.log(
      "================================"
    );

    console.log(
      "Status: ONLINE"
    );

    console.log(
      "Port:",
      PORT
    );

    console.log(
      "Frontend:",
      FRONTEND_URL
    );

    console.log(
      "Markets:",
      MARKETS.length
    );

    console.log(
      "Provider: DERIV PUBLIC"
    );

    console.log(
      "================================"
    );


    connectMarketData();

  }
);


/*
==================================================
 SAFETY
==================================================
*/

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
