// 日経平均のデータを無料のYahoo Finance chart APIから取得し、
// ブル型/ベア型レバレッジ投信の売買判断に使う指標を計算してdata/latest.jsonに書き出す。
import { writeFile } from "node:fs/promises";

const SYMBOL = "%5EN225"; // ^N225 (日経平均)
// バックテストの信頼性を上げるため10年分(複数の下落局面を含む)を取得する
const API_URL = `https://query1.finance.yahoo.com/v8/finance/chart/${SYMBOL}?range=10y&interval=1d`;

// 「厳選ブル型」の判定条件(訓練期間/検証期間に分けた検証で再現性を確認済み)
const BULL_STRONG_HORIZON_DAYS = 20; // 約1か月後
const BULL_STRONG_RULE = {
  shortPeriod: 20,
  longPeriod: 100,
  extensionPct: 6, // 長期線からの上方乖離が6%以上
  rsiCeiling: 80,
  slopeLookback: 5,
};

// マクロ指標(参考情報): 為替・米国株・投資家心理は日経平均の地合いに影響するため補助的に表示する
const MACRO_SYMBOLS = {
  usdjpy: "JPY=X",
  sp500: "%5EGSPC",
  vix: "%5EVIX",
};

async function fetchDailySeries(symbolEncoded, range = "10d") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbolEncoded}?range=${range}&interval=1d`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`fetch failed for ${symbolEncoded}: ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`unexpected response for ${symbolEncoded}`);
  const timestamps = result.timestamp;
  const closes = result.indicators.quote[0].close;
  const out = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] == null) continue;
    out.push(closes[i]);
  }
  return out;
}

async function fetchMacro() {
  const macro = {};
  for (const [key, symbol] of Object.entries(MACRO_SYMBOLS)) {
    try {
      const closes = await fetchDailySeries(symbol);
      const last = closes.length - 1;
      const value = closes[last];
      const prev = closes[last - 1];
      const changePct = ((value - prev) / prev) * 100;
      macro[key] = { value: Number(value.toFixed(3)), changePct: Number(changePct.toFixed(2)) };
    } catch (err) {
      console.error(`macro fetch failed for ${key}:`, err.message);
      macro[key] = null;
    }
  }
  return macro;
}

function assessMacro(macro) {
  const votes = [];
  if (macro.usdjpy) votes.push(macro.usdjpy.changePct > 0 ? "bull" : "bear"); // 円安=追い風, 円高=向かい風
  if (macro.sp500) votes.push(macro.sp500.changePct > 0 ? "bull" : "bear"); // 米国株高=追い風

  let bias = "mixed";
  if (votes.length === 2 && votes[0] === votes[1]) bias = votes[0] === "bull" ? "supportive_bull" : "supportive_bear";

  let vixStatus = "calm";
  if (macro.vix) {
    if (macro.vix.value >= 25) vixStatus = "risk_off";
    else if (macro.vix.value >= 20) vixStatus = "caution";
  }

  return { bias, vixStatus };
}

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

// トレンド/過熱感の組み合わせから5区分のシグナルを決める(当日判定と過去のバックテストで共通利用)
function classify(trend, overheat) {
  if (trend === "up" && overheat !== "overbought") {
    return { signal: "bull", headline: "ブル型優勢", rationale: "日経平均は上昇トレンド(終値>25日線>75日線)で、RSIも過熱していません。" };
  }
  if (trend === "up" && overheat === "overbought") {
    return { signal: "bull_caution", headline: "ブル型優勢だが過熱感あり", rationale: "上昇トレンドですがRSIが70以上で買われすぎ気味です。押し目を待つ選択肢もあります。" };
  }
  if (trend === "down" && overheat !== "oversold") {
    return { signal: "bear", headline: "ベア型優勢", rationale: "日経平均は下降トレンド(終値<25日線<75日線)で、RSIも売られすぎではありません。" };
  }
  if (trend === "down" && overheat === "oversold") {
    return { signal: "bear_caution", headline: "ベア型優勢だが過熱感あり", rationale: "下降トレンドですがRSIが30以下で売られすぎ気味です。反発リスクに注意してください。" };
  }
  return { signal: "wait", headline: "様子見(トレンド不明瞭)", rationale: "終値・25日線・75日線の並びが揃っておらず、方向感がはっきりしません。" };
}

