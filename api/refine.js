// 'AI로 다듬기'가 부르는 서버 함수.
// 교사 관찰 메모와 수업 맥락을 AI로 보내 세특 문장으로 다듬는다.
//   - 학교(서버) 키: 업스테이지 Solar. 키는 Vercel 환경변수에만 두고 브라우저로 보내지 않는다.
//   - 개인 키: GPT(OpenAI) 또는 Claude(Anthropic)만 받는다. 키 앞부분으로 회사를 가리며, 저장하거나 기록하지 않는다.
//
// 환경변수
//   UPSTAGE_API_KEY          (선택) 학교(서버) 키. 없으면 개인 키로만 쓸 수 있다
//   ACCESS_CODE              (선택) 서버 키를 쓸 때 이 코드를 입력한 사람만 호출할 수 있다
//   UPSTAGE_MODEL            (선택) 기본값 solar-pro4
//   UPSTAGE_REASONING_EFFORT (선택) 기본값 none. 추론을 켜면 답 없이 추론만 하다 끝날 수 있다
//   OPENAI_MODEL             (선택) 개인 GPT 키로 쓸 모델. 기본값 gpt-6-sol
//   ANTHROPIC_MODEL          (선택) 개인 Claude 키로 쓸 모델. 기본값 claude-opus-5
const crypto = require("node:crypto");
const Anthropic = require("@anthropic-ai/sdk");
const OpenAI = require("openai");

const UPSTAGE_URL = "https://api.upstage.ai/v1/chat/completions";
const MODELS = {
  upstage: process.env.UPSTAGE_MODEL || "solar-pro4",
  openai: process.env.OPENAI_MODEL || "gpt-6-sol",
  anthropic: process.env.ANTHROPIC_MODEL || "claude-opus-5"
};
const UPSTAGE_REASONING_EFFORT = process.env.UPSTAGE_REASONING_EFFORT || "none";
// 서버 기능으로 '거절 시 다른 모델로 다시 시도'를 지원하는 Claude 모델
const CLAUDE_FALLBACK_MODELS = new Set(["claude-opus-5", "claude-opus-5-5", "claude-fable-5-1"]);
const UPSTREAM_TIMEOUT_MS = 50000;
// SDK는 실패 시 한 번 더 시도하므로 두 번을 합쳐도 함수 제한 시간(60초) 안에 끝나게 한다.
const SDK_TIMEOUT_MS = 25000;
const MAX_MEMO_LENGTH = 600;
const MAX_CONTEXT_LENGTH = 600;

const FOCUS_LABELS = {
  understanding: "이해형",
  question: "질문형",
  reflection: "성찰형",
  discussion: "토론형",
  presentation: "발표형",
  practice: "실천형"
};

const INTENSITY_GUIDES = {
  basic: "기본 참여 - 기본적인 참여를 중심으로 담백하게 씀",
  stable: "안정적 수행 - 꾸준한 참여를 중심으로 쓰고 강점을 과장하지 않음",
  growth: "성장 관찰 - 메모에 드러난 변화나 나아진 점을 중심으로 씀",
  strong: "뚜렷한 강점 - 메모에 드러난 강점을 분명히 쓰되 근거 없이 부풀리지 않음",
  support: "보완 필요 - 부족한 점은 노력과 성장 가능성 중심으로 완곡하게 씀"
};

const TONE_LABELS = {
  balanced: "균형 있게",
  growth: "성장 중심",
  academic: "학업 역량 중심",
  community: "공동체 태도 중심"
};

