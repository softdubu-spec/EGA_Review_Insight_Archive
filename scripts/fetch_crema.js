// 크리마 리뷰 자동 수집 스크립트
// GitHub Actions에서 실행됨

const https = require('https');
const fs = require('fs');

const APP_ID = process.env.CREMA_APP_ID;
const SECRET = process.env.CREMA_SECRET;

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
  if (!res.body.access_token) throw new Error('토큰 발급 실패: ' + JSON.stringify(res.body));
  console.log('✅ Access Token 발급 완료');
  return res.body.access_token;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

// 2단계: 리뷰 수집 (최근 45일)
async function fetchReviews(token) {
  console.log('📥 크리마 리뷰 수집 중...');
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 45);
  const startStr = formatDate(start);
  const endStr = formatDate(end);
  console.log(`  수집 기간: ${startStr} ~ ${endStr}`);

  let allReviews = [];
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= 30) {
    const path = `/v1/reviews?access_token=${token}&limit=100&page=${page}&date_order_desc=1&start_date=${startStr}&end_date=${endStr}`;
    const res = await request({
      hostname: 'api.cre.ma',
      path: path,
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    const data = res.body;
    if (!Array.isArray(data) || data.length === 0) {
      hasMore = false;
    } else {
      allReviews = allReviews.concat(data);
      console.log(`  페이지 ${page}: ${data.length}개 (누적: ${allReviews.length}개)`);
      if (data.length < 100) hasMore = false;
      page++;
    }
  }
  console.log(`✅ 총 ${allReviews.length}개 수집 완료`);
  return allReviews;
}

// 3단계: 채널 파악 (본문 끝에 채널 정보 포함됨)
function parseChannel(message) {
  if (!message) return '카페24';
  if (message.includes('스마트스토어에서 작성된 구매평')) return '스마트스토어';
  if (message.includes('올리브영에서 작성된 구매평')) return '올리브영';
  if (message.includes('네이버 페이 구매평')) return '스마트스토어';
  return '카페24';
}

// 채널 태그 제거해서 순수 본문만 추출
function cleanMessage(message) {
  if (!message) return '';
  return message
    .replace(/\n+스마트스토어에서 작성된 구매평$/, '')
    .replace(/\n+올리브영에서 작성된 구매평$/, '')
    .replace(/\n+네이버 페이 구매평$/, '')
    .replace(/\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 에 등록된 네이버 페이 구매평\)$/, '')
    .trim();
}

// 4단계: 상품명 → product_category 매핑
function getProductCategory(productName) {
  if (!productName) return '기타';
  const p = productName;
  if (p.includes('NMN Daily Routine') || p.includes('스킨 부스터') || p.includes('NMN Daily Regenerator') || p.includes('Regenerator')) return 'NMN';
  if (p.includes('White repair') || p.includes('마스크') || p.includes('팩') || p.includes('지우개팩')) return '마스크팩';
  if (p.includes('에센셜') || p.includes('Essential')) return '에센셜';
  if (p.includes('어드밴스드') || p.includes('Advanced') || p.includes('SPF')) return '어드밴스드';
  if (p.includes('핸드크림') || p.includes('인앤아웃') || p.includes('손티에이징')) return '핸드크림 세트';
  if (p.includes('앰플') || p.includes('UV Healer')) return '앰플';
  return '기타';
}

// 5단계: 키워드 자동 추출
function extractKeywords(text) {
  const keywordMap = {
    '흡수 빠름': ['흡수','스며','잔여감 없'],
    '끈적임 없음': ['끈적','찝찝','미끌'],
    '보습력': ['촉촉','보습','수분'],
    '향기': ['향기','향이','향이 좋'],
    '무향': ['무향','향 없','향이 없'],
    '가격 언급': ['비싸','가격','할인'],
    '재구매 의향': ['재구매','또 살','다시 살','쟁여'],
    '효과 체감': ['효과','달라졌','좋아진','체감'],
    '피부 개선': ['피부','광','뽀얗','탄력','촉촉해'],
    '배송 관련': ['배송','빠른배송','택배'],
    '선물용': ['선물','드렸'],
    '꾸준한 복용': ['꾸준히','매일','챙겨'],
    '만족': ['만족','좋아요','좋습니다'],
  };
  const keywords = [];
  for (const [kw, patterns] of Object.entries(keywordMap)) {
    if (patterns.some(p => text.includes(p))) keywords.push(kw);
  }
  return keywords;
}

