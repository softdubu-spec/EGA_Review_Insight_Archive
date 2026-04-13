const https = require('https');
const http = require('http');
const fs = require('fs');
const { notifyNegativeReviews } = require('./slack_notify');

// EGA 올리브영 상품 목록 (브랜드 페이지에서 확인)
const BRAND_URL = 'https://www.oliveyoung.co.kr/store/display/getBrandShopDetail.do?onlBrndCd=A016175';

function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, {
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Referer': 'https://www.oliveyoung.co.kr/',
        ...(options.headers || {}),
      }
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location, options).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ body: data, statusCode: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function getProductNumbers() {
  console.log('=== 올리브영 EGA 브랜드 상품 조회 ===');
  try {
    const res = await fetch(BRAND_URL);
    // goodsNo 추출 (상품 링크에서)
    const goodsNos = new Set();
    const regex = /goodsNo=([A-Z0-9]+)/g;
    let match;
    while ((match = regex.exec(res.body)) !== null) {
      goodsNos.add(match[1]);
    }

    // 상품명도 추출 시도
    const products = [];
    const prodRegex = /goods_unit[\s\S]*?goodsNo=([A-Z0-9]+)[\s\S]*?<p class="tx_name"[^>]*>([\s\S]*?)<\/p>/g;
    while ((match = prodRegex.exec(res.body)) !== null) {
      products.push({ goodsNo: match[1], name: match[2].replace(/<[^>]+>/g, '').trim() });
    }

    if (products.length > 0) {
      console.log(`  상품 ${products.length}개 발견:`);
      products.forEach(p => console.log(`    ${p.goodsNo}: ${p.name}`));
      return products;
    }

    // 폴백: goodsNo만 있는 경우
    if (goodsNos.size > 0) {
      console.log(`  상품번호 ${goodsNos.size}개 발견: ${[...goodsNos].join(', ')}`);
      return [...goodsNos].map(no => ({ goodsNo: no, name: '' }));
    }

    console.log('  [경고] 상품을 찾을 수 없음, 하드코딩된 목록 사용');
    return null;
  } catch(e) {
    console.log(`  [오류] 브랜드 페이지 접근 실패: ${e.message}`);
    return null;
  }
}

// 올리브영 리뷰 목록 API
async function fetchReviewPage(goodsNo, page) {
  const url = `https://www.oliveyoung.co.kr/store/goods/getGdasNewList.do?goodsNo=${goodsNo}&pageIdx=${page}&sortType=NEW&pageSize=10`;

  try {
    const res = await fetch(url, {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'text/html, */*; q=0.01',
      }
    });
    return res.body;
  } catch(e) {
    console.error(`  [오류] 리뷰 페이지 ${page} 요청 실패: ${e.message}`);
    return '';
  }
}

function parseReviews(html, goodsNo, productName) {
  const reviews = [];

  // 리뷰 블록 분리 (각 리뷰는 review_cont 클래스로 구분)
  const blocks = html.split(/review_cont|gdasRevw/);

  for (const block of blocks) {
    // 별점 추출
    const scoreMatch = block.match(/score_area[\s\S]*?(\d)점/);
    const score = scoreMatch ? parseInt(scoreMatch[1]) : null;

    // 날짜 추출
    const dateMatch = block.match(/(\d{4})[\.\-\/](\d{2})[\.\-\/](\d{2})/);
    const date = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : null;

    // 닉네임 추출
    const nickMatch = block.match(/nickname[^>]*>([^<]+)</i) || block.match(/id_area[^>]*>([^<]+)</i) || block.match(/user[^>]*>([^<]+)</i);
    const reviewer = nickMatch ? nickMatch[1].trim() : '';

    // 리뷰 텍스트 추출
    const textMatch = block.match(/txt_inner[^>]*>([\s\S]*?)<\/p>/i) ||
                       block.match(/review_cont[^>]*>([\s\S]*?)<\/div>/i) ||
                       block.match(/txt_contents[^>]*>([\s\S]*?)<\/p>/i);
    let text = textMatch ? textMatch[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : '';

    if (!text || text.length < 2 || !date) continue;

    reviews.push({
      goodsNo,
      productName,
      score: score || 5,
      date,
      reviewer,
      text,
    });
  }

  return reviews;
}

// 대안: JSON API 시도
async function fetchReviewsJSON(goodsNo, page) {
  const url = `https://www.oliveyoung.co.kr/store/goods/getGdasNewListJson.do?goodsNo=${goodsNo}&pageIdx=${page}&sortType=NEW&pageSize=10`;
  try {
    const res = await fetch(url, {
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json',
      }
    });
    try {
      return JSON.parse(res.body);
    } catch(e) {
      return null;
    }
  } catch(e) {
    return null;
  }
}

