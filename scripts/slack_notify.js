/**
 * EGA 부정리뷰 슬랙 DM 알림
 *
 * 환경변수:
 *   SLACK_BOT_TOKEN  — Bot User OAuth Token (xoxb-...)
 *   SLACK_USER_EMAIL — DM 받을 사용자 이메일 (예: yeonye330@gmail.com)
 *   또는 SLACK_USER_ID — 슬랙 사용자 ID 직접 지정 (U로 시작)
 */

const https = require('https');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_USER_EMAIL = process.env.SLACK_USER_EMAIL;
const SLACK_USER_ID = process.env.SLACK_USER_ID;

function slackAPI(method, body) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'slack.com',
      path: `/api/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let buf = '';
      res.on('data', chunk => buf += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch(e) { reject(new Error('Slack 응답 파싱 실패: ' + buf.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// 이메일로 슬랙 사용자 ID 조회
async function findUserByEmail(email) {
  const res = await slackAPI('users.lookupByEmail', { email });
  if (!res.ok) throw new Error(`사용자 조회 실패 (${email}): ${res.error}`);
  return res.user.id;
}

// DM 채널 열기
async function openDM(userId) {
  const res = await slackAPI('conversations.open', { users: userId });
  if (!res.ok) throw new Error(`DM 채널 열기 실패: ${res.error}`);
  return res.channel.id;
}

// 메시지 전송
async function sendMessage(channelId, blocks, text) {
  const res = await slackAPI('chat.postMessage', {
    channel: channelId,
    text,        // 알림 미리보기용 텍스트
    blocks,      // 리치 포맷 블록
  });
  if (!res.ok) throw new Error(`메시지 전송 실패: ${res.error}`);
  return res;
}

// 부정 리뷰 1건에 대한 슬랙 블록 생성
function buildReviewBlock(review) {
  const stars = '★'.repeat(review.score || 1) + '☆'.repeat(5 - (review.score || 1));
  const channelEmoji = {
    '카페24': '🛒',
    '스마트스토어': '🟢',
    '올리브영': '💜',
  }[review.channel] || '📝';

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🚨 부정리뷰 감지`, emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*채널:*\n${channelEmoji} ${review.channel}` },
        { type: 'mrkdwn', text: `*별점:*\n${stars} (${review.score}점)` },
        { type: 'mrkdwn', text: `*제품:*\n${review.product || '미확인'}` },
        { type: 'mrkdwn', text: `*날짜:*\n${review.date}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*리뷰 내용:*\n> ${(review.text || '').slice(0, 280)}${(review.text || '').length > 280 ? '...' : ''}`,
      },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `작성자: ${review.reviewer || '익명'} | ID: ${review.id}` },
      ],
    },
    { type: 'divider' },
  ];
}

// 여러 부정 리뷰를 묶어서 알림 (요약 + 상세)
function buildSummaryBlocks(negativeReviews) {
  if (negativeReviews.length === 0) return null;

  // 채널별 집계
  const byChannel = {};
  negativeReviews.forEach(r => {
    byChannel[r.channel] = (byChannel[r.channel] || 0) + 1;
  });
  const channelSummary = Object.entries(byChannel)
    .map(([ch, cnt]) => `${ch} ${cnt}건`)
    .join(', ');

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🚨 부정리뷰 ${negativeReviews.length}건 감지`, emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `새로 수집된 부정리뷰가 있습니다.\n*채널별:* ${channelSummary}`,
      },
    },
    { type: 'divider' },
  ];

  // 최대 10건까지 상세 표시
  const showReviews = negativeReviews.slice(0, 10);
  showReviews.forEach((review, i) => {
    const stars = '★'.repeat(review.score || 1) + '☆'.repeat(5 - (review.score || 1));
    const channelEmoji = {
      '카페24': '🛒', '스마트스토어': '🟢', '올리브영': '💜',
    }[review.channel] || '📝';

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${i + 1}. ${channelEmoji} ${review.channel}* | ${stars} | ${review.product || '미확인'}\n> ${(review.text || '').slice(0, 150)}${(review.text || '').length > 150 ? '...' : ''}`,
      },
    });
  });

  if (negativeReviews.length > 10) {
    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `...외 ${negativeReviews.length - 10}건 더 있음` },
      ],
    });
  }

  return blocks;
}

/**
 * 메인: 부정리뷰 배열을 받아 슬랙 DM 전송
 * @param {Array} negativeReviews - is_negative가 true인 리뷰 배열
 * @returns {Promise<number>} 전송된 리뷰 수
 */
async function notifyNegativeReviews(negativeReviews) {
  if (!SLACK_BOT_TOKEN) {
    console.log('[슬랙 알림] SLACK_BOT_TOKEN 미설정, 알림 건너뜀');
    return 0;
  }
  if (!negativeReviews || negativeReviews.length === 0) {
    console.log('[슬랙 알림] 부정리뷰 없음, 알림 건너뜀');
    return 0;
  }

  try {
    // 1) 사용자 ID 확인
    let userId = SLACK_USER_ID;
    if (!userId && SLACK_USER_EMAIL) {
      userId = await findUserByEmail(SLACK_USER_EMAIL);
      console.log(`[슬랙 알림] 사용자 찾음: ${userId}`);
    }
    if (!userId) {
      console.log('[슬랙 알림] SLACK_USER_ID 또는 SLACK_USER_EMAIL 필요');
      return 0;
    }

    // 2) DM 채널 열기
    const channelId = await openDM(userId);

    // 3) 요약 메시지 전송
    const blocks = buildSummaryBlocks(negativeReviews);
    const plainText = `🚨 부정리뷰 ${negativeReviews.length}건이 감지되었습니다.`;

    await sendMessage(channelId, blocks, plainText);
    console.log(`[슬랙 알림] 부정리뷰 ${negativeReviews.length}건 DM 전송 완료`);

    return negativeReviews.length;
  } catch(e) {
    console.error(`[슬랙 알림 오류] ${e.message}`);
    return 0;
  }
}

// 모듈로 사용 가능 + 직접 실행도 가능
module.exports = { notifyNegativeReviews };

// 직접 실행 시 테스트
if (require.main === module) {
  const testReview = {
    id: 'TEST001',
    date: new Date().toISOString().slice(0, 10),
    channel: '카페24',
    product: 'EGA 에센셜 핸드크림',
    text: '향이 별로예요. 기대했는데 실망입니다.',
    score: 2,
    reviewer: '테스트',
    is_negative: true,
    sentiment: '부정',
  };

  notifyNegativeReviews([testReview])
    .then(count => console.log(`테스트 완료: ${count}건 전송`))
    .catch(e => console.error('테스트 실패:', e));
}
