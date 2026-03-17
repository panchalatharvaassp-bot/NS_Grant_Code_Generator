import express from 'express';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import axios from 'axios';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json());

const sessions = {};

app.post('/get-tokens', async (req, res) => {
  console.log('📥 /get-tokens request received');
  console.log('📦 Request body:', JSON.stringify(req.body));

  const CONFIG = req.body;
  const sessionId = randomUUID();
  console.log('🆔 Session ID created:', sessionId);

  try {
    console.log('🚀 Launching browser...');
    const browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    console.log('✅ Browser launched successfully');

    const page = await browser.newPage();
    console.log('✅ New page created');
    let grantCode = null;

    await page.setRequestInterception(true);
    console.log('✅ Request interception enabled');

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
    console.log('🌐 Navigating to auth URL:', authUrl);
    await page.goto(authUrl);
    console.log('✅ Auth URL loaded, current URL:', page.url());

    console.log('⏳ Waiting for #email selector...');
    await page.waitForSelector('#email');
    console.log('✅ Email field found');

    console.log('⌨️ Typing credentials...');
    await page.type('#email', CONFIG.nsEmail);
    console.log('✅ Email entered');
    await page.type('#password', CONFIG.nsPassword);
    console.log('✅ Password entered');

    console.log('🖱️ Clicking login button...');
    await page.click('#login-submit');
    console.log('✅ Login button clicked');

    console.log('⏳ Waiting for navigation after login...');
    await page.waitForNavigation({ waitUntil: 'networkidle0' }).catch((e) => {
      console.log('⚠️ Navigation warning:', e.message);
    });
    console.log('✅ Navigation complete, current URL:', page.url());

    if (page.url().includes('loginchallenge')) {
      console.log('🔐 2FA page detected!');
      console.log('💾 Saving session to memory...');

      sessions[sessionId] = {
        browser,
        page,
        getGrantCode: () => grantCode,
        CONFIG,
        createdAt: Date.now(),
      };

      console.log('✅ Session saved, returning otp_required to client');
      return res.json({ status: 'otp_required', sessionId });
    }

    console.log('✅ No 2FA needed, waiting for redirect...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    await browser.close();
    console.log('✅ Browser closed');

    console.log('🔄 Exchanging grant code for tokens...');
    const tokens = await getTokens(grantCode, CONFIG);
    console.log('✅ Tokens received successfully');
    return res.json({ status: 'success', ...tokens });

  } catch (e) {
    console.error('❌ Error in /get-tokens:', e.message);
    console.error('❌ Stack:', e.stack);
    return res.status(500).json({ error: e.message });
  }
});

app.post('/submit-otp', async (req, res) => {
  console.log('📥 /submit-otp request received');
  console.log('📦 Request body:', JSON.stringify(req.body));

  const { sessionId, otpCode } = req.body;
  console.log('🆔 Looking up session:', sessionId);

  const session = sessions[sessionId];

  if (!session) {
    console.error('❌ Session not found:', sessionId);
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  console.log('✅ Session found');
  const { browser, page, getGrantCode, CONFIG } = session;

  try {
    console.log('⏳ Waiting 2 seconds before entering OTP...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log('⏳ Waiting for OTP input field...');
    await page.waitForSelector('input[placeholder="6-digit code"]', { timeout: 10000 });
    console.log('✅ OTP input field found');

    console.log('⌨️ Entering OTP code:', otpCode);
    await page.click('input[placeholder="6-digit code"]');
    await page.type('input[placeholder="6-digit code"]', otpCode);
    console.log('✅ OTP entered');

    console.log('🖱️ Clicking trust device checkbox...');
    await page.click('#uif72');
    console.log('✅ Checkbox clicked');

    console.log('🖱️ Clicking submit button...');
    await page.click('.n-loginchallenge-button');
    console.log('✅ Submit button clicked');

    console.log('⏳ Waiting for navigation after OTP...');
    await page.waitForNavigation({ waitUntil: 'networkidle0' }).catch((e) => {
      console.log('⚠️ Navigation warning:', e.message);
    });
    console.log('✅ Navigation complete, URL after 2FA:', page.url());

    console.log('⏳ Waiting 3 seconds for redirect...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    await browser.close();
    console.log('✅ Browser closed');

    delete sessions[sessionId];
    console.log('🧹 Session cleaned up');

    console.log('🔄 Exchanging grant code for tokens...');
    console.log('🔑 Grant code:', getGrantCode());
    const tokens = await getTokens(getGrantCode(), CONFIG);
    console.log('✅ Tokens received successfully');
    return res.json({ status: 'success', ...tokens });

  } catch (e) {
    console.error('❌ Error in /submit-otp:', e.message);
    console.error('❌ Stack:', e.stack);
    delete sessions[sessionId];
    return res.status(500).json({ error: e.message });
  }
});

async function getTokens(grantCode, CONFIG) {
  console.log('🔄 Calling NetSuite token endpoint...');
  console.log('🔑 Using grant code:', grantCode);
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
  console.log('✅ Token endpoint responded with status:', response.status);
  return response.data;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of Object.entries(sessions)) {
    if (now - session.createdAt > 5 * 60 * 1000) {
      session.browser.close();
      delete sessions[id];
      console.log(`🧹 Cleaned up stale session: ${id}`);
    }
  }
}, 60 * 1000);

app.listen(3000, () => console.log('🚀 Server running on port 3000'));