const CONVICTION_LABELS = { 1: "弱い", 2: "やや弱い", 3: "普通", 4: "やや強い", 5: "強い" };
function convictionLevel(successRatePct) {
  if (successRatePct == null) return null;
  if (successRatePct < 40) return 1;
  if (successRatePct < 50) return 2;
  if (successRatePct < 60) return 3;
  if (successRatePct < 70) return 4;
  return 5;
}

// 過去2年分のデータで「今日と同じ判定が出た日、その後2週間(10営業日)でどうなったか」を集計する
function backtestConviction(prices, horizonDays = 10) {
  const buckets = {};
  for (let i = 75; i <= prices.length - 1 - horizonDays; i++) {
    const p = prices[i];
    const s25 = sma(prices, 25, i);
    const s75 = sma(prices, 75, i);
    const r = rsi(prices, 14, i);
    if (s25 == null || s75 == null || r == null) continue;
    const trend_i = p > s25 && s25 > s75 ? "up" : p < s25 && s25 < s75 ? "down" : "mixed";
    const overheat_i = r >= 70 ? "overbought" : r <= 30 ? "oversold" : "neutral";
    const { signal: sig } = classify(trend_i, overheat_i);
    const fwdReturnPct = ((prices[i + horizonDays] - p) / p) * 100;
    if (!buckets[sig]) buckets[sig] = { count: 0, successCount: 0, returnSum: 0 };
    buckets[sig].count += 1;
    buckets[sig].returnSum += fwdReturnPct;
    const isDirectional = sig === "bull" || sig === "bull_caution" || sig === "bear" || sig === "bear_caution";
    const isBull = sig === "bull" || sig === "bull_caution";
    if (isDirectional && (isBull ? fwdReturnPct > 0 : fwdReturnPct < 0)) buckets[sig].successCount += 1;
  }
  const result = {};
  for (const [sig, b] of Object.entries(buckets)) {
    const isDirectional = sig !== "wait";
    const successRatePct = isDirectional ? Number(((b.successCount / b.count) * 100).toFixed(1)) : null;
    result[sig] = {
      sampleSize: b.count,
      successRatePct,
      avgForwardReturnPct: Number((b.returnSum / b.count).toFixed(2)),
    };
  }
  return result;
}

// 「厳選ブル型」: 100日線を6%以上上回る強い上昇トレンド+短期線が上向きの時のみ発動する高確度シグナル
function isBullStrong(prices, i) {
  const { shortPeriod, longPeriod, extensionPct, rsiCeiling, slopeLookback } = BULL_STRONG_RULE;
  const p = prices[i];
  const sShort = sma(prices, shortPeriod, i);
  const sLong = sma(prices, longPeriod, i);
  const sShortPrev = sma(prices, shortPeriod, i - slopeLookback);
  const r = rsi(prices, 14, i);
  if (sShort == null || sLong == null || sShortPrev == null || r == null) return false;
  const trendUp = p > sShort && sShort > sLong;
  const extensionOk = ((p - sLong) / sLong) * 100 >= extensionPct;
  const rsiOk = r < rsiCeiling;
  const slopeOk = sShort > sShortPrev;
  return trendUp && extensionOk && rsiOk && slopeOk;
}

function backtestBullStrong(prices, horizonDays) {
  let count = 0;
  let successCount = 0;
  let returnSum = 0;
  const start = BULL_STRONG_RULE.longPeriod;
  for (let i = start; i <= prices.length - 1 - horizonDays; i++) {
    if (!isBullStrong(prices, i)) continue;
    const fwdReturnPct = ((prices[i + horizonDays] - prices[i]) / prices[i]) * 100;
    count += 1;
    returnSum += fwdReturnPct;
    if (fwdReturnPct > 0) successCount += 1;
  }
  if (count === 0) return null;
  return {
    sampleSize: count,
    successRatePct: Number(((successCount / count) * 100).toFixed(1)),
    avgForwardReturnPct: Number((returnSum / count).toFixed(2)),
  };
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "");
}

