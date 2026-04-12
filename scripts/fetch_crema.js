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

async function fetchProductMap(token) {
  console.log('📦 상품 목록 수집 중...');
  const productMap = {};
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

async function fetchAllReviews(token) {
  // ── 전체 리뷰 수집 (날짜 제한 없음, 페이지 무제한) ──
  console.log('📥 크리마 전체 리뷰 수집 중... (날짜 제한 없음)');

  let allReviews = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const res = await request({
      hostname: 'api.cre.ma',
      path: `/v1/reviews?access_token=${token}&limit=100&page=${page}&date_order_desc=1`,
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

      // API 부하 방지: 페이지마다 0.3초 대기
      await new Promise(r => setTimeout(r, 300));
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
  const n = name.toLowerCase();
  if (n.includes('healer')) return '앰플';
  if (n.match(/kit|마스크팩|겔마스크|지우개팩/)) return '마스크팩';
  if (n.match(/인앤아웃|손티에이징|어워즈/)) return '핸드크림 세트';
  if (n.match(/essential|에센셜/)) return '에센셜 핸드크림';
  if (n.match(/advanced|어드밴스드/)) return '어드밴스드 핸드크림';
  if (n.match(/nmn daily routine|스킨 부스터|스킨부스터|daily regenerator|nmn 스킨|regenerator/)) return 'NMN';
  if (n.match(/앰플/)) return '앰플';
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

  // ALL_REVIEWS 블록을 괄호 깊이로 정확하게 찾기
  const startMarker = 'const ALL_REVIEWS = ';
  const startIdx = html.indexOf(startMarker) + startMarker.length;

  let depth = 0;
  let inString = false;
  let i = startIdx;
  while (i < html.length) {
    const c = html[i];
    if (c === '\\' && inString) { i += 2; continue; }
    if (c === '"') inString = !inString;
    else if (!inString) {
      if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) { i++; break; } }
    }
    i++;
  }
  const endIdx = i;

  // 기존 데이터 파싱
  const existingJson = html.slice(startIdx, endIdx);
  let existing = [];
  try {
    existing = JSON.parse(existingJson);
  } catch(e) {
    console.warn('⚠️ 기존 데이터 파싱 실패, 새 데이터만 사용');
  }

  // 크리마 데이터 제외한 기존 수동 데이터 보존
  const nonCRM = existing.filter(r => !String(r.id).startsWith('CRM'));
  console.log(`  기존 수동 리뷰 보존: ${nonCRM.length}개`);
  console.log(`  새 크리마 리뷰: ${newReviews.length}개`);

  // 병합 후 날짜순 정렬
  const merged = [...newReviews, ...nonCRM]
    .sort((a, b) => b.date.localeCompare(a.date));
  const totalCount = merged.length;

  // JSON 직렬화 (개행 없이 안전하게)
  const newJson = JSON.stringify(merged, null, 0);

  // HTML에 삽입
  html = html.slice(0, startIdx) + newJson + html.slice(endIdx);

  // 뱃지 숫자 업데이트
  html = html.replace(/(<span class="nav-badge">)\d+(<\/span>)/g, `$1${totalCount}$2`);
  html = html.replace(/(<div class="nav-badge">)\d+(<\/div>)/g, `$1${totalCount}$2`);

  fs.writeFileSync('index.html', html, 'utf8');
  console.log(`✅ 총 ${totalCount}개로 업데이트 완료`);
}

async function main() {
  try {
    console.log('🚀 크리마 전체 리뷰 수집 시작\n');
    const token = await getAccessToken();

    const productMap = await fetchProductMap(token);
    const raw = await fetchAllReviews(token);
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
