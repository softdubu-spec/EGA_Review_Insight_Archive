const express = require("express");
const cors = require("cors");
const https = require("https");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "5mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let parsed = data;
        try {
          parsed = JSON.parse(data);
        } catch (e) {}

        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: parsed,
          raw: data,
        });
      });
    });

    req.on("error", reject);

    if (body) req.write(body);
    req.end();
  });
}

async function getCremaAccessToken() {
  const appId = process.env.CREMA_APP_ID;
  const secret = process.env.CREMA_SECRET;

  if (!appId || !secret) {
    throw new Error("CREMA_APP_ID 또는 CREMA_SECRET 환경변수가 없습니다.");
  }

  const body = `grant_type=client_credentials&client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(secret)}`;

  const res = await request(
    {
      hostname: "api.cre.ma",
      path: "/oauth/token",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    body
  );

  if (!res.body || !res.body.access_token) {
    throw new Error("크리마 토큰 발급 실패: " + JSON.stringify(res.body));
  }

  return res.body.access_token;
}

function extractCremaReviewId(value) {
  if (!value) return "";

  const raw = String(value).trim();

  const crmMatch = raw.match(/^CRM(\d+)$/i);
  if (crmMatch) return crmMatch[1];

  const numMatch = raw.match(/\d+/);
  if (numMatch) return numMatch[0];

  return "";
}

function stripHtml(text) {
  return String(text || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function nowIsoKSTSeconds() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().replace("Z", "+09:00").slice(0, 19) + "+09:00";
}

function makeCommentCode(reviewId) {
  return `ega_reply_${reviewId}_${Date.now()}`;
}

async function postCremaComment({ reviewId, message }) {
  const cremaReviewId = extractCremaReviewId(reviewId);

  if (!cremaReviewId) {
    throw new Error(`크리마 리뷰 ID를 찾을 수 없습니다: ${reviewId}`);
  }

  if (!message || !String(message).trim()) {
    throw new Error("게시할 답변 내용이 없습니다.");
  }

  const accessToken = await getCremaAccessToken();

  const payload = {
    code: makeCommentCode(cremaReviewId),
    created_at: nowIsoKSTSeconds(),
    message: stripHtml(message),
    user_code: process.env.CREMA_USER_CODE || "ega",
    user_name: process.env.CREMA_USER_NAME || "EGA",
  };

  const body = JSON.stringify(payload);

  const res = await request(
    {
      hostname: "api.cre.ma",
      path: `/v1/reviews/${encodeURIComponent(cremaReviewId)}/comments?access_token=${encodeURIComponent(accessToken)}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    body
  );

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(
      `크리마 댓글 등록 실패 (${res.statusCode}): ${JSON.stringify(res.body)}`
    );
  }

  return {
    cremaReviewId,
    comment: res.body,
  };
}

function buildPrompt(review) {
  return `
너는 리버스 에이징 브랜드 EGA의 고객 컨설턴트다.
고객 리뷰에 대해 진정성 있게 공감하고, 브랜드 신뢰를 높이며, 재구매 및 루틴 형성을 유도하는 답변을 작성해야 한다.

[입력값]
리뷰 내용: ${review.text || ""}
구매 제품: ${review.product || review.product_norm || review.product_category || ""}
피부 고민: ${review.concern || ""}

[필수 규칙]
- 첫 문장은 반드시 “안녕하세요, 리버스 에이징 브랜드 EGA입니다”로 시작한다.
- 전체 답변은 최소 3문단 이상으로 구성한다.
- 1문단: 고객 경험에 대한 공감 + 감사
- 2문단: 제품 경험 및 효과 설명
- 3문단: 사용 방법 / 루틴 제안 / 추가 제품 제안
- 말투는 밝고 정성스럽지만 과하지 않게, 실제 상담하듯 자연스럽게 작성한다.
- 마지막 문장은 반드시 “소중한 리뷰를 남겨주셔서 감사합니다💙”로 끝낸다.
- “자차”라는 표현은 금지하고 반드시 “자외선 차단”이라고 쓴다.
- 근거 없는 성분 설명, 치료 효과, 과장 표현은 금지한다.
`;
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "EGA reply server is running",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "EGA reply server connected",
  });
});

app.post("/api/generate-reply", async (req, res) => {
  try {
    const { review } = req.body;

    if (!review || !review.text) {
      return res.status(400).json({
        ok: false,
        message: "review.text가 없습니다.",
      });
    }

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: buildPrompt(review),
    });

    res.json({
      ok: true,
      reply: response.output_text,
    });
  } catch (error) {
    console.error("[generate-reply error]", error);
    res.status(500).json({
      ok: false,
      message: error.message || "AI 답변 생성 실패",
    });
  }
});

app.post("/api/generate-bulk", async (req, res) => {
  try {
    const { reviews } = req.body;

    if (!Array.isArray(reviews)) {
      return res.status(400).json({
        ok: false,
        message: "reviews 배열이 필요합니다.",
      });
    }

    const results = [];

    for (const review of reviews) {
      const response = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: buildPrompt(review),
      });

      results.push({
        id: review.id,
        reply: response.output_text,
      });
    }

    res.json({
      ok: true,
      results,
    });
  } catch (error) {
    console.error("[generate-bulk error]", error);
    res.status(500).json({
      ok: false,
      message: error.message || "AI 일괄 생성 실패",
    });
  }
});

app.post("/api/post-reply", async (req, res) => {
  try {
    const reviewId =
      req.body.cremaReviewId ||
      req.body.reviewId ||
      req.body.id ||
      req.body.review_id;

    const replyText =
      req.body.replyText ||
      req.body.reply ||
      req.body.message ||
      req.body.content;

    const result = await postCremaComment({
      reviewId,
      message: replyText,
    });

    res.json({
      ok: true,
      message: "크리마 댓글 등록 완료",
      result,
    });
  } catch (error) {
    console.error("[post-reply error]", error);
    res.status(500).json({
      ok: false,
      message: error.message || "크리마 댓글 등록 실패",
    });
  }
});

app.post("/api/post-bulk", async (req, res) => {
  try {
    const replies = req.body.replies || req.body.items || [];

    if (!Array.isArray(replies) || replies.length === 0) {
      return res.status(400).json({
        ok: false,
        message: "게시할 replies 배열이 없습니다.",
      });
    }

    const results = [];

    for (const item of replies) {
      try {
        const reviewId =
          item.cremaReviewId ||
          item.reviewId ||
          item.id ||
          item.review_id;

        const replyText =
          item.replyText ||
          item.reply ||
          item.message ||
          item.content;

        const result = await postCremaComment({
          reviewId,
          message: replyText,
        });

        results.push({
          id: item.id || reviewId,
          ok: true,
          result,
        });
      } catch (error) {
        results.push({
          id: item.id || item.reviewId || item.cremaReviewId,
          ok: false,
          message: error.message,
        });
      }
    }

    const successCount = results.filter((r) => r.ok).length;
    const failCount = results.length - successCount;

    res.json({
      ok: failCount === 0,
      message:
        failCount === 0
          ? `${successCount}건 게시 완료`
          : `${successCount}건 성공, ${failCount}건 실패`,
      results,
    });
  } catch (error) {
    console.error("[post-bulk error]", error);
    res.status(500).json({
      ok: false,
      message: error.message || "일괄 게시 실패",
    });
  }
});

app.listen(PORT, () => {
  console.log(`EGA reply server running on port ${PORT}`);
});
