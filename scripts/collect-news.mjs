import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import OpenAI from "openai";

const KST_TIME_ZONE = "Asia/Seoul";
const MAX_ITEMS = 20;
const MIN_SCORE = 20;
const MODEL = process.env.OPENAI_MODEL || "gpt-5.5";

const CATEGORIES = [
  "AI·반도체",
  "방산·항공우주",
  "조선·중공업",
  "자동차·로봇",
  "배터리·소재",
  "원전·SMR",
  "연구성과·세계최초기술",
];

const BLOCKED_HOST_PARTS = [
  "google.",
  "youtube.com",
  "youtu.be",
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "tiktok.com",
  "naver.com",
  "daum.net",
  "kakao.com",
  "blog.",
  "cafe.",
];

const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      minItems: 1,
      maxItems: MAX_ITEMS,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "score",
          "articleDate",
          "category",
          "keyword",
          "title",
          "url",
        ],
        properties: {
          score: { type: "integer", minimum: MIN_SCORE, maximum: 100 },
          articleDate: {
            type: "string",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          },
          category: { type: "string", enum: CATEGORIES },
          keyword: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          url: { type: "string", pattern: "^https?://" },
        },
      },
    },
  },
};

function formatKstDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: KST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(yyyyMmDd, days) {
  const date = new Date(`${yyyyMmDd}T00:00:00+09:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return formatKstDate(date);
}

function normalizeText(value) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function canonicalUrl(value) {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (
      key.toLowerCase().startsWith("utm_") ||
      ["fbclid", "gclid", "ref", "source"].includes(key.toLowerCase())
    ) {
      url.searchParams.delete(key);
    }
  }
  return url.toString().replace(/\/$/, "");
}

function isDirectArticleUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (BLOCKED_HOST_PARTS.some((part) => host.includes(part))) return false;
    if (!url.pathname || url.pathname === "/") return false;
    if (/\/(search|검색)(\/|$)/i.test(url.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

async function readPreviousCollection(collectedAt) {
  const previousDate = shiftDate(collectedAt, -1);
  const previousPath = path.join("data", `news-${previousDate}.json`);

  try {
    const raw = await fs.readFile(previousPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      previousDate,
      items: Array.isArray(parsed.items) ? parsed.items : [],
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`직전 컬렉션을 읽지 못했습니다: ${error.message}`);
    }
    return { previousDate, items: [] };
  }
}

function buildPrompt({ collectedAt, startDate, previousDate, previousItems }) {
  const previousJson = JSON.stringify(previousItems, null, 2);

  return `
오늘 수집일은 한국시간 ${collectedAt}이다. 웹 검색을 사용해 아래 조건을 모두 만족하는
한국 국내 언론사의 한국어 뉴스 기사만 수집하고, 지정된 JSON 스키마로만 반환하라.

[절대 날짜 조건]
- 기사 발행일은 ${startDate}부터 ${collectedAt}까지(양 끝 포함)여야 한다.
- 기사 본문 페이지에서 발행일을 확인할 수 없는 기사는 제외한다.
- 업데이트 날짜가 최근이어도 최초 발행일이 범위 밖이면 제외한다.

[검색 키워드 전체 범위]
- AI·반도체: AI, 인공지능, 생성형 AI, 온디바이스 AI, 반도체, HBM, HBM4,
  파운드리, 첨단 패키징, D램, 낸드, 시스템반도체, AI 가속기, NPU, 팹리스
- 방산·항공우주: K-방산, 방산 수출, 무기 수출, 전투기, KF-21, FA-50,
  K2 전차, K9 자주포, 천무, 미사일, 잠수함, 위성, 발사체, 우주, 항공우주
- 조선·중공업: 조선 수주, LNG선, 암모니아선, 메탄올선, 특수선, 해양플랜트,
  엔진, 중공업, 초대형 선박
- 자동차·로봇: 자동차 수출, 전기차, 하이브리드, 자율주행, SDV, 휴머노이드,
  산업용 로봇, 서비스 로봇
- 배터리·소재: 배터리, 이차전지, 전고체, 양극재, 음극재, 분리막, 리튬,
  희토류, 핵심광물, 첨단소재
- 원전·SMR: 원전 수출, 원자력, SMR, 소형모듈원자로, 핵융합
- 연구성과·세계최초기술: 세계 최초, 세계 1위, 독자 개발, 국산화, 초격차,
  기술 수출, 수출 신기록, 연구 돌파구, 최고 성능

[선정 및 점수]
- 추천도는 20~100 정수이며 인기도, 유튜브 제목·썸네일 잠재력,
  한국의 산업·기술·수출·국가적 관심과 자부심 유발 가능성을 종합한다.
- 추천도 20 미만은 제외하고 최대 ${MAX_ITEMS}개만 반환한다.
- 점수 내림차순으로 정렬한다.
- 광고성 보도자료 재게시, 단순 주가 기사, 전망만 있는 기사, 근거 없는 과장은 제외한다.

[카테고리 균형 목표]
- AI·반도체 4~5개
- 방산·항공우주 4~5개
- 조선·중공업 2~3개
- 자동차·로봇 2~3개
- 배터리·소재 2~3개
- 원전·SMR 1~2개
- 연구성과·세계최초기술 1~2개
적격 기사가 부족하면 억지로 채우지 말되 한 사건이나 카테고리가 결과를 지배하지 않게 하라.

[링크 및 중복 제거]
- 언론사 자체 도메인의 개별 기사 본문 URL만 허용한다.
- 뉴스 홈페이지, 섹션 페이지, 검색 결과, 네이버·다음 뉴스, SNS, 유튜브,
  블로그, 카페, 정부 검색 페이지, 보도자료 원문, 임시·깨진 링크는 제외한다.
- 같은 사건을 다룬 기사는 가장 강한 기사 하나만 남긴다.
- URL, 제목뿐 아니라 실질적으로 동일한 사건 보도도 중복으로 간주한다.

[직전 컬렉션 비교]
직전 날짜는 ${previousDate}이다. 아래 직전 컬렉션에 포함된 URL, 제목 또는
실질적으로 동일한 사건은 절대 다시 포함하지 않는다. 새로운 계약 체결, 새 시험 성공,
새 수출 확정 등 독립적인 후속 전개가 명확할 때만 새 사건으로 인정한다.

${previousJson}

[출력 규칙]
- category는 다음 중 정확히 하나만 사용한다:
  ${CATEGORIES.join(", ")}
- keyword는 해당 기사의 핵심 한국어 키워드 1~3개를 쉼표로 적는다.
- title은 기사 페이지의 실제 한국어 제목을 사용한다.
- articleDate는 YYYY-MM-DD 형식의 확인된 발행일이다.
- url은 추적 파라미터가 없는 최종 직접 기사 URL이다.
`.trim();
}

function validateItems(rawItems, { startDate, collectedAt, previousItems }) {
  const previousUrls = new Set();
  const previousTitles = new Set();

  for (const item of previousItems) {
    try {
      if (item.url) previousUrls.add(canonicalUrl(item.url));
    } catch {
      // 과거 파일의 잘못된 URL은 제목 중복 검사만 적용한다.
    }
    if (item.title) previousTitles.add(normalizeText(item.title));
  }

  const seenUrls = new Set();
  const seenTitles = new Set();
  const valid = [];

  for (const item of rawItems) {
    if (!Number.isInteger(item.score) || item.score < MIN_SCORE) continue;
    if (!CATEGORIES.includes(item.category)) continue;
    if (item.articleDate < startDate || item.articleDate > collectedAt) continue;
    if (!/[\u3131-\u318E\uAC00-\uD7A3]/u.test(item.title)) continue;
    if (!isDirectArticleUrl(item.url)) continue;

    const url = canonicalUrl(item.url);
    const title = normalizeText(item.title);
    if (previousUrls.has(url) || previousTitles.has(title)) continue;
    if (seenUrls.has(url) || seenTitles.has(title)) continue;

    seenUrls.add(url);
    seenTitles.add(title);
    valid.push({
      score: item.score,
      articleDate: item.articleDate,
      category: item.category,
      keyword: item.keyword.trim(),
      title: item.title.trim(),
      url,
    });
  }

  return valid
    .sort((a, b) => b.score - a.score || b.articleDate.localeCompare(a.articleDate))
    .slice(0, MAX_ITEMS);
}

function printCollection(collection, fileName) {
  console.log("추천도, 기사발행일, 수집일, 메인키워드, 뉴스기사제목, 링크");
  for (const item of collection.items) {
    console.log(
      [
        item.score,
        item.articleDate,
        collection.collectedAt,
        item.keyword,
        item.title,
        item.url,
      ].join(", "),
    );
  }
  console.log(`\ndata/${fileName}\n`);
  console.log(JSON.stringify(collection, null, 2));
  console.log(`\nGitHub 업로드는 data/${fileName} 파일 하나만 추가하면 됩니다.`);
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY 환경변수가 없습니다.");
  }

  const collectedAt = formatKstDate();
  const startDate = shiftDate(collectedAt, -6);
  const { previousDate, items: previousItems } =
    await readPreviousCollection(collectedAt);

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.responses.create({
    model: MODEL,
    reasoning: { effort: "high" },
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
    input: buildPrompt({
      collectedAt,
      startDate,
      previousDate,
      previousItems,
    }),
    text: {
      format: {
        type: "json_schema",
        name: "korean_news_collection",
        strict: true,
        schema: outputSchema,
      },
    },
  });

  if (!response.output_text) {
    throw new Error("OpenAI API가 JSON 결과를 반환하지 않았습니다.");
  }

  let parsed;
  try {
    parsed = JSON.parse(response.output_text);
  } catch (error) {
    throw new Error(`OpenAI 응답 JSON 파싱 실패: ${error.message}`);
  }

  const items = validateItems(parsed.items || [], {
    startDate,
    collectedAt,
    previousItems,
  });

  if (items.length === 0) {
    throw new Error(
      "검증을 통과한 기사가 0건입니다. 빈 컬렉션은 저장하거나 업로드하지 않습니다.",
    );
  }

  const collection = { collectedAt, items };
  const fileName = `news-${collectedAt}.json`;
  const outputPath = path.join("data", fileName);

  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(collection, null, 2)}\n`, "utf8");

  const saved = JSON.parse(await fs.readFile(outputPath, "utf8"));
  if (
    saved.collectedAt !== collectedAt ||
    !Array.isArray(saved.items) ||
    saved.items.length !== items.length
  ) {
    throw new Error("생성된 JSON 파일의 최종 검증에 실패했습니다.");
  }

  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(
      process.env.GITHUB_OUTPUT,
      `file=${outputPath.replaceAll("\\", "/")}\n`,
      "utf8",
    );
  }

  printCollection(collection, fileName);
  console.error(`\n검증 완료: ${outputPath} (${items.length}개 기사)`);
}

main().catch((error) => {
  console.error(`수집 실패: ${error.message}`);
  process.exitCode = 1;
});
