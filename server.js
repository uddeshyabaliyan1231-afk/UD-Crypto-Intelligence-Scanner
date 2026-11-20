
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const API = "https://api.coindcx.com";
const PUBLIC = "https://public.coindcx.com";

const http = axios.create({ timeout: 20000 });

// Normalize user input and CoinDCX instrument names
function normalize(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/^B-/, "")
    .replace(/[^A-Z0-9]/g, "");
}

// Fetch active USDT futures instruments
async function getInstruments() {
  const response = await http.get(
    API + "/exchange/v1/derivatives/futures/data/active_instruments",
    {
      params: {
        "margin_currency_short_name[]": "USDT"
      }
    }
  );

  if (!Array.isArray(response.data)) {
    throw new Error("Invalid instruments response");
  }

  return response.data;
}

// Find instrument with flexible symbol matching
async function findInstrument(input) {
  const instruments = await getInstruments();
  const search = normalize(input);

  const match = instruments.find(
    item => normalize(item) === search
  );

  if (!match) {
    throw new Error(
      "Coin not found in active CoinDCX USDT futures list. Check the symbol."
    );
  }

  return match;
}

// Current futures prices
async function getPrices(instrument) {
  const response = await http.get(
    PUBLIC + "/market_data/v3/current_prices/futures/rt"
  );

  const item = response.data?.prices?.[instrument];

  if (!item) {
    throw new Error("Live price unavailable");
  }

  return {
    pair: instrument,
    last_price: item.ls,
    mark_price: item.mp,
    high_24h: item.h,
    low_24h: item.l,
    volume_24h: item.v,
    change_percent: item.pc,
    funding_rate: item.fr
  };
}

// Live futures order book
async function getOrderBook(instrument) {
  const response = await http.get(
    PUBLIC +
    "/market_data/v3/orderbook/" +
    encodeURIComponent(instrument) +
    "-futures/50"
  );

  const data = response.data;

  if (!data?.bids || !data?.asks) {
    throw new Error("Order book unavailable");
  }

  return data;
}

// 5-minute futures candles
async function getCandles(instrument) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - (200 * 5 * 60);

  const response = await http.get(
    PUBLIC + "/market_data/candlesticks",
    {
      params: {
        pair: instrument,
        from,
        to: now,
        resolution: "5",
        pcode: "f"
      }
    }
  );

  if (
    response.data?.s !== "ok" ||
    !Array.isArray(response.data.data)
  ) {
    throw new Error("5-minute candles unavailable");
  }

  return response.data.data;
}

app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    scanner: "UD Crypto Intelligence",
    exchange: "CoinDCX Futures",
    timeframe: "5m"
  });
});

// Active coin list
app.get("/api/pairs", async (req, res) => {
  try {
    const instruments = await getInstruments();

    res.json({
      success: true,
      count: instruments.length,
      pairs: instruments
    });
  } catch (error) {
    res.status(502).json({
      success: false,
      error: error.message
    });
  }
});

// Scan coin
app.get("/api/scan/:pair", async (req, res) => {
  try {
    const input = req.params.pair;

    if (!input || input.length > 40) {
      throw new Error("Invalid coin name");
    }

    const instrument = await findInstrument(input);

    const results = await Promise.allSettled([
      getPrices(instrument),
      getOrderBook(instrument),
      getCandles(instrument)
    ]);

    const [ticker, orderbook, candles] = results;

    const data = {
      coin: input,
      instrument,
      exchange: "CoinDCX Futures",
      timeframe: "5m",
      timestamp: new Date().toISOString(),

      ticker:
        ticker.status === "fulfilled"
          ? ticker.value
          : null,

      orderbook:
        orderbook.status === "fulfilled"
          ? orderbook.value
          : null,

      candles:
        candles.status === "fulfilled"
          ? candles.value
          : null,

      dataStatus: {
        ticker: ticker.status,
        orderbook: orderbook.status,
        candles: candles.status
      },

      errors: {
        ticker:
          ticker.status === "rejected"
            ? ticker.reason.message
            : null,

        orderbook:
          orderbook.status === "rejected"
            ? orderbook.reason.message
            : null,

        candles:
          candles.status === "rejected"
            ? candles.reason.message
            : null
      }
    };

    const complete = results.every(
      result => result.status === "fulfilled"
    );

    res.json({
      success: true,
      complete,
      data,
      message: complete
        ? "All market data received"
        : "Incomplete data. No trade signal permitted."
    });

  } catch (error) {
    res.status(502).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    "UD Crypto Intelligence running on port " + PORT
  );
});
