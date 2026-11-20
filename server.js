
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

const http = axios.create({ timeout: 25000 });

const TIMEFRAMES = [
  { name: "4H", resolution: "240", seconds: 14400 },
  { name: "1H", resolution: "60", seconds: 3600 },
  { name: "30M", resolution: "30", seconds: 1800 },
  { name: "15M", resolution: "15", seconds: 900 },
  { name: "5M", resolution: "5", seconds: 300 }
];

const num = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function normalize(v) {
  return String(v || "")
    .toUpperCase()
    .replace(/^B-/, "")
    .replace(/[-_/]/g, "")
    .replace(/USDT$/, "");
}

function instrumentName(item) {
  if (typeof item === "string") return item;
  return item?.instrument ||
    item?.instrument_name ||
    item?.pair ||
    item?.symbol ||
    "";
}

async function getInstruments() {
  const r = await http.get(
    API + "/exchange/v1/derivatives/futures/data/active_instruments",
    {
      params: {
        "margin_currency_short_name[]": "USDT"
      }
    }
  );

  if (!Array.isArray(r.data)) {
    throw new Error("Invalid CoinDCX instruments response");
  }

  return r.data;
}

async function findInstrument(input) {
  const instruments = await getInstruments();
  const search = normalize(input);

  const match = instruments.find(
    x => normalize(instrumentName(x)) === search
  );

  if (!match) {
    throw new Error("Coin not found in CoinDCX USDT futures");
  }

  return instrumentName(match);
}

async function getTicker(instrument) {
  const r = await http.get(
    PUBLIC + "/market_data/v3/current_prices/futures/rt"
  );

  const prices = r.data?.prices || {};
  let item = prices[instrument];

  if (!item) {
    const key = Object.keys(prices).find(
      k => normalize(k) === normalize(instrument)
    );
    if (key) item = prices[key];
  }

  if (!item || num(item.ls) <= 0) {
    throw new Error("Live futures price unavailable");
  }

  return {
    last_price: num(item.ls),
    mark_price: num(item.mp),
    high_24h: num(item.h),
    low_24h: num(item.l),
    volume_24h: num(item.v),
    change_percent: num(item.pc),
    funding_rate: num(item.fr)
  };
}

function normalizeSide(side) {
  if (Array.isArray(side)) {
    return side.map(x => {
      if (Array.isArray(x)) {
        return { price: num(x[0]), qty: num(x[1]) };
      }
      return {
        price: num(x.price ?? x.p),
        qty: num(x.quantity ?? x.qty ?? x.q)
      };
    });
  }

  if (side && typeof side === "object") {
    return Object.entries(side).map(([p, q]) => ({
      price: num(p),
      qty: num(q)
    }));
  }

  return [];
}

async function getOrderBook(instrument) {
  const url =
    PUBLIC +
    "/market_data/v3/orderbook/" +
    encodeURIComponent(instrument) +
    "-futures/50";

  const r = await http.get(url);
  const raw = r.data?.data || r.data;

  const bids = normalizeSide(raw?.bids)
    .filter(x => x.price > 0 && x.qty > 0)
    .sort((a, b) => b.price - a.price);

  const asks = normalizeSide(raw?.asks)
    .filter(x => x.price > 0 && x.qty > 0)
    .sort((a, b) => a.price - b.price);

  if (!bids.length || !asks.length) {
    throw new Error("Order book unavailable");
  }

  return {
    bids,
    asks,
    timestamp: raw.ts || raw.timestamp || Date.now()
  };
}

