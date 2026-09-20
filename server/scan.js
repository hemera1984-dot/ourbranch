// 수첩 스캔 — 사진 한 장을 일정 표로 (2026-09-20 사용자: 「스캔 버튼을 누르고 찍으면 입력되게」).
// 서버는 의존성 0 원칙이라 SDK 없이 fetch로 부른다. 사진은 어디에도 저장하지 않는다 —
// 읽은 표만 돌려주고, 저장은 사용자가 화면에서 확인한 뒤에 한다(입력 원칙: 미리 채우되 저절로 저장하지 않는다).

export const SCAN_KINDS = [
  "밸류업/이관", "외근", "내근", "TS1", "TS2", "GROW", "시험",
  "입과전교육생일정", "입과교육", "차월교육", "교육", "지점일정", "본부일정", "마감", "휴가", "기타"
];

const SCHEMA = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD. 읽을 수 없으면 빈 문자열" },
          start: { type: "string", description: "HH:MM 24시간제. 없으면 빈 문자열" },
          end: { type: "string", description: "HH:MM 24시간제. 없으면 빈 문자열" },
          kind: { type: "string", enum: SCAN_KINDS },
          title: { type: "string", description: "적힌 내용 그대로, 짧게" },
          place: { type: "string", description: "장소. 없으면 빈 문자열" },
          unsure: { type: "boolean", description: "날짜·시간·글자 중 하나라도 추측했으면 true" },
          note: { type: "string", description: "unsure일 때 무엇이 불확실한지 한 줄. 아니면 빈 문자열" }
        },
        required: ["date", "start", "end", "kind", "title", "place", "unsure", "note"],
        additionalProperties: false
      }
    }
  },
  required: ["rows"],
  additionalProperties: false
};

export function buildScanRequest(b64, mediaType, todayStr) {
  const dow = "일월화수목금토"[new Date(todayStr + "T00:00:00").getDay()];
  return {
    model: "claude-opus-5",
    max_tokens: 8000,
    // 거절되면 같은 요청을 대체 모델로 한 번 더 — 수첩 사진이 걸릴 일은 드물지만 걸리면 사용자는 이유를 모른다
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
        { type: "text", text:
`보험설계사가 수첩·다이어리·메모지에 손으로 적은 일정을 찍은 사진입니다. 적힌 일정을 표로 옮겨 주세요.
오늘은 ${todayStr} (${dow}요일)입니다.

옮기는 법
- 사진에 적힌 것만 옮깁니다. 없는 일정·장소·시간을 만들어 넣지 않습니다.
- 한 줄에 일정 하나. 일정이 아닌 낙서·할 일 목록·금액 메모는 건너뜁니다.
- 날짜: 연도가 없으면 오늘에서 가장 가까운 앞날(오늘 포함)로 봅니다. 「21일」「월요일」처럼 일부만 있으면 같은 식으로 채우고 unsure를 true로 둡니다. 날짜를 전혀 알 수 없으면 date를 비웁니다.
- 시간: 24시간제 HH:MM. 「3시」처럼 오전·오후가 없으면 영업 시간대(07~21시)에 맞는 쪽으로 옮기고 unsure를 true로 둡니다. 끝 시간이 없으면 end를 비웁니다.
- kind: 고객을 만나거나 밖에 나가는 약속은 「외근」, 사무실에서 하는 일은 「내근」, 「밸류업」「이관」이라고 적혀 있으면 「밸류업/이관」, 면접은 1차면 「TS1」 2차면 「TS2」, 시험·교육·마감·휴가는 그대로. 어디에도 안 맞으면 「기타」.
- title: 적힌 말을 그대로 짧게. 사람 이름은 적힌 대로 두되, 전화번호·주민등록번호·계좌번호·주소의 동호수는 절대 옮기지 않습니다.
- place: 「강남」「○○카페」「본사 3층」 같은 장소만.
- 글씨가 흐려 확신이 없는 글자가 있으면 가장 그럴듯하게 읽고 unsure를 true, note에 무엇이 불확실한지 한 줄로 적습니다.
- 일정이 하나도 없으면 rows를 빈 배열로 돌려줍니다.` }
      ]
    }]
  };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
// 모델이 지시를 어겨도 번호는 저장소에 남기지 않는다 (헌법: 연락처는 남기지 않는다)
const PHONE = /0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}|\d{6}[-\s]?[1-4]\d{6}/g;
const clean = (s, n) => String(s || "").replace(PHONE, "").replace(/\s+/g, " ").trim().slice(0, n);

export function cleanRows(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, 40).map(r => ({
    date: DATE.test(r.date) ? r.date : "",
    start: TIME.test(r.start) ? r.start : "",
    end: TIME.test(r.end) ? r.end : "",
    kind: SCAN_KINDS.includes(r.kind) ? r.kind : "기타",
    title: clean(r.title, 100),
    place: clean(r.place, 60),
    unsure: !!r.unsure || !DATE.test(r.date),
    note: clean(r.note, 120)
  })).filter(r => r.title || r.place);
}

// 호출 한 번 — 실패는 사용자가 읽을 수 있는 말로 던진다
export async function scanImage(apiBase, key, b64, mediaType, todayStr) {
  const res = await fetch(apiBase + "/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "x-api-key": key,
      "anthropic-version": "2023-06-01", "anthropic-beta": "server-side-fallback-2026-07-01"
    },
    body: JSON.stringify(buildScanRequest(b64, mediaType, todayStr)),
    signal: AbortSignal.timeout(90e3)
  });
  const j = await res.json().catch(() => ({}));
  if (res.status === 429 || res.status >= 500) throw new Error("지금 읽는 곳이 붐빕니다. 잠시 뒤 다시 찍어 주세요.");
  if (!res.ok) throw new Error("사진을 읽지 못했습니다 (" + res.status + (j.error && j.error.type ? " " + j.error.type : "") + ")");
  if (j.stop_reason === "refusal") throw new Error("이 사진은 읽을 수 없습니다. 일정이 적힌 면만 다시 찍어 주세요.");
  if (j.stop_reason === "max_tokens") throw new Error("한 장에 일정이 너무 많습니다. 나눠서 찍어 주세요.");
  const text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("읽은 결과를 표로 만들지 못했습니다. 다시 찍어 주세요."); }
  return cleanRows(data.rows);
}