async function fetchAllReviewsForProduct(goodsNo, productName) {
  console.log(`\n  [${productName || goodsNo}] 리뷰 수집 시작...`);

  let allReviews = [];
  let page = 1;
  let emptyCount = 0;
  const MAX_PAGES = 200;

  while (page <= MAX_PAGES && emptyCount < 3) {
    const html = await fetchReviewPage(goodsNo, page);

    if (!html || html.trim().length < 50) {
      emptyCount++;
      if (emptyCount >= 3) break;
      page++;
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    const reviews = parseReviews(html, goodsNo, productName);

    if (reviews.length === 0) {
      emptyCount++;
      if (emptyCount >= 3) break;
    } else {
      emptyCount = 0;
      allReviews = allReviews.concat(reviews);
    }

    if (page % 10 === 0 || page <= 3) {
      console.log(`    페이지 ${page}: ${reviews.length}개 (누적: ${allReviews.length}개)`);
    }

    page++;
    // 올리브영 rate limit 대응
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`    총 ${allReviews.length}개 수집 완료`);
  return allReviews;
}

function getProductCategory(name) {
  if (!name) return '기타';
  const n = name.toLowerCase();
  if (n.match(/에센셜.*리제너레이터|리제너레이터.*에센셜/)) return '에센셜 핸드크림';
  if (n.match(/어드밴스드/)) return '어드밴스드 핸드크림';
  if (n.match(/에센셜/)) return '에센셜 핸드크림';
  if (n.match(/인앤아웃|손티에이징|어워즈/)) return '핸드크림 세트';
  if (n.match(/리제너레이터/)) return '에센셜 핸드크림';
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
    '재구매 의향': ['재구매','또 살','쟁여','또 구매','재주문'],
    '효과 체감': ['효과','달라','좋아진','체감'],
    '피부 개선': ['피부','광','뽀얗','탄력'],
    '배송 관련': ['배송','택배'],
    '선물용': ['선물','드렸'],
    '만족': ['만족합니다','만족해요','좋아요','좋습니다'],
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

function convertReview(r) {
  const text = r.text;
  const score = r.score;
  const sentiment = getSentiment(text, score);
  const keywords = extractKeywords(text);
  const isNeg = sentiment === '부정';
  const productCategory = getProductCategory(r.productName);

  return {
    id: `OLV${r.goodsNo}_${r.date.replace(/-/g,'')}_${Math.random().toString(36).substr(2,6)}`,
    date: r.date,
    channel: '올리브영',
    product: r.productName,
    category: '리뷰',
    text,
    memo: `올리브영 수집 (goodsNo=${r.goodsNo})`,
    reviewer: r.reviewer || '올리브영 구매자',
    sentiment,
    sentiment_score: score >= 4 ? 80 : score >= 3 ? 55 : 25,
    keywords,
    has_repurchase: text.includes('재구매') || text.includes('또 살') || text.includes('쟁여') || text.includes('또 구매'),
    is_negative: isNeg,
    issue_flag: isNeg && score <= 2,
    product_norm: r.productName,
    product_category: productCategory,
  };
}

function updateHTML(newReviews) {
  console.log('\n=== HTML 파일 업데이트 중... ===');
  let html = fs.readFileSync('index.html', 'utf8');

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

  const existingJson = html.slice(startIdx, endIdx);
  let existing = [];
  try {
    existing = JSON.parse(existingJson);
  } catch(e) {
    console.warn('  기존 데이터 파싱 실패');
    return;
  }

  // 기존 올리브영 리뷰의 텍스트+날짜 해시로 중복 체크
  const existingOlvTexts = new Set();
  existing.forEach(r => {
    if (String(r.id).startsWith('OLV') || (r.channel === '올리브영')) {
      existingOlvTexts.add(r.date + '|' + r.text.slice(0, 50));
    }
  });

  const brandNew = newReviews.filter(r => {
    const key = r.date + '|' + r.text.slice(0, 50);
    return !existingOlvTexts.has(key);
  });

  console.log(`  기존 전체 리뷰: ${existing.length}개`);
  console.log(`  올리브영 수집: ${newReviews.length}개`);
  console.log(`  이 중 신규: ${brandNew.length}개`);

  if (brandNew.length === 0) {
    console.log('  새 리뷰 없음, 업데이트 건너뜀');
    return;
  }

  const merged = [...existing, ...brandNew]
    .sort((a, b) => b.date.localeCompare(a.date));
  const totalCount = merged.length;

  const newJson = JSON.stringify(merged, null, 0);
  html = html.slice(0, startIdx) + newJson + html.slice(endIdx);

  html = html.replace(/(<span class="nav-badge">)\d+(<\/span>)/g, `$1${totalCount}$2`);
  html = html.replace(/(<div class="nav-badge">)\d+(<\/div>)/g, `$1${totalCount}$2`);

  fs.writeFileSync('index.html', html, 'utf8');
  console.log(`\n=== 총 ${totalCount}개로 업데이트 완료 ===`);
}

async function main() {
  try {
    console.log('========================================');
    console.log('  올리브영 EGA 리뷰 수집 시작');
    console.log('========================================\n');

    // 브랜드 페이지에서 상품 목록 가져오기
    let products = await getProductNumbers();

    if (!products || products.length === 0) {
      // 하드코딩 폴백 (2026년 4월 기준)
      console.log('  하드코딩된 상품 목록 사용');
      products = [
        { goodsNo: 'A000000224011', name: '에가 에센셜 리제너레이터 핸드크림 50ml 어워즈 한정기획' },
        { goodsNo: 'A000000215498', name: '[UV차단]에가 어드밴스드 핸드크림 30ml' },
        { goodsNo: 'A000000195498', name: '[손티에이징] 에가 에센셜 핸드크림 50ml' },
        { goodsNo: 'A000000215499', name: '[손티에이징] 에가 리제너레이터 핸드크림' },
      ];
    }

    let allRawReviews = [];
    for (const prod of products) {
      const reviews = await fetchAllReviewsForProduct(prod.goodsNo, prod.name);
      allRawReviews = allRawReviews.concat(reviews);
    }

    if (allRawReviews.length === 0) {
      console.log('\n[경고] 수집된 리뷰가 0개입니다.');
      console.log('올리브영 사이트 구조가 변경되었거나 접근이 차단되었을 수 있습니다.');
      return;
    }

    const converted = allRawReviews.map(r => convertReview(r));

    console.log(`\n=== 총 ${converted.length}개 올리브영 리뷰 변환 완료 ===`);

    const catCount = {};
    converted.forEach(r => { catCount[r.product_category] = (catCount[r.product_category] || 0) + 1; });
    console.log('제품 분포:', JSON.stringify(catCount));

    updateHTML(converted);

    // 부정리뷰 슬랙 DM 알림
    const negatives = converted.filter(r => r.is_negative);
    if (negatives.length > 0) {
      console.log(`\n=== 부정리뷰 ${negatives.length}건 → 슬랙 알림 전송 ===`);
      await notifyNegativeReviews(negatives);
    }

    console.log('\n========================================');
    console.log('  완료!');
    console.log('========================================');
  } catch(e) {
    console.error('[오류]', e.message);
    console.error(e.stack);
    process.exit(1);
  }
}

main();
