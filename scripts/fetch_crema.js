// 크리마 리뷰 자동 수집 스크립트
// GitHub Actions에서 실행됨

const https = require('https');
const fs = require('fs');

const APP_ID = process.env.CREMA_APP_ID;
const SECRET = process.env.CREMA_SECRET;

// HTTP 요청 헬퍼
function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ body: JSON.parse(data), headers: res.headers }); }
        catch(e) { resolve({ body: data, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// 1단계: Access Token 발급
async function getAccessToken() {
  console.log('🔑 Access Token 발급 중...');
  const body = `grant_type=client_credentials&client_id=${APP_ID}&client_secret=${SECRET}`;

  const res = await request({
    hostname: 'api.cre.ma',
    path: '/oauth/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);

  if (!res.body.access_token) {
    throw new Error('토큰 발급 실패: ' + JSON.stringify(res.body));
  }

  console.log('✅ Access Token 발급 완료');
  return res.body.access_token;
}

// 날짜 포맷 yyyy-mm-dd
function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

// 2단계: 리뷰 목록 수집 (전체 기간, 페이지 순회)
async function fetchReviews(token) {
  console.log('📥 크리마 리뷰 수집 중...');

  let allReviews = [];

  // 먼저 overview로 첫 리뷰 날짜 확인
  const overview = await request({
    hostname: 'api.cre.ma',
    path: `/v1/reviews/overview?access_token=${token}`,
    method: 'GET',
    headers: { 'Accept': 'application/json' }
  });

  console.log('  Overview:', JSON.stringify(overview.body));

  // 최근 45일씩 나눠서 수집 (API 최대 45일 제한)
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 45);

  const start = formatDate(startDate);
  const end = formatDate(endDate);

  console.log(`  수집 기간: ${start} ~ ${end}`);

  let page = 1;
  let hasMore = true;

  while (hasMore && page <= 30) {
    const path = `/v1/reviews?access_token=${token}&limit=100&page=${page}&date_order_desc=1&start_date=${start}&end_date=${end}`;

    console.log(`  요청: 페이지 ${page}`);

    const res = await request({
      hostname: 'api.cre.ma',
      path: path,
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    const data = res.body;

    if (!Array.isArray(data) || data.length === 0) {
      console.log(`  페이지 ${page}: 데이터 없음 → 종료`);
      hasMore = false;
    } else {
      allReviews = allReviews.concat(data);
      console.log(`  페이지 ${page}: ${data.length}개 수집 (누적: ${allReviews.length}개)`);
      if (data.length < 100) hasMore = false;
      page++;
    }
  }

  console.log(`✅ 총 ${allReviews.length}개 리뷰 수집 완료`);
  return allReviews;
}

// 3단계: 크리마 리뷰 → EGA 형식 변환
function convertReview(r) {
  const text = r.message || '';
  const score = r.score || 5;

  const negWords = ['불만','별로','최악','실망','환불','불편','아쉽','나쁨','안됨'];
  const posWords = ['좋아','최고','만족','추천','재구매','완벽','훌륭','감사','사랑','굿'];
  const isNeg = negWords.some(w => text.includes(w)) || score <= 2;
  const isPos = posWords.some(w => text.includes(w)) || score >= 4;
  const sentiment = isNeg ? '부정' : isPos ? '긍정' : '혼합';

  const keywordMap = {
    '흡수 빠름': ['흡수','스며','잔여감'],
    '끈적임 없음': ['끈적','찝찝','미끌'],
    '보습력': ['촉촉','보습','수분'],
    '향기': ['향','냄새'],
    '무향': ['무향','향없'],
    '가격 언급': ['비싸','가격','비용'],
    '재구매 의향': ['재구매','또사','다시살'],
    '효과 체감': ['효과','달라','좋아진'],
    '피부 개선': ['피부','광','뽀얗','탄력'],
    '배송 관련': ['배송','빠른배송','택배'],
    '선물용': ['선물','드렸'],
  };

  const keywords = [];
  for (const [kw, patterns] of Object.entries(keywordMap)) {
    if (patterns.some(p => text.includes(p))) keywords.push(kw);
  }

  const productName = r.product_name || '';
  let category = '기타';
  if (productName.includes('NMN') || productName.includes('스킨부스터')) category = 'NMN';
  else if (productName.includes('팩') || productName.includes('마스크')) category = '마스크팩';
  else if (productName.includes('핸드') || productName.includes('크림')) category = '핸드크림 세트';
  else if (productName.includes('에센셜')) category = '에센셜';

  return {
    id: `CRM${r.id}`,
    date: r.created_at ? r.created_at.slice(0, 10) : new Date().toISOString().slice(0, 10),
    channel: '카페24',
    product: productName,
    category: '리뷰',
    text: text,
    memo: `크리마 API 수집 (id=${r.id})`,
    reviewer: r.user_name || '익명',
    sentiment: sentiment,
    sentiment_score: score >= 4 ? 80 : score >= 3 ? 55 : 25,
    keywords: keywords,
    has_repurchase: text.includes('재구매') || text.includes('또 살'),
    is_negative: isNeg,
    issue_flag: isNeg && score <= 2,
    product_norm: productName,
    product_category: category
  };
}

// 4단계: HTML 파일에 새 리뷰 추가
function updateHTML(newReviews) {
  console.log('📝 HTML 파일 업데이트 중...');

  let html = fs.readFileSync('index.html', 'utf8');

  const match = html.match(/const ALL_REVIEWS = (\[[\s\S]*?\]);/);
  if (!match) throw new Error('ALL_REVIEWS를 찾을 수 없습니다.');

  let existing = JSON.parse(match[1]);
  const existingIds = new Set(existing.map(r => r.id));

  const toAdd = newReviews.filter(r => !existingIds.has(r.id));
  console.log(`  기존: ${existing.length}개, 신규: ${toAdd.length}개`);

  if (toAdd.length === 0) {
    console.log('✅ 추가할 신규 리뷰 없음');
    return 0;
  }

  const merged = [...toAdd, ...existing].sort((a, b) => b.date.localeCompare(a.date));
  const newArrayStr = JSON.stringify(merged);
  html = html.replace(/const ALL_REVIEWS = \[[\s\S]*?\];/, `const ALL_REVIEWS = ${newArrayStr};`);

  fs.writeFileSync('index.html', html, 'utf8');
  console.log(`✅ ${toAdd.length}개 신규 리뷰 추가 완료`);
  return toAdd.length;
}

// 메인 실행
async function main() {
  try {
    console.log('🚀 크리마 리뷰 자동 수집 시작\n');

    const token = await getAccessToken();
    const raw = await fetchReviews(token);
    const converted = raw.map(convertReview);
    const added = updateHTML(converted);

    console.log(`\n🎉 완료! ${added}개 신규 리뷰가 대시보드에 추가됐습니다.`);
  } catch(e) {
    console.error('❌ 오류:', e.message);
    process.exit(1);
  }
}

main();
