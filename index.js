'use strict';

/**
 * LINE 群組翻譯機器人
 * 繁體中文 <-> 印尼文
 *
 * 翻譯策略：Azure OpenAI（GPT-5 mini / 相容 GPT-4.1 mini 等）主翻 + Gemini 3.5 Flash-Lite 備援
 *   - 主翻走 Visual Studio Enterprise 的 Azure 額度：口語自然、資料不被訓練、費用趨近 0
 *   - Azure 呼叫相容「新版模型(GPT-5 系列)」與「舊版模型」：先試新版參數，失敗自動退回舊版
 *   - Azure 失敗/未設定時，自動退回 Gemini（免費層）繼續運作
 * 回覆方式：一律用 replyToken（Reply API，免費、不計 LINE 訊息額度）
 * 輸出格式：「說話者暱稱：<譯文>」
 *
 * 語言判斷：訊息含 CJK 漢字 -> 判為中文 -> 翻成印尼文
 *          否則（拉丁字母為主） -> 判為印尼文 -> 翻成中文
 *          純數字 / emoji / 網址 / 非文字（貼圖、圖片、語音）-> 略過不翻
 */

const express = require('express');
const line = require('@line/bot-sdk');

// ---------------------------------------------------------------------------
// 環境變數
// ---------------------------------------------------------------------------
const {
  CHANNEL_ACCESS_TOKEN,
  CHANNEL_SECRET,

  // Azure OpenAI（主翻）
  AZURE_OPENAI_ENDPOINT,        // 例：https://your-resource.openai.azure.com
  AZURE_OPENAI_KEY,
  AZURE_OPENAI_DEPLOYMENT,      // 你在 Azure 部署的模型名稱（deployment name）
  AZURE_OPENAI_API_VERSION = '2025-04-01-preview', // 支援 GPT-5 系列

  // Gemini（備援）
  GEMINI_API_KEY,
  GEMINI_MODEL = 'gemini-3.5-flash-lite',

  PORT = 3000,
} = process.env;

if (!CHANNEL_ACCESS_TOKEN || !CHANNEL_SECRET) {
  console.error('[FATAL] 缺少 CHANNEL_ACCESS_TOKEN 或 CHANNEL_SECRET，請設定環境變數。');
  process.exit(1);
}

const AOAI_ENABLED = Boolean(
  AZURE_OPENAI_ENDPOINT && AZURE_OPENAI_KEY && AZURE_OPENAI_DEPLOYMENT
);
const GEMINI_ENABLED = Boolean(GEMINI_API_KEY);

if (!AOAI_ENABLED && !GEMINI_ENABLED) {
  console.error('[FATAL] 未設定任何翻譯引擎：請至少設定 Azure OpenAI 或 Gemini 其中一組金鑰。');
  process.exit(1);
}
console.log(
  `[INFO] 主翻：${AOAI_ENABLED ? 'Azure OpenAI (' + AZURE_OPENAI_DEPLOYMENT + ')' : '未設定'}` +
    ` / 備援：${GEMINI_ENABLED ? 'Gemini (' + GEMINI_MODEL + ')' : '未設定'}`
);
if (!AOAI_ENABLED) console.log('[INFO] 未設定 Azure OpenAI，將直接使用 Gemini 翻譯。');

const lineConfig = {
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  channelSecret: CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

// ---------------------------------------------------------------------------
// 語言判斷工具
// ---------------------------------------------------------------------------
function hasHan(text) {
  return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(text);
}

function isTranslatable(text) {
  if (!text) return false;
  const t = text
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/www\.\S+/gi, ' ')
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, ' ')
    .replace(/[\d\s\p{P}\p{S}]/gu, ' ')
    .trim();
  return t.length > 0;
}

function decideDirection(text) {
  if (!isTranslatable(text)) return null;
  if (hasHan(text)) return { from: 'zh-Hant', to: 'id' };
  return { from: 'id', to: 'zh-Hant' };
}

