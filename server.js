
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const COINDCX_API = "https://api.coindcx.com";

async function getCoinDCXMarkets() {
  const response = await axios.get(
    `${COINDCX_API}/exchange/v1/markets_details`,
    { timeout: 12000 }
  );
  return response.data;
}

async function getOrderBook(pair) {
  const response = await axios.get(
    `${COINDCX_API}/exchange/v1/derivatives/futures/data/orderbook`,
    { params: { pair }, timeout: 12000 }
  );
  return response.data;
}

async function getTicker(pair) {
  const response = await axios.get(
    `${COINDCX_API}/exchange/ticker`,
    { timeout: 12000 }
  );

  return response.data.find(
    item => item.market === pair
  ) || null;
}

async function getCandles(pair, interval = "5") {
  const response = await axios.get(
    `${COINDCX_API}/exchange/v1/derivatives/futures/data/market_data`,
    {
      params: {
        pair,
        interval,
        limit: 200
      },
      timeout: 15000
    }
  );

  return response.data;
}

app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    scanner: "UD Crypto Intelligence Scanner",
    timestamp: new Date().toISOString()
  });
});

app.get("/api/markets", async (req, res) => {
  try {
    const markets = await getCoinDCXMarkets();
    res.json({ success: true, markets });
  } catch (error) {
    res.status(502).json({
      success: false,
      error: "CoinDCX market data unavailable"
    });
  }
});

app.get("/api/scan/:pair", async (req, res) => {
  const pair = req.params.pair.toUpperCase();

  try {
    const results = await Promise.allSettled([
      getTicker(pair),
      getOrderBook(pair),
      getCandles(pair)
    ]);

    const [ticker, orderbook, candles] = results;

    const data = {
      coin: pair,
      exchange: "CoinDCX",
      timestamp: new Date().toISOString(),
      ticker: ticker.status === "fulfilled" ? ticker.value : null,
      orderbook: orderbook.status === "fulfilled" ? orderbook.value : null,
      candles: candles.status === "fulfilled" ? candles.value : null,
      dataStatus: {
        ticker: ticker.status,
        orderbook: orderbook.status,
        candles: candles.status
      }
    };

    res.json({
      success: true,
      data,
      note: "Partial data must never be treated as a confirmed trade signal."
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Scan failed"
    });
  }
});

app.listen(PORT, () => {
  console.log(`UD Crypto Intelligence running on ${PORT}`);
});
