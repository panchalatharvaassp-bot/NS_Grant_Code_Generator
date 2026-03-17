import express from 'express';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import axios from 'axios';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json());

// Store active puppeteer sessions in memory
const sessions = {};

// Step 1: Start login flow
app.post('/get-tokens', async (req, res) => {
  const CONFIG = req.body;
  const sessionId = randomUUID();

  try {
    const browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

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
      console.log('🔐 2FA page reached, waiting for OTP...');

      sessions[sessionId] = {
        browser,
        page,
        getGrantCode: () => grantCode,
        CONFIG,
        createdAt: Date.now(),
      };

      return res.json({ status: 'otp_required', sessionId });
    }

    // No 2FA needed
    await new Promise(resolve => setTimeout(resolve, 3000));
    await browser.close();

    const tokens = await getTokens(grantCode, CONFIG);
    return res.json({ status: 'success', ...tokens });

  } catch (e) {
    console.error('❌ Error in /get-tokens:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// Step 2: Submit OTP
app.post('/submit-otp', async (req, res) => {
  const { sessionId, otpCode } = req.body;
  const session = sessions[sessionId];

  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  const { browser, page, getGrantCode, CONFIG } = session;

  try {
    await new Promise(resolve => setTimeout(resolve, 2000));

    await page.waitForSelector('input[placeholder="6-digit code"]', { timeout: 10000 });
    await page.click('input[placeholder="6-digit code"]');
    await page.type('input[placeholder="6-digit code"]', otpCode);
    await page.click('#uif72');
    await page.click('.n-loginchallenge-button');
    await page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => {});
    console.log('URL after 2FA:', page.url());

    await new Promise(resolve => setTimeout(resolve, 3000));
    await browser.close();

    delete sessions[sessionId];

    const tokens = await getTokens(getGrantCode(), CONFIG);
    return res.json({ status: 'success', ...tokens });

  } catch (e) {
    console.error('❌ Error in /submit-otp:', e.message);
    delete sessions[sessionId];
    return res.status(500).json({ error: e.message });
  }
});

async function getTokens(grantCode, CONFIG) {
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

// Clean up stale sessions older than 5 minutes
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
