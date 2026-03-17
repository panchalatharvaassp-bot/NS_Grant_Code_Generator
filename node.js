
import puppeteer from 'puppeteer';
import axios from 'axios';
import readline from 'readline';

const CONFIG = {
  authUrl: 'https://tstdrv2149584.app.netsuite.com/app/login/oauth2/authorize.nl',
  tokenUrl: 'https://tstdrv2149584.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token',
  clientId: '669b613664677bed6111dc2ffc78f4d986a0c25b353389019c6a7f756e0c21e4',
  clientSecret: 'f1453a6f8e5095bb1f3deeeeae6c8823766784a27c8934c5c7e05451e7c1163b',
  redirectUri: 'https://softype.com',
  scope: 'restlets rest_webservices',
  state: 'ykv2XLx1BpT5Q0F3MRPHb94j',
  nsEmail: 'atharvap@softype.com',
  nsPassword: 'Ventus@12345',
};

// Prompts you to type OTP in terminal at the right moment
function askForOTP() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question('🔐 Enter your 2FA code now: ', (code) => {
      rl.close();
      resolve(code.trim());
    });
  });
}

async function getGrantCode() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  let grantCode = null;

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith(CONFIG.redirectUri)) {
      grantCode = new URL(url).searchParams.get('code');
      console.log('✅ Grant code captured:', grantCode);
      req.abort();
    } else {
      req.continue();
    }
  });

  const authUrl = `${CONFIG.authUrl}?response_type=code&redirect_uri=${encodeURIComponent(CONFIG.redirectUri)}&scope=${encodeURIComponent(CONFIG.scope)}&state=${CONFIG.state}&client_id=${CONFIG.clientId}`;
  console.log('Navigating to auth URL...');
  await page.goto(authUrl);

  await page.waitForSelector('#email');
  console.log('Entering credentials...');
  await page.type('#email', CONFIG.nsEmail);
  await page.type('#password', CONFIG.nsPassword);
  await page.click('#login-submit');
  await page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => {});

 if (page.url().includes('loginchallenge')) {
    console.log('🔐 2FA page reached!');

    const totpCode = await askForOTP();

await page.screenshot({ path: 'otp-page.png', fullPage: true }); // add this

    // Wait for page to fully load first
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Try broader selector in case ID changes
    await page.waitForSelector('input[placeholder="6-digit code"]', { timeout: 10000 });
    await page.click('input[placeholder="6-digit code"]');
    await page.type('input[placeholder="6-digit code"]', totpCode);

    // Click checkbox
    await page.click('#uif72');

    // Click submit
    await page.click('.n-loginchallenge-button');

    await page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => {});
    console.log('URL after 2FA:', page.url());
}
  await new Promise(resolve => setTimeout(resolve, 3000));
  await browser.close();
  return grantCode;
}

async function getTokens(grantCode) {
  const response = await axios.post(
    CONFIG.tokenUrl,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: grantCode,
      redirect_uri: CONFIG.redirectUri,
      client_id: CONFIG.clientId,
      client_secret: CONFIG.clientSecret,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return response.data;
}

async function main() {
  try {
    console.log('Getting grant code...');
    const grantCode = await getGrantCode();
    console.log('Grant code:', grantCode);

    // console.log('Exchanging for tokens...');
    // const tokens = await getTokens(grantCode);
    // console.log('✅ Access Token:', tokens.access_token);
    // console.log('✅ Refresh Token:', tokens.refresh_token);

  } catch (e) {
    console.error('❌ Error:', e.response?.data || e.message);
  }
}

main();