async function getCandles(instrument, tf) {
  const now = Math.floor(Date.now() / 1000);

  // Request enough history for EMA 200 and indicators.
  const count = 240;
  const from = now - count * tf.seconds;

  const r = await http.get(
    PUBLIC + "/market_data/candlesticks",
    {
      params: {
        pair: instrument,
        from,
        to: now,
        resolution: tf.resolution,
        pcode: "f"
      }
    }
  );

  const raw = r.data?.data || r.data;

  if (!Array.isArray(raw)) {
    throw new Error(tf.name + " candle response invalid");
  }

  const candles = raw.map(c => {
    let time = num(c.time ?? c.t);

    if (time > 100000000000) {
      time = Math.floor(time / 1000);
    }

    return {
      time,
      open: num(c.open ?? c.o),
      high: num(c.high ?? c.h),
      low: num(c.low ?? c.l),
      close: num(c.close ?? c.c),
      volume: num(c.volume ?? c.v)
    };
  })
  .filter(c =>
    c.time > 0 &&
    c.open > 0 &&
    c.high > 0 &&
    c.low > 0 &&
    c.close > 0
  )
  .sort((a, b) => a.time - b.time);

  // Remove duplicate candle timestamps.
  const unique = [
    ...new Map(candles.map(c => [c.time, c])).values()
  ];

  // Only completed candles are allowed in analysis.
  const completed = unique.filter(
    c => c.time + tf.seconds <= now
  );

  if (completed.length < 205) {
    throw new Error(
      tf.name + " insufficient completed candle history"
    );
  }

  return completed;
}

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);

  let value = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
  }

  return value;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gain = 0;
  let loss = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];

    if (d > 0) gain += d;
    else loss -= d;
  }

  if (loss === 0) return 100;

  return 100 - 100 / (1 + gain / loss);
}

function atr(candles, period = 14) {
  if (candles.length <= period) return null;

  const ranges = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    ranges.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close)
      )
    );
  }

  const recent = ranges.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

function analyseTimeframe(candles) {
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);
  const r = rsi(closes);
  const a = atr(candles);

  const recentVolumes = volumes.slice(-5);
  const oldVolumes = volumes.slice(-25, -5);

  const recentAvg =
    recentVolumes.reduce((x, y) => x + y, 0) /
    recentVolumes.length;

  const oldAvg =
    oldVolumes.reduce((x, y) => x + y, 0) /
    oldVolumes.length;

  const volumeRising = oldAvg > 0 && recentAvg > oldAvg;

  let trend = "NEUTRAL";

  if (
    last.close > e20 &&
    e20 > e50 &&
    e50 > e200
  ) {
    trend = "BULLISH";
  } else if (
    last.close < e20 &&
    e20 < e50 &&
    e50 < e200
  ) {
    trend = "BEARISH";
  }

  const bullishMomentum =
    r >= 50 && r <= 75 &&
    last.close > previous.close;

  const bearishMomentum =
    r >= 25 && r <= 50 &&
    last.close < previous.close;

  return {
    trend,
    close: last.close,
    candleTime: last.time,
    ema20: e20,
    ema50: e50,
    ema200: e200,
    rsi: r,
    atr: a,
    volumeRising,
    recentVolume: recentAvg,
    oldVolume: oldAvg,
    bullishMomentum,
    bearishMomentum,
    candle: last.close > last.open
      ? "GREEN"
      : last.close < last.open
        ? "RED"
        : "NEUTRAL"
  };
}