// 6단계: 감정 분류
function getSentiment(text, score) {
  const negWords = ['불만','별로','최악','실망','환불','불편','아쉽','나쁨','안됨','최하','별점1','별점2'];
  const posWords = ['좋아','최고','만족','추천','재구매','완벽','훌륭','감사','사랑','굿','대박'];
  const isNeg = negWords.some(w => text.includes(w)) || score <= 2;
  const isPos = posWords.some(w => text.includes(w)) || score >= 4;
  if (isNeg) return '부정';
  if (isPos) return '긍정';
  return '혼합';
}

// 7단계: 크리마 데이터 → EGA 형식 변환
function convertReview(r) {
  const rawText = r.message || '';
  const channel = parseChannel(rawText);
  const text = cleanMessage(rawText);
  const score = r.score || 5;
  const sentiment = getSentiment(text, score);
  const isNeg = sentiment === '부정';
  const keywords = extractKeywords(text);

  // 제품명: crema API는 product_name 없음 → product_code로 매핑 필요
  // 단, 리뷰 본문에서 추출하거나 product_code 사용
  const productName = r.product_name || `상품코드 ${r.product_code}`;
  const productCategory = getProductCategory(productName);

  return {
    id: `CRM${r.id}`,
    date: r.created_at ? r.created_at.slice(0, 10) : new Date().toISOString().slice(0, 10),
    channel: channel,
    product: productName,
    category: '리뷰',
    text: text,
    memo: `크리마 수집 (id=${r.id}, code=${r.code})`,
    reviewer: r.user_name || '익명',
    sentiment: sentiment,
    sentiment_score: score >= 4 ? 80 : score >= 3 ? 55 : 25,
    keywords: keywords,
    has_repurchase: text.includes('재구매') || text.includes('또 살') || text.includes('쟁여'),
    is_negative: isNeg,
    issue_flag: isNeg && score <= 2,
    product_norm: productName,
    product_category: productCategory
  };
}

// 8단계: HTML 업데이트 (리뷰 데이터 + 사이드바 숫자)
function updateHTML(newReviews) {
  console.log('📝 HTML 파일 업데이트 중...');
  let html = fs.readFileSync('index.html', 'utf8');

  // ALL_REVIEWS 업데이트
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
  const totalCount = merged.length;

  // ALL_REVIEWS 교체
  html = html.replace(/const ALL_REVIEWS = \[[\s\S]*?\];/, `const ALL_REVIEWS = ${JSON.stringify(merged)};`);

  // 사이드바 숫자 업데이트 (nav-badge 안의 숫자)
  html = html.replace(
    /(<div class="nav-badge">)\d+(<\/div>)/g,
    `$1${totalCount}$2`
  );

  // Admin 데이터 현황 숫자 업데이트
  html = html.replace(
    /(<div class="kpi-value" style="font-size:22px">)\d+(<\/div>\s*<div class="kpi-sub">2025)/,
    `$1${totalCount}$2`
  );

  fs.writeFileSync('index.html', html, 'utf8');
  console.log(`✅ ${toAdd.length}개 신규 리뷰 추가 완료 (총 ${totalCount}개)`);
  return toAdd.length;
}

// 메인
async function main() {
  try {
    console.log('🚀 크리마 리뷰 자동 수집 시작\n');
    const token = await getAccessToken();
    const raw = await fetchReviews(token);
    const converted = raw.map(convertReview);

    // 채널 분포 로그
    const chCount = {};
    converted.forEach(r => { chCount[r.channel] = (chCount[r.channel] || 0) + 1; });
    console.log('📊 채널 분포:', JSON.stringify(chCount));

    const added = updateHTML(converted);
    console.log(`\n🎉 완료! ${added}개 신규 리뷰 추가됐습니다.`);
  } catch(e) {
    console.error('❌ 오류:', e.message);
    process.exit(1);
  }
}

main();
