const https = require('https');
const fs = require('fs');
const { notifyNegativeReviews } = require('./slack_notify');

const APP_ID = process.env.CREMA_APP_ID;
const SECRET = process.env.CREMA_SECRET;
const HTML_PATH = process.env.HTML_PATH || 'index.html';

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            body: JSON.parse(data),
            headers: res.headers,
            statusCode: res.statusCode
          });
        } catch (e) {
          resolve({
            body: data,
            headers: res.headers,
            statusCode: res.statusCode
          });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseLinkHeader(linkHeader) {
  if (!linkHeader) return {};
  const links = {};
  linkHeader.split(',').forEach(part => {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) links[match[2]] = match[1];
  });
  return links;
}

function extractPath(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch (e) {
    return url;
  }
}

function uniq(arr) {
  return [...new Set(arr.filter(v => v !== undefined && v !== null && String(v).trim() !== ''))];
}

function safeString(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      return String(v).trim();
    }
  }
  return '';
}

function getNested(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object' || !(p in cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

async function getAccessToken() {
  console.log('=== Access Token 발급 중... ===');
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

  console.log('Access Token 발급 완료');
  return res.body.access_token;
}

function addProductMapEntry(productMap, key, name) {
  const k = safeString(key);
  const n = safeString(name);
  if (!k || !n) return;
  productMap[k] = n;
}

async function fetchProductMap(token) {
  console.log('\n=== 상품 목록 수집 중... ===');
  const productMap = {};
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= 100) {
    const res = await request({
      hostname: 'api.cre.ma',
      path: `/v1/products?access_token=${token}&limit=100&page=${page}`,
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    const data = res.body;
    let items = [];

    if (Array.isArray(data)) {
      items = data;
    } else if (data && typeof data === 'object') {
      items = data.products || data.data || data.items || [];
      if (!Array.isArray(items)) items = [];
    }

    if (items.length === 0) {
      hasMore = false;
    } else {
      items.forEach(p => {
        const name = firstNonEmpty(
          p.name,
          p.product_name,
          p.display_name,
          p.title
        );

        const candidateKeys = uniq([
          p.code,
          p.id,
          p.product_code,
          p.product_id,
          p.sub_product_code,
          p.sub_product_id,
          p.variant_code,
          p.variant_id,
          p.item_code,
          p.item_id,
          getNested(p, 'product.code'),
          getNested(p, 'product.id'),
          getNested(p, 'reviewable_product.code'),
          getNested(p, 'reviewable_product.id')
        ]);

        candidateKeys.forEach(key => addProductMapEntry(productMap, key, name));
      });

      console.log(`  상품 페이지 ${page}: ${items.length}개 (누적: ${Object.keys(productMap).length}개)`);

      const links = parseLinkHeader(res.headers['link']);
      if (links.next) {
        page++;
      } else if (items.length < 100) {
        hasMore = false;
      } else {
        page++;
      }
    }

    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`총 ${Object.keys(productMap).length}개 상품 매핑 완료\n`);
  return productMap;
}

async function fetchAllReviews(token) {
  console.log('=== 크리마 전체 리뷰 수집 시작 ===');
  console.log('(Link 헤더 기반 페이지네이션 + 폴백)');

  let allReviews = [];
  let page = 1;
  let hasMore = true;
  let nextPath = null;
  let emptyPageCount = 0;
  const MAX_EMPTY = 3;
  const MAX_PAGES = 200;

  while (hasMore && page <= MAX_PAGES) {
    const path = nextPath || `/v1/reviews?access_token=${token}&limit=100&page=${page}`;

    let res;
    try {
      res = await request({
        hostname: 'api.cre.ma',
        path,
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
    } catch (e) {
      console.error(`  [오류] 페이지 ${page} 요청 실패: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000));
      try {
        res = await request({
          hostname: 'api.cre.ma',
          path,
          method: 'GET',
          headers: { 'Accept': 'application/json' }
        });
      } catch (e2) {
        console.error(`  [오류] 재시도 실패: ${e2.message}, 수집 중단`);
        break;
      }
    }

    if (page === 1) {
      console.log(`  [디버그] 응답 상태: ${res.statusCode}`);
      console.log(`  [디버그] Link 헤더: ${res.headers['link'] || '없음'}`);
      console.log(`  [디버그] 응답 타입: ${typeof res.body}, isArray: ${Array.isArray(res.body)}`);
      if (typeof res.body === 'object' && !Array.isArray(res.body)) {
        console.log(`  [디버그] 응답 키: ${Object.keys(res.body).join(', ')}`);
      }
    }

    let reviews = [];
    const data = res.body;

    if (Array.isArray(data)) {
      reviews = data;
    } else if (data && typeof data === 'object') {
      reviews = data.reviews || data.data || data.items || [];
      if (!Array.isArray(reviews)) reviews = [];

      const total = data.total || data.total_count || data.count;
      if (total && page === 1) {
        console.log(`  [정보] API 보고 전체 리뷰 수: ${total}개`);
      }
    }

    if (page === 1 && reviews.length > 0) {
      console.log('  [샘플 리뷰 keys]', Object.keys(reviews[0]));
      try {
        console.log('  [샘플 리뷰 raw]', JSON.stringify(reviews[0], null, 2));
      } catch (e) {
        console.log('  [샘플 리뷰 raw] JSON stringify 실패');
      }
    }

    if (reviews.length === 0) {
      emptyPageCount++;
      console.log(`  페이지 ${page}: 빈 응답 (연속 ${emptyPageCount}회)`);
      if (emptyPageCount >= MAX_EMPTY) {
        console.log(`  연속 ${MAX_EMPTY}회 빈 응답, 수집 종료`);
        hasMore = false;
      } else {
        page++;
        nextPath = null;
        await new Promise(r => setTimeout(r, 500));
      }
      continue;
    }

    emptyPageCount = 0;
    allReviews = allReviews.concat(reviews);

    if (page % 10 === 0 || page <= 3) {
      console.log(`  페이지 ${page}: ${reviews.length}개 (누적: ${allReviews.length}개)`);
    }

    const links = parseLinkHeader(res.headers['link']);
    if (links.next) {
      let nextUrl = links.next;
      if (!nextUrl.includes('access_token')) {
        nextUrl += (nextUrl.includes('?') ? '&' : '?') + `access_token=${token}`;
      }
      nextPath = extractPath(nextUrl);
      page++;
    } else {
      if (reviews.length < 100) {
        console.log(`  페이지 ${page}: ${reviews.length}개 (100개 미만, 마지막 페이지)`);
        hasMore = false;
      } else {
        page++;
        nextPath = null;
      }
    }

    await new Promise(r => setTimeout(r, 300));
  }

  if (page > MAX_PAGES) {
    console.log(`  [경고] 최대 페이지(${MAX_PAGES}) 도달, 수집 중단`);
  }

  console.log(`\n=== 총 ${allReviews.length}개 리뷰 수집 완료 ===\n`);
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
  if (n.match(/kit|마스크팩|겔마스크|지우개팩|face&neck|face&amp;neck/)) return '마스크팩';
  if (n.match(/인앤아웃|손티에이징|어워즈/)) return '핸드크림 세트';
  if (n.match(/essential|에센셜/)) return '에센셜 핸드크림';
  if (n.match(/advanced|어드밴스드/)) return '어드밴스드 핸드크림';
  if (n.match(/nmn daily routine|스킨 부스터|스킨부스터|daily regenerator|nmn 스킨|regenerator|solution set/)) return 'NMN';
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
    '만족': ['만족합니다','만족해요','좋아요']
  };

  const keywords = [];
  for (const [kw, patterns] of Object.entries(map)) {
    if (patterns.some(p => text.includes(p))) keywords.push(kw);
  }
  return keywords;
}

function getSentiment(text, score) {
  const neg = ['불만','별로','최악','실망','환불','불편','아쉽','나쁨','비싸','모르겠','글쎄','애매','취향 아닌','안 맞','안맞','효과 없','효과없','그냥 그','그저 그','기대에 못','아쉬','후회'];
  const pos = ['좋아','최고','만족','추천','재구매','완벽','훌륭','감사','대박'];

  if (neg.some(w => text.includes(w)) || score <= 2) return '부정';
  if (score === 3 && !pos.some(w => text.includes(w))) return '부정';
  if (pos.some(w => text.includes(w)) || score >= 4) return '긍정';
  return '혼합';
}

function resolveProductInfo(r, productMap) {
  const candidateKeys = uniq([
    r.product_code,
    r.product_id,
    r.sub_product_code,
    r.sub_product_id,
    r.item_code,
    r.item_id,
    r.variant_code,
    r.variant_id,
    r.product_variant_id,

    getNested(r, 'product.code'),
    getNested(r, 'product.id'),
    getNested(r, 'product.product_code'),
    getNested(r, 'product.product_id'),

    getNested(r, 'reviewable_product.code'),
    getNested(r, 'reviewable_product.id'),
    getNested(r, 'reviewable_product.product_code'),
    getNested(r, 'reviewable_product.product_id'),

    getNested(r, 'sub_product.code'),
    getNested(r, 'sub_product.id'),
    getNested(r, 'review.product_code'),
    getNested(r, 'review.product_id')
  ]).map(String);

  const candidateNames = uniq([
    r.product_name,
    r.sub_product_name,
    r.item_name,
    r.option_name,
    getNested(r, 'product.name'),
    getNested(r, 'product.product_name'),
    getNested(r, 'reviewable_product.name'),
    getNested(r, 'reviewable_product.product_name'),
    getNested(r, 'sub_product.name'),
    getNested(r, 'review.product_name')
  ]).map(String);

  let productName = '';
  let matchedKey = '';

  for (const key of candidateKeys) {
    if (productMap[key]) {
      productName = productMap[key];
      matchedKey = key;
      break;
    }
  }

  if (!productName && candidateNames.length > 0) {
    productName = candidateNames[0];
  }

  const sku = firstNonEmpty(
    r.product_code,
    r.sub_product_code,
    r.item_code,
    r.variant_code,
    getNested(r, 'product.code'),
    getNested(r, 'reviewable_product.code'),
    getNested(r, 'sub_product.code')
  );

  return {
    productName: safeString(productName),
    matchedKey: safeString(matchedKey),
    sku: safeString(sku),
    candidateKeys,
    candidateNames
  };
}

function convertReview(r, productMap) {
  const rawText = r.message || '';
  const channel = parseChannel(rawText);
  const text = cleanMessage(rawText);
  const score = r.score || 5;
  const sentiment = getSentiment(text, score);
  const isNeg = sentiment === '부정';
  const keywords = extractKeywords(text);

  const resolved = resolveProductInfo(r, productMap);
  const productName = resolved.productName;
  const productCategory = getProductCategory(productName);

  if (!productName) {
    console.log(
      `[상품매핑실패] review_id=${r.id} / keys=${JSON.stringify(resolved.candidateKeys)} / names=${JSON.stringify(resolved.candidateNames)}`
    );
  }

  const memoParts = [`크리마 수집 (id=${r.id})`];
  if (resolved.matchedKey) memoParts.push(`matchedKey=${resolved.matchedKey}`);
  if (resolved.sku) memoParts.push(`sku=${resolved.sku}`);

  return {
    id: `CRM${r.id}`,
    date: r.created_at ? r.created_at.slice(0, 10) : new Date().toISOString().slice(0, 10),
    channel,
    product: productName,
    category: '리뷰',
    text,
    memo: memoParts.join(' | '),
    reviewer: r.user_name || r.writer_name || '익명',
    sentiment,
    sentiment_score: score >= 4 ? 80 : score >= 3 ? 55 : 25,
    keywords,
    has_repurchase: text.includes('재구매') || text.includes('또 살') || text.includes('쟁여'),
    is_negative: isNeg,
    issue_flag: isNeg && score <= 2,
    product_norm: productName || resolved.sku || '',
    product_category: productCategory,
    sku: resolved.sku || ''
  };
}

function updateHTML(newReviews) {
  console.log(`=== HTML 파일 업데이트 (${HTML_PATH}) ===`);
  let html = fs.readFileSync(HTML_PATH, 'utf8');

  const startMarker = 'const ALL_REVIEWS = ';
  const markerPos = html.indexOf(startMarker);
  if (markerPos === -1) {
    throw new Error(`ALL_REVIEWS 블록을 ${HTML_PATH}에서 찾지 못했습니다.`);
  }

  const startIdx = markerPos + startMarker.length;

  let depth = 0;
  let inString = false;
  let i = startIdx;

  while (i < html.length) {
    const c = html[i];
    if (c === '\\' && inString) {
      i += 2;
      continue;
    }
    if (c === '"') {
      inString = !inString;
    } else if (!inString) {
      if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    i++;
  }

  const endIdx = i;
  const existingJson = html.slice(startIdx, endIdx);

  let existing = [];
  try {
    existing = JSON.parse(existingJson);
  } catch (e) {
    console.warn('기존 데이터 파싱 실패 → 새 데이터로 덮음');
  }

  const map = new Map();

  existing.forEach(r => {
    map.set(String(r.id), r);
  });

  newReviews.forEach(r => {
    const id = String(r.id);
    const old = map.get(id);

    if (!old) {
      map.set(id, r);
      return;
    }

    const merged = {
      ...old,
      ...r,
      product:
        r.product && r.product !== '' ? r.product : old.product || '',
      product_norm:
        r.product_norm && r.product_norm !== ''
          ? r.product_norm
          : old.product_norm || '',
      product_category:
        r.product_category && r.product_category !== '기타'
          ? r.product_category
          : old.product_category || '기타',
      sku:
        r.sku || old.sku || '',
      memo:
        r.memo || old.memo || ''
    };

    map.set(id, merged);
  });

  const merged = [...map.values()].sort((a, b) => b.date.localeCompare(a.date));
  const totalCount = merged.length;

  const newJson = JSON.stringify(merged, null, 0);
  html = html.slice(0, startIdx) + newJson + html.slice(endIdx);

  html = html.replace(/(<span class="nav-badge">)\d+(<\/span>)/g, `$1${totalCount}$2`);
  html = html.replace(/(<div class="nav-badge">)\d+(<\/div>)/g, `$1${totalCount}$2`);

  fs.writeFileSync(HTML_PATH, html, 'utf8');
  console.log(`총 ${merged.length}개 리뷰 업데이트 완료`);
}

async function main() {
  try {
    console.log('========================================');
    console.log('  크리마 전체 리뷰 수집 시작');
    console.log('========================================\n');
    console.log(`대상 HTML 파일: ${HTML_PATH}`);

    if (!APP_ID || !SECRET) {
      throw new Error('CREMA_APP_ID 또는 CREMA_SECRET 환경변수가 설정되지 않았습니다');
    }

    const token = await getAccessToken();
    const productMap = await fetchProductMap(token);
    const raw = await fetchAllReviews(token);

    if (raw.length === 0) {
      console.log('[경고] 수집된 리뷰가 0개입니다. API 응답을 확인하세요.');
      return;
    }

    const converted = raw.map(r => convertReview(r, productMap));

    const chCount = {};
    converted.forEach(r => {
      chCount[r.channel] = (chCount[r.channel] || 0) + 1;
    });
    console.log('채널 분포:', JSON.stringify(chCount));

    const catCount = {};
    converted.forEach(r => {
      catCount[r.product_category] = (catCount[r.product_category] || 0) + 1;
    });
    console.log('제품 분포:', JSON.stringify(catCount));

    const noProductCount = converted.filter(r => !r.product).length;
    console.log(`상품명 비어있는 리뷰 수: ${noProductCount}개`);

    updateHTML(converted);

    const negatives = converted.filter(r => r.is_negative);
    if (negatives.length > 0) {
      console.log(`\n=== 부정리뷰 ${negatives.length}건 → 슬랙 알림 전송 ===`);
      await notifyNegativeReviews(negatives);
    }

    console.log('\n========================================');
    console.log('  완료!');
    console.log('========================================');
  } catch (e) {
    console.error('[오류]', e.message);
    console.error(e.stack);
    process.exit(1);
  }
}

main();
