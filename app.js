import express from 'express';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import axios from 'axios';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json());

const sessions = {};
const jobs = {};

app.get('/ping', (req, res) => {
  res.json({ status: 'awake' });
});

app.post('/get-tokens', async (req, res) => {
  console.log('[get-tokens] Request received');
  console.log('[get-tokens] Request body:', JSON.stringify(req.body));

  const CONFIG = req.body;
  const jobId = randomUUID();

  res.json({ status: 'processing', jobId });
  console.log('[get-tokens] Returned jobId immediately:', jobId);

  jobs[jobId] = { status: 'processing', createdAt: Date.now() };

  try {
    console.log('[browser] Launching browser...');
    const browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    console.log('[browser] Browser launched successfully');

    const page = await browser.newPage();
    console.log('[browser] New page created');
    let grantCode = null;

    await page.setRequestInterception(true);
    console.log('[browser] Request interception enabled');

    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith(CONFIG.redirectUri)) {
        grantCode = new URL(url).searchParams.get('code');
        console.log('[grant] Grant code captured:', grantCode);
        req.abort();
      } else {
        req.continue();
      }
    });

    const authUrl = `${CONFIG.authUrl}?response_type=code&redirect_uri=${encodeURIComponent(CONFIG.redirectUri)}&scope=${encodeURIComponent(CONFIG.scope)}&state=${CONFIG.state}&client_id=${CONFIG.clientId}`;
    console.log('[browser] Navigating to auth URL:', authUrl);
    await page.goto(authUrl);
    console.log('[browser] Auth URL loaded, current URL:', page.url());

    console.log('[login] Waiting for email field...');
    await page.waitForSelector('#email');
    console.log('[login] Email field found');

    console.log('[login] Entering credentials...');
    await page.type('#email', CONFIG.nsEmail);
    console.log('[login] Email entered');
    await page.type('#password', CONFIG.nsPassword);
    console.log('[login] Password entered');

    console.log('[login] Clicking login button...');
    await page.click('#login-submit');
    console.log('[login] Login button clicked');

    console.log('[login] Waiting for navigation...');
    await page.waitForNavigation({ waitUntil: 'networkidle0' }).catch((e) => {
      console.log('[login] Navigation warning:', e.message);
    });
    console.log('[login] Navigation complete, URL:', page.url());

    if (page.url().includes('loginchallenge')) {
      console.log('[2FA] Challenge page detected');
      const sessionId = randomUUID();

      sessions[sessionId] = {
        browser,
        page,
        getGrantCode: () => grantCode,
        CONFIG,
        createdAt: Date.now(),
      };

      jobs[jobId] = {
        status: 'otp_required',
        sessionId,
        createdAt: Date.now(),
      };

      console.log('[2FA] Job updated to otp_required, sessionId:', sessionId);
      return;
    }

    console.log('[login] No 2FA needed, waiting for redirect...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    await browser.close();
    console.log('[browser] Browser closed');

    console.log('[token] Exchanging grant code for tokens...');
    const tokens = await getTokens(grantCode, CONFIG);
    jobs[jobId] = { status: 'success', tokens, createdAt: Date.now() };
    console.log('[token] Tokens received, job complete');

  } catch (e) {
    console.error('[get-tokens] Error:', e.message);
    console.error('[get-tokens] Stack:', e.stack);
    jobs[jobId] = { status: 'error', error: e.message };
  }
});

app.get('/job-status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  console.log('[job-status] Job:', jobId, '-> Status:', job.status);
  return res.json(job);
});

app.post('/submit-otp', async (req, res) => {
  console.log('[submit-otp] Request received');
  console.log('[submit-otp] Request body:', JSON.stringify(req.body));

  const { sessionId, otpCode } = req.body;
  console.log('[submit-otp] Looking up session:', sessionId);

  const session = sessions[sessionId];

  if (!session) {
    console.error('[submit-otp] Session not found:', sessionId);
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  console.log('[submit-otp] Session found');

  const jobId = randomUUID();
  jobs[jobId] = { status: 'processing', createdAt: Date.now() };
  res.json({ status: 'processing', jobId });
  console.log('[submit-otp] Returned jobId immediately:', jobId);

  const { browser, page, getGrantCode, CONFIG } = session;

  try {
    console.log('[submit-otp] Waiting 2 seconds before entering OTP...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log('[submit-otp] Waiting for OTP input field...');
    await page.waitForSelector('input[placeholder="6-digit code"]', { timeout: 10000 });
    console.log('[submit-otp] OTP input field found');

    console.log('[submit-otp] Entering OTP code:', otpCode);
    await page.click('input[placeholder="6-digit code"]');
    await page.type('input[placeholder="6-digit code"]', otpCode);
    console.log('[submit-otp] OTP entered');

    console.log('[submit-otp] Clicking trust device checkbox...');
    await page.click('#uif72');
    console.log('[submit-otp] Checkbox clicked');

    console.log('[submit-otp] Clicking submit button...');
    await page.click('.n-loginchallenge-button');
    console.log('[submit-otp] Submit button clicked');

    console.log('[submit-otp] Waiting for navigation...');
    await page.waitForNavigation({ waitUntil: 'networkidle0' }).catch((e) => {
      console.log('[submit-otp] Navigation warning:', e.message);
    });
    console.log('[submit-otp] URL after 2FA:', page.url());

    console.log('[submit-otp] Waiting 3 seconds...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    await browser.close();
    console.log('[browser] Browser closed');

    delete sessions[sessionId];
    console.log('[submit-otp] Session cleaned up');

    console.log('[token] Exchanging grant code for tokens...');
    console.log('[token] Grant code:', getGrantCode());
    const tokens = await getTokens(getGrantCode(), CONFIG);
    jobs[jobId] = { status: 'success', tokens, createdAt: Date.now() };
    console.log('[token] Tokens received, job complete');

  } catch (e) {
    console.error('[submit-otp] Error:', e.message);
    console.error('[submit-otp] Stack:', e.stack);
    delete sessions[sessionId];
    jobs[jobId] = { status: 'error', error: e.message };
  }
});

async function getTokens(grantCode, CONFIG) {
  console.log('[token] Calling NetSuite token endpoint...');
  console.log('[token] Grant code:', grantCode);
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
  console.log('[token] Token endpoint responded with status:', response.status);
  return response.data;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of Object.entries(jobs)) {
    if (now - job.createdAt > 10 * 60 * 1000) {
      delete jobs[id];
      console.log('[cleanup] Stale job removed:', id);
    }
  }
  for (const [id, session] of Object.entries(sessions)) {
    if (now - session.createdAt > 5 * 60 * 1000) {
      session.browser.close();
      delete sessions[id];
      console.log('[cleanup] Stale session removed:', id);
    }
  }
}, 60 * 1000);

app.listen(3000, () => console.log('[server] Running on port 3000'));