const SYSTEM_PROMPT = [
  "너는 기독교 중·고등학교의 종교 교사가 학교생활기록부 '과목별 세부능력 및 특기사항(세특)'을 쓰도록 돕는 문장 다듬기 도우미다.",
  "",
  "반드시 지킬 규칙:",
  "1. 사실의 근거는 [반 공통 수업 내용]과 [학생 관찰 메모] 두 가지뿐이다. 메모에 없는 행동, 발표, 결과물, 성과, 변화, 수치를 새로 만들지 않는다.",
  "2. [반 공통 수업 내용]은 수업 맥락을 설명하는 데만 쓴다. 메모에 근거가 없으면 이 학생이 그 활동을 특히 잘했다고 쓰지 않는다.",
  "3. 학생에 대한 평가는 메모에 드러난 사실과 [수행 수준]을 넘지 않는다. 과장하지 않는다.",
  "4. 신앙의 깊이나 내면의 신앙을 평가하지 않는다. '믿음이 좋다, 신앙이 깊다, 경건하다, 은혜, 성령, 구원의 확신, 회심, 독실' 같은 표현을 쓰지 않는다. 종교 내용은 이해, 해석, 질문, 성찰, 표현, 공동체 태도로 서술한다.",
  "5. 학생 이름이나 '학생은', '그는', '그녀는' 같은 주어를 쓰지 않는다. 메모에 다른 사람 이름이 있으면 '친구', '모둠원'처럼 바꾼다.",
  "6. 교외 활동과 수상, 자격증, 부모의 직업, 특정 대학·기관·상호·강사 이름은 쓰지 않는다.",
  "7. 모든 문장은 '~함.', '~임.', '~보임.'처럼 명사형으로 끝낸다.",
  "8. [목표 분량]을 넘지 않게 쓰되, 메모가 짧으면 억지로 늘리지 말고 짧게 끝낸다. 공백 포함 500자를 넘지 않는다.",
  "9. '인상적임', '돋보임' 같은 상투적 표현을 되풀이하지 말고 메모의 구체적인 내용이 드러나게 쓴다.",
  "10. 세특 본문 한 단락만 출력한다. 제목, 따옴표, 목록, 설명, 줄바꿈을 넣지 않는다."
].join("\n");

