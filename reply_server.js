const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.get("/health", (req, res) => {
  res.json({ ok: true, message: "EGA reply server connected" });
});

function buildPrompt(review) {
  return `
너는 리버스 에이징 브랜드 EGA의 리뷰 답글 담당자다.

[브랜드 답글 규칙]
- 첫 문장은 반드시 "안녕하세요, 리버스 에이징 브랜드 EGA입니다"로 시작한다.
- 말투는 정성스럽고 밝지만 너무 과하게 들뜨지 않게 쓴다.
- 고객 리뷰 내용을 반드시 구체적으로 언급하며 공감한다.
- 문단은 3개 이상으로 나눈다.
- 마지막 문장은 반드시 "소중한 리뷰를 남겨주셔서 감사합니다💙"로 끝낸다.
- "자차"라는 표현은 쓰지 말고 "자외선 차단"이라고 쓴다.
- 제품 성분/효능은 확실하지 않으면 임의로 말하지 않는다.
- 핸드크림 성분 설명은 임의로 추가하지 않는다.
- 올리브영 리뷰는 게시 대상이 아니므로 답변을 생성하더라도 참고용 톤으로 작성한다.

[제품별 방향]
- 에센셜 핸드크림: 실내용, 빠른 흡수, 산뜻한 사용감, 보습, 손 주름/미백 기능성 중심
- 어드밴스드 핸드크림: 실외용, 자외선 차단, 손티에이징, 외출 전 케어 중심
- NMN 스킨부스터: NMN, 더미알, 꾸준한 루틴, 리버스 루틴 중심
- 마스크팩: 자외선 노출 후 케어, 얼굴과 목 케어, 나이트 루틴 중심

[리뷰 정보]
채널: ${review.channel || ""}
제품명: ${review.product || review.product_norm || review.product_category || ""}
감정: ${review.sentiment || ""}
키워드: ${(review.keywords || []).join(", ")}
리뷰 원문: ${review.text || ""}

위 리뷰에 대한 EGA 답글을 작성해줘.
`;
}

app.post("/api/generate-reply", async (req, res) => {
  try {
    const { review } = req.body;

    if (!review || !review.text) {
      return res.status(400).json({ ok: false, error: "review text is required" });
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
    console.error(error);
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/generate-bulk", async (req, res) => {
  try {
    const { reviews } = req.body;

    if (!Array.isArray(reviews)) {
      return res.status(400).json({ ok: false, error: "reviews array is required" });
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

    res.json({ ok: true, results });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/post-reply", async (req, res) => {
  res.json({
    ok: false,
    message: "게시 API는 아직 연결 전입니다. 현재는 답변 생성/수정까지만 가능합니다.",
  });
});

app.post("/api/post-bulk", async (req, res) => {
  res.json({
    ok: false,
    message: "일괄 게시 API는 아직 연결 전입니다. 현재는 답변 생성/수정까지만 가능합니다.",
  });
});

app.listen(PORT, () => {
  console.log(`EGA reply server running on http://localhost:${PORT}`);
});
