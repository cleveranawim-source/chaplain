// 반 전체 생성의 'AI로 다듬기'가 부르는 서버 함수.
// 교사 관찰 메모와 반 공통 수업 내용을 업스테이지 Solar로 보내 세특 문장으로 다듬는다.
// API 키는 Vercel 환경변수에만 두고 브라우저로 보내지 않는다.
//
// 환경변수
//   UPSTAGE_API_KEY          (필수) 업스테이지 콘솔에서 발급한 키
//   ACCESS_CODE              (선택) 설정하면 이 코드를 입력한 사람만 호출할 수 있다
//   UPSTAGE_MODEL            (선택) 기본값 solar-pro4
//   UPSTAGE_REASONING_EFFORT (선택) 기본값 low
const crypto = require("node:crypto");

const UPSTAGE_URL = "https://api.upstage.ai/v1/chat/completions";
const MODEL = process.env.UPSTAGE_MODEL || "solar-pro4";
const REASONING_EFFORT = process.env.UPSTAGE_REASONING_EFFORT || "low";
const UPSTREAM_TIMEOUT_MS = 50000;
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
    .replace(/[\r\n]+/g, " ")
    .replace(leading, "")
    .replace(/^(세특|세부능력 및 특기사항|결과)\s*[:：]\s*/, "")
    .replace(leading, "")
    .replace(/[\s"'“”‘’「」『』*]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function readBody(req) {
  const body = req.body;
  if (!body) return {};
  if (typeof body === "string") return JSON.parse(body);
  return body;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const apiKey = process.env.UPSTAGE_API_KEY || "";
  const accessCode = process.env.ACCESS_CODE || "";

  if (req.method === "GET") {
    return res.status(200).json({ enabled: Boolean(apiKey), requiresCode: Boolean(accessCode), model: MODEL });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "지원하지 않는 요청입니다." });
  }
  if (!apiKey) {
    return res.status(503).json({ error: "서버에 업스테이지 API 키가 설정되지 않았습니다." });
  }

  let input;
  try {
    input = readBody(req);
  } catch (error) {
    return res.status(400).json({ error: "요청 형식이 올바르지 않습니다." });
  }
  if (accessCode && !sameSecret(input.accessCode, accessCode)) {
    return res.status(401).json({ error: "접속 코드가 맞지 않습니다." });
  }
  if (!clean(input.memo, MAX_MEMO_LENGTH)) {
    return res.status(400).json({ error: "관찰 메모가 없는 학생은 AI로 다듬지 않습니다." });
  }

  let upstream;
  try {
    upstream = await fetch(UPSTAGE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(input) }
        ],
        temperature: 0.7,
        max_tokens: 2000,
        reasoning_effort: REASONING_EFFORT
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (error) {
    const timedOut = error && error.name === "TimeoutError";
    return res.status(timedOut ? 504 : 502).json({ error: timedOut ? "AI 응답이 너무 오래 걸립니다." : "AI 서버에 연결하지 못했습니다." });
  }

  if (!upstream.ok) {
    // 학생 메모가 로그에 남지 않도록 상태 코드만 기록한다.
    console.error(`Upstage API error: ${upstream.status}`);
    const message = upstream.status === 429 ? "AI 요청이 몰렸습니다. 잠시 뒤 다시 시도해 주세요." : `AI 서버 오류(${upstream.status})`;
    return res.status(502).json({ error: message });
  }

  let data;
  try {
    data = await upstream.json();
  } catch (error) {
    return res.status(502).json({ error: "AI 응답을 읽지 못했습니다." });
  }
  const text = cleanOutput(data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content);
  if (!text) {
    return res.status(502).json({ error: "AI가 빈 응답을 보냈습니다." });
  }
  return res.status(200).json({ text, model: MODEL });
};