function analyseOrderBook(book) {
  const bids = book.bids;
  const asks = book.asks;

  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;

  if (bestAsk <= bestBid) {
    throw new Error("Invalid order book spread");
  }

  const bidDepth = bids.reduce(
    (s, x) => s + x.price * x.qty, 0
  );

  const askDepth = asks.reduce(
    (s, x) => s + x.price * x.qty, 0
  );

  const spread =
    ((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 100;

  const ratio = askDepth > 0 ? bidDepth / askDepth : 0;

  const spreadOK = spread <= 0.15;
  const depthOK = Math.min(bidDepth, askDepth) >= 100;

  return {
    bestBid,
    bestAsk,
    bidDepth,
    askDepth,
    spread,
    ratio,
    spreadOK,
    depthOK,
    protection: spreadOK && depthOK
  };
}

function buildSignal(analysis, book, ticker) {
  const t4 = analysis["4H"];
  const t1 = analysis["1H"];
  const t30 = analysis["30M"];
  const t15 = analysis["15M"];
  const t5 = analysis["5M"];

  const higherBull =
    t4.trend === "BULLISH" &&
    t1.trend === "BULLISH" &&
    t30.trend === "BULLISH";

  const higherBear =
    t4.trend === "BEARISH" &&
    t1.trend === "BEARISH" &&
    t30.trend === "BEARISH";

  const setupBull =
    t15.trend === "BULLISH" &&
    t15.bullishMomentum &&
    t15.volumeRising;

  const setupBear =
    t15.trend === "BEARISH" &&
    t15.bearishMomentum &&
    t15.volumeRising;

  const executionBull =
    t5.trend === "BULLISH" &&
    t5.bullishMomentum &&
    t5.volumeRising &&
    t5.candle === "GREEN";

  const executionBear =
    t5.trend === "BEARISH" &&
    t5.bearishMomentum &&
    t5.volumeRising &&
    t5.candle === "RED";

  const longBook = book.ratio >= 1.05;
  const shortBook = book.ratio <= 0.95;

  let signal = "NO TRADE";
  let reason = "Multi-timeframe confirmations not aligned.";

  if (!book.protection) {
    reason = "Liquidity protection failed.";
  } else if (ticker.volume_24h <= 0) {
    reason = "Invalid market volume.";
  } else if (
    higherBull && setupBull && executionBull && longBook
  ) {
    signal = "BUY";
    reason = "4H, 1H, 30M, 15M and 5M bullish confirmations passed.";
  } else if (
    higherBear && setupBear && executionBear && shortBook
  ) {
    signal = "SELL";
    reason = "4H, 1H, 30M, 15M and 5M bearish confirmations passed.";
  }

  const price = t5.close;
  const a = t5.atr || 0;

  let entry = null;
  let stopLoss = null;
  let target1 = null;
  let target2 = null;

  if (signal === "BUY" && a > 0) {
    entry = price;
    stopLoss = price - 1.5 * a;
    target1 = price + 1.5 * a;
    target2 = price + 2.5 * a;
  }

  if (signal === "SELL" && a > 0) {
    entry = price;
    stopLoss = price + 1.5 * a;
    target1 = price - 1.5 * a;
    target2 = price - 2.5 * a;
  }

  return {
    signal,
    reason,
    higherTimeframesAligned: higherBull || higherBear,
    setupConfirmed: setupBull || setupBear,
    executionConfirmed: executionBull || executionBear,
    orderBookConfirmed: signal === "BUY"
      ? longBook
      : signal === "SELL"
        ? shortBook
        : false,
    entry,
    stopLoss,
    target1,
    target2,
    executionTimeframe: "5M",
    signalCandleTime: t5.candleTime
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    scanner: "UD Crypto Intelligence Pro",
    exchange: "CoinDCX Futures",
    analysisTimeframes: ["4H", "1H", "30M", "15M"],
    executionTimeframe: "5M"
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
  } catch (e) {
    res.status(502).json({
      success: false,
      error: e.message
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
      getTicker(instrument),
      getOrderBook(instrument),
      ...TIMEFRAMES.map(tf => getCandles(instrument, tf))
    ]);

    const failed = results.find(x => x.status === "rejected");

    if (failed) {
      throw new Error(failed.reason.message);
    }

    const values = results.map(x => x.value);
    const ticker = values[0];
    const orderbook = values[1];

    const analysis = {};

    TIMEFRAMES.forEach((tf, i) => {
      analysis[tf.name] = analyseTimeframe(values[i + 2]);
    });

    const book = analyseOrderBook(orderbook);
    const trade = buildSignal(analysis, book, ticker);

    res.json({
      success: true,
      complete: true,
      data: {
        coin: input,
        instrument,
        exchange: "CoinDCX Futures",
        timestamp: new Date().toISOString(),
        ticker,
        analysis,
        orderbook: book,
        trade,
        dataStatus: {
          ticker: "fulfilled",
          orderbook: "fulfilled",
          "4H": "fulfilled",
          "1H": "fulfilled",
          "30M": "fulfilled",
          "15M": "fulfilled",
          "5M": "fulfilled"
        }
      }
    });

  } catch (error) {
    res.status(502).json({
      success: false,
      complete: false,
      error: error.message
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("UD Crypto Intelligence running on port " + PORT);
});