// ---------------------------------------------------------------------------
// 翻譯引擎
// ---------------------------------------------------------------------------
const LANG_LABEL = {
  'zh-Hant': '繁體中文（台灣用語）',
  id: '印尼文（Bahasa Indonesia）',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildSystemPrompt(dir) {
  return (
    `你是台灣雇主與印尼籍移工之間的即時翻譯員。` +
    `請把使用者提供的「${LANG_LABEL[dir.from]}」訊息，翻譯成「${LANG_LABEL[dir.to]}」。\n` +
    `要求：\n` +
    `- 使用自然、口語、日常生活的說法，不要生硬直譯。\n` +
    `- 保留原意與語氣（例如提醒、詢問、感謝）。\n` +
    `- 只輸出翻譯結果本身，不要加任何解釋、引號或標註。`
  );
}

// 是否為「參數不相容」造成的 400（用來決定要不要退回舊版參數）
function looksLikeParamError(status, body) {
  if (status !== 400) return false;
  return /max_tokens|max_completion_tokens|temperature|unsupported|Unrecognized|not supported/i.test(
    body
  );
}

// 呼叫一次 Azure OpenAI（modern=true 用新版參數；modern=false 用舊版參數）
async function callAzureOnce(text, dir, modern) {
  const url =
    `${AZURE_OPENAI_ENDPOINT.replace(/\/$/, '')}/openai/deployments/` +
    `${encodeURIComponent(AZURE_OPENAI_DEPLOYMENT)}/chat/completions` +
    `?api-version=${AZURE_OPENAI_API_VERSION}`;

  const payload = {
    messages: [
      { role: 'system', content: buildSystemPrompt(dir) },
      { role: 'user', content: text },
    ],
  };

  if (modern) {
    // 新版模型（GPT-5 系列）：用 max_completion_tokens、不帶 temperature（僅支援預設值）
    payload.max_completion_tokens = 1024;
  } else {
    // 舊版模型（GPT-4o / GPT-4.1 等）：用 max_tokens，可帶 temperature
    payload.max_tokens = 1024;
    payload.temperature = 0.3;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_OPENAI_KEY,
      },
      signal: controller.signal,
      body: JSON.stringify(payload),
    });

    const bodyText = await resp.text();
    if (!resp.ok) {
      const err = new Error(`Azure OpenAI HTTP ${resp.status}: ${bodyText.slice(0, 200)}`);
      err.status = resp.status;
      err.body = bodyText;
      throw err;
    }

    const data = JSON.parse(bodyText);
    const out = data?.choices?.[0]?.message?.content?.trim();
    if (!out) throw new Error('Azure OpenAI 回傳空內容');
    return out;
  } finally {
    clearTimeout(timeout);
  }
}

// (1) 主翻：Azure OpenAI（自動相容新版/舊版模型參數）
async function translateWithAzureOpenAI(text, dir) {
  try {
    return await callAzureOnce(text, dir, true); // 先試新版參數
  } catch (e) {
    if (looksLikeParamError(e.status, e.body)) {
      console.warn('[azure] 新版參數不相容，改用舊版參數重試。');
      return await callAzureOnce(text, dir, false); // 退回舊版參數
    }
    throw e;
  }
}

// (2) 備援：Gemini（智慧重試）
const GEMINI_RETRY_SERVER = 2;
const GEMINI_RETRY_429 = 1;

