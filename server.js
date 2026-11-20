
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

const http = axios.create({ timeout: 15000 });

function normalize(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

// Find the exact active CoinDCX futures instrument
async function findInstrument(input) {
  const url =
    API +
    "/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=USDT";

  const response = await http.get(url);
  const instruments = response.data;

  if (!Array.isArray(instruments)) {
    throw new Error("Invalid CoinDCX instruments response");
  }

  const match = instruments.find(
    item => normalize(item) === normalize(input)
  );

  if (!match) {
    throw new Error("CoinDCX USDT futures pair not found or inactive");
  }

  return match;
}

// Current futures prices
async function getPrices(instrument) {
  const response = await http.get(
    PUBLIC + "/market_data/v3/current_prices/futures/rt"
  );

  const prices = response.data.prices || {};
  const item = prices[instrument];

  if (!item) {
    throw new Error("Live futures price unavailable");
  }

  return {
    pair: instrument,
    last_price: item.ls,
    mark_price: item.mp,
    high_24h: item.h,
    low_24h: item.l,
    volume_24h: item.v,
    change_percent: item.pc,
    funding_rate: item.fr,
    timestamp: response.data.ts
  };
}

// Futures order book
async function getOrderBook(instrument) {
  const url =
    PUBLIC +
    "/market_data/v3/orderbook/" +
    encodeURIComponent(instrument) +
    "-futures/50";

  const response = await http.get(url);
  const data = response.data;

  if (!data.bids || !data.asks) {
    throw new Error("Invalid order book response");
  }

  return data;
}

// Futures 5-minute candles
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

  const data = response.data;

  if (data.s !== "ok" || !Array.isArray(data.data)) {
    throw new Error("Invalid futures candle response");
  }

  return data.data;
}

app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    scanner: "UD Crypto Intelligence",
    exchange: "CoinDCX Futures",
    timeframe: "5 minutes",
    timestamp: new Date().toISOString()
  });
});

// Search and scan one CoinDCX futures coin
app.get("/api/scan/:pair", async (req, res) => {
  try {
    const input = req.params.pair;

    if (!input || input.length > 40) {
      return res.status(400).json({
        success: false,
        error: "Invalid coin name"
      });
    }

    const instrument = await findInstrument(input);

    const results = await Promise.allSettled([
      getPrices(instrument),
      getOrderBook(instrument),
      getCandles(instrument)
    ]);

    const [ticker, orderbook, candles] = results;

    const data = {
      requested_coin: input,
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
      }
    };

    const allAvailable = results.every(
      result => result.status === "fulfilled"
    );

    res.json({
      success: true,
      complete: allAvailable,
      data,
      message: allAvailable
        ? "All three CoinDCX futures data sources received"
        : "Some data sources unavailable. Trade analysis not permitted."
    });

  } catch (error) {
    res.status(502).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("UD Crypto Intelligence running on " + PORT);
});