function clean(value, maxLength) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function sameSecret(given, expected) {
  const digest = (value) => crypto.createHash("sha256").update(String(value ?? "")).digest();
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

function buildUserPrompt(input) {
  const gradeYear = ["1", "2", "3"].includes(String(input.gradeYear)) ? `${input.gradeYear}학년` : "";
  const gradeLevel = ["중학교", "고등학교"].includes(input.gradeLevel) ? input.gradeLevel : "";
  const target = Math.min(500, Math.max(200, Number(input.lengthTarget) || 400));
  const lines = [
    `[학교급/학년] ${[gradeLevel, gradeYear].filter(Boolean).join(" ") || "지정 안 함"}`,
    `[단원/수업 주제] ${clean(input.unitName, 60) || "지정 안 함"}`,
    `[반 공통 수업 내용] ${clean(input.classContext, MAX_CONTEXT_LENGTH) || "입력 없음"}`
  ];
  if (FOCUS_LABELS[input.focusType]) lines.push(`[학생 유형(교사 지정)] ${FOCUS_LABELS[input.focusType]}`);
  lines.push(
    `[수행 수준(교사 지정)] ${INTENSITY_GUIDES[input.intensity] || INTENSITY_GUIDES.stable}`,
    `[문체] ${TONE_LABELS[input.toneMode] || TONE_LABELS.balanced}`,
    `[목표 분량] ${target}자 이내`,
    `[학생 관찰 메모] ${clean(input.memo, MAX_MEMO_LENGTH)}`
  );
  return lines.join("\n");
}

// 모델이 덧붙인 생각 과정, 따옴표, '세특:' 같은 머리말, 줄바꿈을 걷어 낸다.
function cleanOutput(text) {
  const leading = /^[\s"'“”‘’「」『』*-]+/;
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<think>[\s\S]*$/, "")
    .replace(/[\r\n]+/g, " ")
    .replace(leading, "")
    .replace(/^(세특|세부능력 및 특기사항|결과)\s*[:：]\s*/, "")
    .replace(leading, "")
    .replace(/[\s"'“”‘’「」『』*]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// content가 문자열이 아니라 조각 배열로 올 때도 글자만 모은다.
function messageText(message) {
  const content = message && message.content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : (part && part.text) || "")).join("");
  }
  return typeof content === "string" ? content : "";
}

function readBody(req) {
  const body = req.body;
  if (!body) return {};
  if (typeof body === "string") return JSON.parse(body);
  return body;
}

class RefineError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 개인 키는 앞부분으로 회사를 가린다. Claude 키(sk-ant-)도 sk-로 시작하므로 먼저 본다.
function personalProvider(key) {
  if (key.startsWith("sk-ant-")) return "anthropic";
  if (key.startsWith("sk-")) return "openai";
  return "";
}

function emptyAnswer(provider, reason, usage) {
  // 원인 파악용으로 종료 사유와 토큰 수만 기록한다(내용은 남기지 않는다).
  console.error(`${provider} empty answer: reason=${reason}, usage=${JSON.stringify(usage)}`);
  const label = reason === "length" || reason === "max_tokens" ? "길이 제한에 걸림" : reason || "알 수 없음";
  return new RefineError(502, `AI가 빈 응답을 보냈습니다(종료 사유: ${label}).`);
}

async function callUpstage(key, userPrompt) {
  let upstream;
  try {
    upstream = await fetch(UPSTAGE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODELS.upstage,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 3000,
        reasoning_effort: UPSTAGE_REASONING_EFFORT
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (error) {
    const timedOut = error && error.name === "TimeoutError";
    throw new RefineError(timedOut ? 504 : 502, timedOut ? "AI 응답이 너무 오래 걸립니다." : "AI 서버에 연결하지 못했습니다.");
  }
  if (!upstream.ok) {
    // 학생 메모가 로그에 남지 않도록 상태 코드만 기록한다.
    console.error(`Upstage API error: ${upstream.status}`);
    const messages = {
      401: "서버에 설정된 API 키가 올바르지 않습니다. 관리자에게 알려 주세요.",
      403: "서버에 설정된 API 키가 올바르지 않습니다. 관리자에게 알려 주세요.",
      402: "업스테이지 계정의 크레딧(잔액)이 부족합니다.",
      429: "AI 요청이 몰렸거나 사용 한도에 걸렸습니다. 잠시 뒤 다시 시도해 주세요."
    };
    throw new RefineError(502, messages[upstream.status] || `AI 서버 오류(${upstream.status})`);
  }
  let data;
  try {
    data = await upstream.json();
  } catch (error) {
    throw new RefineError(502, "AI 응답을 읽지 못했습니다.");
  }
  const choice = (data && data.choices && data.choices[0]) || {};
  const text = cleanOutput(messageText(choice.message));
  if (!text) throw emptyAnswer("Upstage", choice.finish_reason, data && data.usage);
  return text;
}

async function callOpenAI(key, userPrompt) {
  const client = new OpenAI({ apiKey: key, timeout: SDK_TIMEOUT_MS, maxRetries: 1 });
  const completion = await client.chat.completions.create({
    model: MODELS.openai,
    messages: [
      { role: "developer", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt }
    ],
    reasoning_effort: "low",
    max_completion_tokens: 16000
  });
  const choice = completion.choices[0] || {};
  if (choice.message && choice.message.refusal) throw new RefineError(502, "AI가 요청을 거절했습니다.");
  const text = cleanOutput(messageText(choice.message));
  if (!text) throw emptyAnswer("OpenAI", choice.finish_reason, completion.usage);
  return text;
}

async function callAnthropic(key, userPrompt) {
  const client = new Anthropic({ apiKey: key, timeout: SDK_TIMEOUT_MS, maxRetries: 1 });
  const request = {
    model: MODELS.anthropic,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    // 짧은 문장 다듬기라 깊게 생각할 필요가 없다.
    output_config: { effort: "low" }
  };
  // 안전 분류기가 거절하면 서버가 알맞은 다른 모델로 한 번 더 시도한다.
  const response = CLAUDE_FALLBACK_MODELS.has(MODELS.anthropic)
    ? await client.beta.messages.create({ ...request, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
    : await client.messages.create(request);
  if (response.stop_reason === "refusal") throw new RefineError(502, "AI가 요청을 거절했습니다(안전 정책).");
  const text = cleanOutput(response.content.filter((block) => block.type === "text").map((block) => block.text).join(""));
  if (!text) throw emptyAnswer("Anthropic", response.stop_reason, response.usage);
  return text;
}

const CALLERS = { upstage: callUpstage, openai: callOpenAI, anthropic: callAnthropic };

// SDK의 오류 종류를 교사가 알아볼 수 있는 안내로 바꾼다. 학생 메모는 기록하지 않는다.
function sdkErrorToRefineError(error, provider) {
  const sdk = provider === "anthropic" ? Anthropic : OpenAI;
  if (error instanceof sdk.AuthenticationError || error instanceof sdk.PermissionDeniedError) {
    return new RefineError(401, "입력한 개인 API 키가 올바르지 않거나 권한이 없습니다.");
  }
  if (error instanceof sdk.RateLimitError) {
    return new RefineError(502, "AI 요청이 몰렸거나 사용 한도·잔액이 부족합니다. 잠시 뒤 다시 시도하거나 계정 잔액을 확인해 주세요.");
  }
  if (error instanceof sdk.APIConnectionTimeoutError) return new RefineError(504, "AI 응답이 너무 오래 걸립니다.");
  if (error instanceof sdk.APIConnectionError) return new RefineError(502, "AI 서버에 연결하지 못했습니다.");
  if (error instanceof sdk.APIError) {
    // 두 SDK 모두 응답 본문을 error.error에 담는다(Anthropic은 한 번 더 감싼다).
    const detail = (error.error && error.error.error && error.error.error.message) || (error.error && error.error.message) || error.message;
    return new RefineError(502, `AI 서버 오류(${error.status}): ${String(detail).slice(0, 160)}`);
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const apiKey = process.env.UPSTAGE_API_KEY || "";
  const accessCode = process.env.ACCESS_CODE || "";

  if (req.method === "GET") {
    // 설정 점검용: 어느 환경·브랜치·커밋의 배포인지 함께 알려 준다(비밀 값은 넣지 않는다).
    return res.status(200).json({
      enabled: Boolean(apiKey),
      requiresCode: Boolean(accessCode),
      model: MODELS.upstage,
      personalModels: { openai: MODELS.openai, anthropic: MODELS.anthropic },
      environment: process.env.VERCEL_ENV || "local",
      branch: process.env.VERCEL_GIT_COMMIT_REF || "",
      commit: (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7)
    });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "지원하지 않는 요청입니다." });
  }

  let input;
  try {
    input = readBody(req);
  } catch (error) {
    return res.status(400).json({ error: "요청 형식이 올바르지 않습니다." });
  }
  const personalKey = String(input.apiKey || "").trim();
  let provider = "upstage";
  if (personalKey) {
    provider = /^[\w.-]{10,300}$/.test(personalKey) ? personalProvider(personalKey) : "";
    if (!provider) {
      return res.status(400).json({ error: "개인 키는 GPT(OpenAI, sk-로 시작) 또는 Claude(Anthropic, sk-ant-로 시작) 키만 쓸 수 있습니다." });
    }
  } else {
    if (!apiKey) {
      return res.status(503).json({ error: "서버에 학교 키가 없습니다. 개인 GPT 또는 Claude API 키를 입력해 주세요." });
    }
    if (accessCode && !sameSecret(input.accessCode, accessCode)) {
      return res.status(401).json({ error: "접속 코드가 맞지 않습니다." });
    }
  }
  if (!clean(input.memo, MAX_MEMO_LENGTH)) {
    return res.status(400).json({ error: "관찰 메모가 없는 학생은 AI로 다듬지 않습니다." });
  }

  try {
    const text = await CALLERS[provider](personalKey || apiKey, buildUserPrompt(input));
    return res.status(200).json({ text, model: MODELS[provider] });
  } catch (error) {
    const known = error instanceof RefineError ? error : sdkErrorToRefineError(error, provider);
    if (!known) {
      console.error(`${provider} unexpected error: ${error && error.name}`);
      return res.status(502).json({ error: "AI를 부르는 중 오류가 났습니다." });
    }
    if (!(error instanceof RefineError)) console.error(`${provider} API error: ${error.status || error.name}`);
    return res.status(known.status).json({ error: known.message });
  }
};