// 無料のGoogle Newsフィードから日経平均関連の見出しのみを取得する(AIによる要約・因果解説は行わない)
async function fetchNews(query = "日経平均", limit = 5) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`;
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      },
    });
    if (!res.ok) throw new Error(`news fetch failed: ${res.status}`);
    const xml = await res.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit).map((m) => {
      const block = m[1];
      const rawTitle = decodeEntities((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
      const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "";
      const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "";
      const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/);
      const source = sourceMatch ? decodeEntities(sourceMatch[1]) : "";
      const suffix = source ? ` - ${source}` : "";
      const title = suffix && rawTitle.endsWith(suffix) ? rawTitle.slice(0, -suffix.length) : rawTitle;
      return { title, link, source, publishedAt: pubDate };
    });
    return items;
  } catch (err) {
    console.error("news fetch failed:", err.message);
    return [];
  }
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

  const macro = await fetchMacro();
  const macroAssessment = assessMacro(macro);
  const news = await fetchNews();

  // 総合判定(基本の5区分)
  let { signal, headline, rationale } = classify(trend, overheat);

  // 「厳選ブル型」: 通常のブル判定よりさらに条件を絞った高確度シグナル(該当時は上書き)
  const bullStrongToday = isBullStrong(prices, last);
  if (bullStrongToday) {
    signal = "bull_strong";
    headline = "ブル型 高確度シグナル";
    rationale = `日経平均は100日線を${BULL_STRONG_RULE.extensionPct}%以上上回る強い上昇トレンドで、短期線も上向いています。過去10年で同条件が発生した局面に絞った、より厳選されたシグナルです。`;
  }

  // 過去実績にもとづく確信度(1〜5段階): 同じ判定パターンが過去に出た日、その後どうなったか
  const HORIZON_DAYS = 10; // 通常の5区分は約2週間後で評価
  const backtest = backtestConviction(prices, HORIZON_DAYS);
  const bucketStats =
    signal === "bull_strong" ? backtestBullStrong(prices, BULL_STRONG_HORIZON_DAYS) : backtest[signal] || null;
  const convictionHorizon = signal === "bull_strong" ? BULL_STRONG_HORIZON_DAYS : HORIZON_DAYS;
  let conviction = null;
  if (bucketStats && bucketStats.successRatePct != null) {
    const level = convictionLevel(bucketStats.successRatePct);
    conviction = {
      level,
      levelLabel: CONVICTION_LABELS[level],
      successRatePct: bucketStats.successRatePct,
      avgForwardReturnPct: bucketStats.avgForwardReturnPct,
      sampleSize: bucketStats.sampleSize,
      horizonDays: convictionHorizon,
      lowSample: bucketStats.sampleSize < 15,
      noEdge: bucketStats.successRatePct <= 50,
    };
  }

  // テクニカル判定とマクロ地合いが逆方向を示していないかチェック
  let macroNote = null;
  const technicalLeansBull = signal === "bull" || signal === "bull_caution" || signal === "bull_strong";
  const technicalLeansBear = signal === "bear" || signal === "bear_caution";
  if (technicalLeansBull && macroAssessment.bias === "supportive_bear") {
    macroNote = "テクニカルはブル型優勢ですが、為替・米国株など外部環境は逆風気味です。";
  } else if (technicalLeansBear && macroAssessment.bias === "supportive_bull") {
    macroNote = "テクニカルはベア型優勢ですが、為替・米国株など外部環境は逆風気味です。";
  } else if (macroAssessment.vixStatus === "risk_off") {
    macroNote = "VIX(米国の恐怖指数)が高水準で、市場全体がリスクオフ気味です。値動きが荒くなりやすい点に注意してください。";
  }

  // 次に何が起きればシグナルが変わるか(様子見/過熱時の目安)
  let nextTrigger = null;
  const structureUp = sma25 > sma75; // 短期線が長期線より上=中期的には上向きの構造
  if (structureUp && !(price > sma25)) {
    nextTrigger = {
      direction: "above",
      level: Number(sma25.toFixed(2)),
      distancePct: Number((((sma25 - price) / price) * 100).toFixed(2)),
      resultingSignal: "bull",
      note: "終値が25日線を上抜けるとブル型優勢に転換します",
    };
  } else if (!structureUp && !(price < sma25)) {
    nextTrigger = {
      direction: "below",
      level: Number(sma25.toFixed(2)),
      distancePct: Number((((price - sma25) / price) * 100).toFixed(2)),
      resultingSignal: "bear",
      note: "終値が25日線を下抜けるとベア型優勢に転換します",
    };
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
    nextTrigger,
    macro,
    macroAssessment,
    macroNote,
    conviction,
    news,
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
