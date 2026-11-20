
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

function normalize(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/^B-/, "")
    .replace(/[-_/]/g, "")
    .replace(/USDT$/, "");
}

function instrumentName(item) {
  if (typeof item === "string") return item;
  if (item && typeof item === "object") {
    return item.instrument || item.instrument_name ||
      item.pair || item.symbol || "";
  }
  return "";
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeBookSide(side) {
  if (!side) return [];

  if (Array.isArray(side)) {
    return side.map(x => {
      if (Array.isArray(x)) {
        return { price: number(x[0]), qty: number(x[1]) };
      }
      return {
        price: number(x.price ?? x.p),
        qty: number(x.quantity ?? x.qty ?? x.q)
      };
    }).filter(x => x.price > 0 && x.qty > 0);
  }

  if (typeof side === "object") {
    return Object.entries(side).map(([price, qty]) => ({
      price: number(price),
      qty: number(qty)
    })).filter(x => x.price > 0 && x.qty > 0);
  }

  return [];
}

async function getInstruments() {
  const response = await http.get(
    API + "/exchange/v1/derivatives/futures/data/active_instruments",
    { params: { "margin_currency_short_name[]": "USDT" } }
  );

  const data = response.data;
  if (!Array.isArray(data)) {
    throw new Error("Invalid CoinDCX instruments response");
  }
  return data;
}

async function findInstrument(input) {
  const instruments = await getInstruments();
  const search = normalize(input);

  const match = instruments.find(item =>
    normalize(instrumentName(item)) === search
  );

  if (!match) {
    throw new Error("Coin not found in active USDT futures list");
  }

  return instrumentName(match);
}

async function getPrices(instrument) {
  const response = await http.get(
    PUBLIC + "/market_data/v3/current_prices/futures/rt"
  );

  const prices = response.data?.prices;
  if (!prices || typeof prices !== "object") {
    throw new Error("Invalid live prices response");
  }

  let item = prices[instrument];

  if (!item) {
    const key = Object.keys(prices).find(k =>
      normalize(k) === normalize(instrument)
    );
    if (key) item = prices[key];
  }

  if (!item || !number(item.ls)) {
    throw new Error("Live futures price unavailable");
  }

  return {
    instrument,
    last_price: number(item.ls),
    mark_price: number(item.mp),
    high_24h: number(item.h),
    low_24h: number(item.l),
    volume_24h: number(item.v),
    change_percent: number(item.pc),
    funding_rate: number(item.fr),
    timestamp: response.data.ts
  };
}

async function getOrderBook(instrument) {
  const url =
    PUBLIC + "/market_data/v3/orderbook/" +
    encodeURIComponent(instrument) + "-futures/50";

  const response = await http.get(url);
  const raw = response.data?.data || response.data;

  const bids = normalizeBookSide(raw?.bids);
  const asks = normalizeBookSide(raw?.asks);

  if (!bids.length || !asks.length) {
    throw new Error("Invalid or empty futures order book");
  }

  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);

  return {
    bids,
    asks,
    timestamp: raw.ts || raw.timestamp || Date.now()
  };
}

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

  const data = response.data?.data || response.data;

  if (!Array.isArray(data) || data.length < 30) {
    throw new Error("Insufficient 5-minute candle history");
  }

  return data.map(c => ({
    open: number(c.open ?? c.o),
    high: number(c.high ?? c.h),
    low: number(c.low ?? c.l),
    close: number(c.close ?? c.c),
    volume: number(c.volume ?? c.v),
    time: number(c.time ?? c.t)
  })).filter(c =>
    c.open > 0 && c.high > 0 &&
    c.low > 0 && c.close > 0
  );
}

app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    scanner: "UD Crypto Intelligence Pro",
    exchange: "CoinDCX Futures",
    timeframe: "5m"
  });
});

app.get("/api/pairs", async (req, res) => {
  try {
    const instruments = await getInstruments();
    res.json({
      success: true,
      count: instruments.length,
      pairs: instruments.map(instrumentName)
    });
  } catch (error) {
    res.status(502).json({
      success: false,
      error: error.message
    });
  }
});

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

      ticker: ticker.status === "fulfilled"
        ? ticker.value : null,

      orderbook: orderbook.status === "fulfilled"
        ? orderbook.value : null,

      candles: candles.status === "fulfilled"
        ? candles.value : null,

      dataStatus: {
        ticker: ticker.status,
        orderbook: orderbook.status,
        candles: candles.status
      },

      errors: {
        ticker: ticker.status === "rejected"
          ? ticker.reason.message : null,
        orderbook: orderbook.status === "rejected"
          ? orderbook.reason.message : null,
        candles: candles.status === "rejected"
          ? candles.reason.message : null
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
  console.log("UD Crypto Intelligence running on port " + PORT);
});
