import express from 'express';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import axios from 'axios';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json());

const sessions = {};
const jobs = {}; // Store job status

app.get('/ping', (req, res) => {
  res.json({ status: 'awake' });
});

// Step 1: Start login flow — returns jobId IMMEDIATELY
app.post('/get-tokens', async (req, res) => {
  console.log('📥 /get-tokens request received');
  const CONFIG = req.body;
  const jobId = randomUUID();

  // Return jobId immediately before doing anything
  res.json({ status: 'processing', jobId });
  console.log('✅ Returned jobId immediately:', jobId);

  // Run the actual work in background
  jobs[jobId] = { status: 'processing', createdAt: Date.now() };

  try {
    console.log('🚀 Launching browser...');
    const browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    console.log('✅ Browser launched');

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
    console.log('🌐 Navigating to auth URL...');
    await page.goto(authUrl);

    await page.waitForSelector('#email');
    console.log('⌨️ Entering credentials...');
    await page.type('#email', CONFIG.nsEmail);
    await page.type('#password', CONFIG.nsPassword);
    await page.click('#login-submit');
    await page.waitForNavigation({ waitUntil: 'networkidle0' }).catch((e) => {
      console.log('⚠️ Navigation warning:', e.message);
    });
    console.log('✅ Navigation complete, URL:', page.url());

    if (page.url().includes('loginchallenge')) {
      console.log('🔐 2FA detected, waiting for OTP...');
      const sessionId = randomUUID();

      sessions[sessionId] = {
        browser,
        page,
        getGrantCode: () => grantCode,
        CONFIG,
        createdAt: Date.now(),
      };

      // Update job status to otp_required
      jobs[jobId] = {
        status: 'otp_required',
        sessionId,
        createdAt: Date.now(),
      };

      console.log('✅ Job updated to otp_required, sessionId:', sessionId);
      return;
    }

    // No 2FA
    await new Promise(resolve => setTimeout(resolve, 3000));
    await browser.close();

    const tokens = await getTokens(grantCode, CONFIG);
    jobs[jobId] = { status: 'success', tokens, createdAt: Date.now() };
    console.log('✅ Tokens received, job complete');

  } catch (e) {
    console.error('❌ Error in /get-tokens background:', e.message);
    jobs[jobId] = { status: 'error', error: e.message };
  }
});

// Step 2: NetSuite polls this to check job status
app.get('/job-status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  console.log('📊 Job status check:', jobId, '→', job.status);
  return res.json(job);
});

// Step 3: Submit OTP
app.post('/submit-otp', async (req, res) => {
  console.log('📥 /submit-otp request received');
  const { sessionId, otpCode } = req.body;
  const session = sessions[sessionId];

  if (!session) {
    console.error('❌ Session not found:', sessionId);
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  // Return immediately, process in background
  const jobId = randomUUID();
  jobs[jobId] = { status: 'processing', createdAt: Date.now() };
  res.json({ status: 'processing', jobId });
  console.log('✅ Returned jobId immediately:', jobId);

  const { browser, page, getGrantCode, CONFIG } = session;

  try {
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log('⏳ Waiting for OTP input...');
    await page.waitForSelector('input[placeholder="6-digit code"]', { timeout: 10000 });
    await page.click('input[placeholder="6-digit code"]');
    await page.type('input[placeholder="6-digit code"]', otpCode);
    console.log('✅ OTP entered');

    await page.click('#uif72');
    console.log('✅ Checkbox clicked');

    await page.click('.n-loginchallenge-button');
    console.log('✅ Submit clicked');

    await page.waitForNavigation({ waitUntil: 'networkidle0' }).catch((e) => {
      console.log('⚠️ Navigation warning:', e.message);
    });
    console.log('✅ URL after 2FA:', page.url());

    await new Promise(resolve => setTimeout(resolve, 3000));
    await browser.close();
    console.log('✅ Browser closed');

    delete sessions[sessionId];

    const tokens = await getTokens(getGrantCode(), CONFIG);
    jobs[jobId] = { status: 'success', tokens, createdAt: Date.now() };
    console.log('✅ Tokens received, job complete');

  } catch (e) {
    console.error('❌ Error in /submit-otp:', e.message);
    delete sessions[sessionId];
    jobs[jobId] = { status: 'error', error: e.message };
  }
});

async function getTokens(grantCode, CONFIG) {
  console.log('🔄 Calling token endpoint, grant code:', grantCode);
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
  console.log('✅ Token endpoint status:', response.status);
  return response.data;
}

// Clean up old jobs and sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of Object.entries(jobs)) {
    if (now - job.createdAt > 10 * 60 * 1000) {
      delete jobs[id];
      console.log('🧹 Cleaned up stale job:', id);
    }
  }
  for (const [id, session] of Object.entries(sessions)) {
    if (now - session.createdAt > 5 * 60 * 1000) {
      session.browser.close();
      delete sessions[id];
      console.log('🧹 Cleaned up stale session:', id);
    }
  }
}, 60 * 1000);

app.listen(3000, () => console.log('🚀 Server running on port 3000'));
```

**The new flow:**
```
Suitelet → POST /get-tokens → gets jobId instantly
Suitelet → polls GET /job-status/:jobId every 3 seconds
              ↓ status: 'otp_required' → show OTP input to user
Suitelet → POST /submit-otp → gets jobId instantly  
Suitelet → polls GET /job-status/:jobId every 3 seconds
              ↓ status: 'success' → show tokens