async function translateWithGemini(text, dir, serverAttempt = 0, rlAttempt = 0) {
  const prompt = `${buildSystemPrompt(dir)}\n\n原文：\n${text}`;

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${GEMINI_API_KEY}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();

      if (resp.status === 429) {
        const dailyExhausted = /quota|per day|PerDay|exceeded your current quota/i.test(body);
        if (dailyExhausted) {
          throw new Error(`Gemini 每日免費額度已用盡（429）。台灣時間下午 4 點重置。`);
        }
        if (rlAttempt < GEMINI_RETRY_429) {
          console.warn(`[gemini] 429 限流，2s 後重試（第 ${rlAttempt + 1} 次）`);
          clearTimeout(timeout);
          await sleep(2000);
          return translateWithGemini(text, dir, serverAttempt, rlAttempt + 1);
        }
        throw new Error(`Gemini HTTP 429: ${body.slice(0, 200)}`);
      }

      if ([500, 503].includes(resp.status) && serverAttempt < GEMINI_RETRY_SERVER) {
        const wait = 800 * (serverAttempt + 1);
        console.warn(`[gemini] HTTP ${resp.status}（過載），${wait}ms 後重試（第 ${serverAttempt + 1} 次）`);
        clearTimeout(timeout);
        await sleep(wait);
        return translateWithGemini(text, dir, serverAttempt + 1, rlAttempt);
      }

      throw new Error(`Gemini HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }

    const data = await resp.json();
    const out = data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text)
      .join('')
      .trim();
    if (!out) throw new Error('Gemini 回傳空內容');
    return out;
  } catch (err) {
    if (err.name === 'AbortError' && serverAttempt < GEMINI_RETRY_SERVER) {
      console.warn(`[gemini] 逾時，重試（第 ${serverAttempt + 1} 次）`);
      clearTimeout(timeout);
      await sleep(500);
      return translateWithGemini(text, dir, serverAttempt + 1, rlAttempt);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// 主翻（Azure OpenAI）失敗 -> 退備援（Gemini）
async function translate(text, dir) {
  if (AOAI_ENABLED) {
    try {
      return { text: await translateWithAzureOpenAI(text, dir), engine: 'azure-openai' };
    } catch (e) {
      console.warn(`[translate] Azure OpenAI 失敗：${e.message}`);
      if (GEMINI_ENABLED) {
        console.warn('[translate] 改用 Gemini 備援');
        return { text: await translateWithGemini(text, dir), engine: 'gemini' };
      }
      throw e;
    }
  }
  return { text: await translateWithGemini(text, dir), engine: 'gemini' };
}

// ---------------------------------------------------------------------------
// 取得說話者暱稱
// ---------------------------------------------------------------------------
async function getSpeakerName(event) {
  const { source } = event;
  try {
    if (source.type === 'group') {
      const p = await client.getGroupMemberProfile(source.groupId, source.userId);
      return p.displayName;
    }
    if (source.type === 'room') {
      const p = await client.getRoomMemberProfile(source.roomId, source.userId);
      return p.displayName;
    }
    const p = await client.getProfile(source.userId);
    return p.displayName;
  } catch (e) {
    console.warn(`[getSpeakerName] 取暱稱失敗：${e.message}`);
    return '對方';
  }
}

// ---------------------------------------------------------------------------
// 事件處理
// ---------------------------------------------------------------------------
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text = event.message.text || '';
  const dir = decideDirection(text);
  if (!dir) {
    console.log(`[skip] 無可翻譯內容：${text}`);
    return;
  }

  const [speaker, result] = await Promise.all([
    getSpeakerName(event),
    translate(text, dir),
  ]);

  const replyText = `${speaker}：${result.text}`;
  console.log(`[reply] (${result.engine}) ${dir.from}->${dir.to} | ${replyText}`);

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: 'text', text: replyText }],
  });
}

// ---------------------------------------------------------------------------
// Express 伺服器
// ---------------------------------------------------------------------------
const app = express();

app.get('/', (_req, res) => res.status(200).send('LINE translate bot is running.'));
app.get('/health', (_req, res) => res.status(200).send('OK'));

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  res.status(200).end();
  const events = req.body.events || [];
  await Promise.all(
    events.map((ev) =>
      handleEvent(ev).catch((e) => console.error(`[handleEvent] ${e.message}`))
    )
  );
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(
    `翻譯：${AOAI_ENABLED ? 'Azure OpenAI 主翻' : '（無主翻）'}` +
      ` + ${GEMINI_ENABLED ? 'Gemini 備援' : '（無備援）'}`
  );
});
