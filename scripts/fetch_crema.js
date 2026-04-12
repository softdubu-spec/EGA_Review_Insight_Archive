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

// 상품 목록 전체 가져오기 (product_code → product_name 매핑)
async function fetchProductMap(token) {
  console.log('📦 상품 목록 수집 중...');
  const productMap = {}; // product_code → name
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= 50) {
    const res = await request({
      hostname: 'api.cre.ma',
      path: `/v1/products?access_token=${token}&limit=100&page=${page}`,
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    const data = res.body;
    if (!Array.isArray(data) || data.length === 0) {
      hasMore = false;
    } else {
      data.forEach(p => {
        if (p.code) productMap[String(p.code)] = p.name;
        if (p.id) productMap[String(p.id)] = p.name;
      });
      console.log(`  상품 페이지 ${page}: ${data.length}개 (누적: ${Object.keys(productMap).length}개)`);
      if (data.length < 100) hasMore = false;
      page++;
    }
  }
  console.log(`✅ 총 ${Object.keys(productMap).length}개 상품 매핑 완료`);
  return productMap;
}

async function fetchReviews(token) {
  console.log('📥 크리마 리뷰 수집 중...');
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 45);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);
  console.log(`  수집 기간: ${startStr} ~ ${endStr}`);

  let allReviews = [];
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= 30) {
    const res = await request({
      hostname: 'api.cre.ma',
      path: `/v1/reviews?access_token=${token}&limit=100&page=${page}&date_order_desc=1&start_date=${startStr}&end_date=${endStr}`,
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
  console.log(`✅ 총 ${allReviews.length}개 리뷰 수집 완료`);
  return allReviews;
}

function parseChannel(message) {
  if (!message) return '카페24';
  if (message.includes('스마트스토어에서 작성된 구매평')) return '스마트스토어';
  if (message.includes('올리브영에서 작성된 구매평')) return '올리브영';
  if (message.includes('네이버 페이 구매평')) return '스마트스토어';
  return '카페24';
}

function cleanMessage(message) {
  if (!message) return '';
  return message
    .replace(/\n+스마트스토어에서 작성된 구매평\s*$/, '')
    .replace(/\n+올리브영에서 작성된 구매평\s*$/, '')
    .replace(/\n+네이버 페이 구매평\s*$/, '')
    .replace(/\s*\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 에 등록된 네이버 페이 구매평\)\s*$/, '')
    .trim();
}

function getProductCategory(name) {
  if (!name) return '기타';
  if (name.match(/NMN Daily Routine|스킨 부스터|Daily Regenerator|NMN 스킨/)) return 'NMN';
  if (name.match(/White repair|마스크|팩|지우개팩/)) return '마스크팩';
  if (name.match(/에센셜|Essential/)) return '에센셜';
  if (name.match(/어드밴스드|Advanced|SPF/)) return '어드밴스드';
  if (name.match(/핸드크림|인앤아웃|손티에이징/)) return '핸드크림 세트';
  if (name.match(/앰플|UV Healer/)) return '앰플';
  return '기타';
}

function extractKeywords(text) {
  const map = {
    '흡수 빠름': ['흡수','스며','잔여감 없'],
    '끈적임 없음': ['끈적','찝찝','미끌'],
    '보습력': ['촉촉','보습','수분'],
    '향기': ['향기','향이 좋','좋은 향'],
    '무향': ['무향','향 없','향이 없'],
    '가격 언급': ['비싸','가격','할인'],
    '재구매 의향': ['재구매','또 살','쟁여'],
    '효과 체감': ['효과','달라','좋아진','체감'],
    '피부 개선': ['피부','광','뽀얗','탄력'],
    '배송 관련': ['배송','택배'],
    '선물용': ['선물','드렸'],
    '꾸준한 복용': ['꾸준히','매일 먹','챙겨 먹'],
    '만족': ['만족합니다','만족해요','좋아요'],
  };
  const keywords = [];
  for (const [kw, patterns] of Object.entries(map)) {
    if (patterns.some(p => text.includes(p))) keywords.push(kw);
  }
  return keywords;
}

function getSentiment(text, score) {
  const neg = ['불만','별로','최악','실망','환불','불편','아쉽','나쁨'];
  const pos = ['좋아','최고','만족','추천','재구매','완벽','훌륭','감사','대박'];
  if (neg.some(w => text.includes(w)) || score <= 2) return '부정';
  if (pos.some(w => text.includes(w)) || score >= 4) return '긍정';
  return '혼합';
}

function convertReview(r, productMap) {
  const rawText = r.message || '';
  const channel = parseChannel(rawText);
  const text = cleanMessage(rawText);
  const score = r.score || 5;
  const sentiment = getSentiment(text, score);
  const isNeg = sentiment === '부정';
  const keywords = extractKeywords(text);

  // product_code로 상품명 조회
  const productCode = String(r.product_code || '');
  const productId = String(r.product_id || '');
  const productName = productMap[productCode] || productMap[productId] || r.product_name || '';
  const productCategory = getProductCategory(productName);

  return {
    id: `CRM${r.id}`,
    date: r.created_at ? r.created_at.slice(0, 10) : new Date().toISOString().slice(0, 10),
    channel,
    product: productName,
    category: '리뷰',
    text,
    memo: `크리마 수집 (id=${r.id})`,
    reviewer: r.user_name || '익명',
    sentiment,
    sentiment_score: score >= 4 ? 80 : score >= 3 ? 55 : 25,
    keywords,
    has_repurchase: text.includes('재구매') || text.includes('또 살') || text.includes('쟁여'),
    is_negative: isNeg,
    issue_flag: isNeg && score <= 2,
    product_norm: productName,
    product_category: productCategory
  };
}

function updateHTML(newReviews) {
  console.log('📝 HTML 파일 업데이트 중...');
  let html = fs.readFileSync('index.html', 'utf8');

  const match = html.match(/const ALL_REVIEWS = (\[[\s\S]*?\]);/);
  if (!match) throw new Error('ALL_REVIEWS를 찾을 수 없습니다.');

  let existing = JSON.parse(match[1]);
  const nonCRM = existing.filter(r => !r.id.startsWith('CRM'));
  console.log(`  기존 비-크리마 리뷰: ${nonCRM.length}개`);
  console.log(`  새 크리마 리뷰: ${newReviews.length}개`);

  const merged = [...newReviews, ...nonCRM].sort((a, b) => b.date.localeCompare(a.date));
  const totalCount = merged.length;

  html = html.replace(/const ALL_REVIEWS = \[[\s\S]*?\];/, `const ALL_REVIEWS = ${JSON.stringify(merged)};`);
  html = html.replace(/(<span class="nav-badge">)\d+(<\/span>)/g, `$1${totalCount}$2`);
  html = html.replace(/(<div class="nav-badge">)\d+(<\/div>)/g, `$1${totalCount}$2`);

  fs.writeFileSync('index.html', html, 'utf8');
  console.log(`✅ 총 ${totalCount}개로 업데이트 완료`);
}

async function main() {
  try {
    console.log('🚀 크리마 리뷰 자동 수집 시작\n');
    const token = await getAccessToken();

    // 상품 목록 먼저 가져오기
    const productMap = await fetchProductMap(token);

    // 리뷰 수집
    const raw = await fetchReviews(token);
    const converted = raw.map(r => convertReview(r, productMap));

    // 분포 확인
    const chCount = {};
    converted.forEach(r => { chCount[r.channel] = (chCount[r.channel] || 0) + 1; });
    console.log('📊 채널 분포:', JSON.stringify(chCount));

    const catCount = {};
    converted.forEach(r => { catCount[r.product_category] = (catCount[r.product_category] || 0) + 1; });
    console.log('📦 제품 분포:', JSON.stringify(catCount));

    updateHTML(converted);
    console.log('\n🎉 완료!');
  } catch(e) {
    console.error('❌ 오류:', e.message);
    process.exit(1);
  }
}

main();
