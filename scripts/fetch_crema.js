// 크리마 리뷰 데이터 구조 확인용 디버그 스크립트

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
  return res.body.access_token;
}

async function main() {
  const token = await getAccessToken();
  console.log('✅ 토큰 발급 완료\n');

  // 리뷰 1개만 가져와서 전체 구조 출력
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 45);
  
  const startStr = start.toISOString().slice(0,10);
  const endStr = end.toISOString().slice(0,10);

  const res = await request({
    hostname: 'api.cre.ma',
    path: `/v1/reviews?access_token=${token}&limit=3&page=1&date_order_desc=1&start_date=${startStr}&end_date=${endStr}`,
    method: 'GET',
    headers: { 'Accept': 'application/json' }
  });

  console.log('📋 리뷰 데이터 구조 (3개 샘플):');
  console.log(JSON.stringify(res.body, null, 2));
  
  console.log('\n📋 응답 헤더:');
  console.log(JSON.stringify(res.headers, null, 2));
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
