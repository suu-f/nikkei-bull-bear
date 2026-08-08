// 日経平均のデータを無料のYahoo Finance chart APIから取得し、
// ブル型/ベア型レバレッジ投信の売買判断に使う指標を計算してdata/latest.jsonに書き出す。
import { writeFile } from "node:fs/promises";

const SYMBOL = "%5EN225"; // ^N225 (日経平均)
const API_URL = `https://query1.finance.yahoo.com/v8/finance/chart/${SYMBOL}?range=2y&interval=1d`;

function sma(values, period, endIndex) {
  if (endIndex + 1 < period) return null;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) sum += values[i];
  return sum / period;
}

function rsi(values, period, endIndex) {
  if (endIndex - period < 0) return null;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum += -diff;
  }
  const avgGain = gainSum / period;
  const avgLoss = lossSum / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function annualizedVolatility(values, period, endIndex) {
  if (endIndex - period < 0) return null;
  const rets = [];
  for (let i = endIndex - period + 1; i <= endIndex; i++) {
    rets.push(Math.log(values[i] / values[i - 1]));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance =
    rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  const dailyStd = Math.sqrt(variance);
  return dailyStd * Math.sqrt(252) * 100; // %
}

function fmtDateJST(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }); // YYYY-MM-DD
}

async function main() {
  const res = await fetch(API_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    },
  });
  if (!res.ok) {
    throw new Error(`Yahoo Finance fetch failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("Unexpected response shape from Yahoo Finance");

  const timestamps = result.timestamp;
  const closes = result.indicators.quote[0].close;

  // 欠損(null)の日を除去
  const dates = [];
  const prices = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] == null) continue;
    dates.push(fmtDateJST(timestamps[i]));
    prices.push(closes[i]);
  }

  const n = prices.length;
  const last = n - 1;
  if (n < 80) throw new Error(`データ件数が不足しています (${n}件)`);

  const price = prices[last];
  const sma25 = sma(prices, 25, last);
  const sma75 = sma(prices, 75, last);
  const sma25Prev = sma(prices, 25, last - 1);
  const sma75Prev = sma(prices, 75, last - 1);
  const rsi14 = rsi(prices, 14, last);
  const vol25 = annualizedVolatility(prices, 25, last);
  const deviationPct = ((price - sma25) / sma25) * 100;

  // ゴールデンクロス/デッドクロス判定 (直近5営業日以内に発生したか)
  let crossSignal = null;
  const lookback = Math.min(5, last - 75);
  for (let i = last - lookback + 1; i <= last; i++) {
    if (i - 1 < 75) continue;
    const s25now = sma(prices, 25, i);
    const s75now = sma(prices, 75, i);
    const s25prev = sma(prices, 25, i - 1);
    const s75prev = sma(prices, 75, i - 1);
    if (s25now == null || s75now == null || s25prev == null || s75prev == null) continue;
    if (s25prev <= s75prev && s25now > s75now) crossSignal = { type: "golden", date: dates[i] };
    if (s25prev >= s75prev && s25now < s75now) crossSignal = { type: "dead", date: dates[i] };
  }

  // トレンド判定
  let trend;
  if (price > sma25 && sma25 > sma75) trend = "up";
  else if (price < sma25 && sma25 < sma75) trend = "down";
  else trend = "mixed";

  // 過熱感
  let overheat = "neutral";
  if (rsi14 >= 70) overheat = "overbought";
  else if (rsi14 <= 30) overheat = "oversold";

  const highVol = vol25 !== null && vol25 >= 25; // 年率25%を高ボラの目安に

  // 総合判定
  let signal, headline, rationale;
  if (trend === "up" && overheat !== "overbought") {
    signal = "bull";
    headline = "ブル型優勢";
    rationale = "日経平均は上昇トレンド(終値>25日線>75日線)で、RSIも過熱していません。";
  } else if (trend === "up" && overheat === "overbought") {
    signal = "bull_caution";
    headline = "ブル型優勢だが過熱感あり";
    rationale = "上昇トレンドですがRSIが70以上で買われすぎ気味です。押し目を待つ選択肢もあります。";
  } else if (trend === "down" && overheat !== "oversold") {
    signal = "bear";
    headline = "ベア型優勢";
    rationale = "日経平均は下降トレンド(終値<25日線<75日線)で、RSIも売られすぎではありません。";
  } else if (trend === "down" && overheat === "oversold") {
    signal = "bear_caution";
    headline = "ベア型優勢だが過熱感あり";
    rationale = "下降トレンドですがRSIが30以下で売られすぎ気味です。反発リスクに注意してください。";
  } else {
    signal = "wait";
    headline = "様子見(トレンド不明瞭)";
    rationale = "終値・25日線・75日線の並びが揃っておらず、方向感がはっきりしません。";
  }

  const history = [];
  const histStart = Math.max(0, n - 130);
  for (let i = histStart; i <= last; i++) {
    history.push({
      date: dates[i],
      close: Number(prices[i].toFixed(2)),
      sma25: sma(prices, 25, i) !== null ? Number(sma(prices, 25, i).toFixed(2)) : null,
      sma75: sma(prices, 75, i) !== null ? Number(sma(prices, 75, i).toFixed(2)) : null,
    });
  }

  const output = {
    updatedAt: new Date().toISOString(),
    asOfDate: dates[last],
    price: Number(price.toFixed(2)),
    sma25: Number(sma25.toFixed(2)),
    sma75: Number(sma75.toFixed(2)),
    deviationPct: Number(deviationPct.toFixed(2)),
    rsi14: Number(rsi14.toFixed(1)),
    vol25AnnualizedPct: vol25 !== null ? Number(vol25.toFixed(1)) : null,
    trend,
    overheat,
    highVol,
    crossSignal,
    signal,
    headline,
    rationale,
    history,
  };

  await writeFile(new URL("../data/latest.json", import.meta.url), JSON.stringify(output, null, 2));
  console.log(`書き込み完了: ${output.asOfDate} price=${output.price} signal=${output.signal}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
