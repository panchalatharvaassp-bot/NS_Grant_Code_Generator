import express from 'express';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json());

const sessions = {};
const jobs = {};

app.get('/ping', (req, res) => {
  res.json({ status: 'awake' });
});

app.post('/get-grant-code', async (req, res) => {
  console.log('[get-grant-code] Request received');
  const CONFIG = req.body;
  const jobId = randomUUID();

  // Return jobId immediately
  res.json({ status: 'processing', jobId });
  jobs[jobId] = { status: 'processing', createdAt: Date.now() };

  try {
    console.log('[browser] Launching browser...');
    const browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    console.log('[browser] Launched');

    const page = await browser.newPage();
    let grantCode = null;

    await page.setRequestInterception(true);
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
    console.log('[browser] Navigating to auth URL...');
    await page.goto(authUrl);

    await page.waitForSelector('#email');
    console.log('[login] Entering credentials...');
    await page.type('#email', CONFIG.nsEmail);
    await page.type('#password', CONFIG.nsPassword);
    await page.click('#login-submit');
    await page.waitForNavigation({ waitUntil: 'networkidle0' }).catch((e) => {
      console.log('[login] Navigation warning:', e.message);
    });
    console.log('[login] URL after login:', page.url());

    if (page.url().includes('loginchallenge')) {
      console.log('[2FA] Challenge detected, waiting for OTP...');
      const sessionId = randomUUID();

      sessions[sessionId] = {
        browser,
        page,
        getGrantCode: () => grantCode,
        createdAt: Date.now(),
      };

      jobs[jobId] = { status: 'otp_required', sessionId, createdAt: Date.now() };
      console.log('[2FA] Session saved:', sessionId);
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 3000));
    await browser.close();
    jobs[jobId] = { status: 'success', grantCode, createdAt: Date.now() };
    console.log('[grant] Job complete:', grantCode);

  } catch (e) {
    console.error('[get-grant-code] Error:', e.message);
    jobs[jobId] = { status: 'error', error: e.message };
  }
});

app.get('/job-status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  console.log('[job-status]', jobId, '->', job.status);
  return res.json(job);
});

app.post('/submit-otp', async (req, res) => {
  console.log('[submit-otp] Request received');
  const { sessionId, otpCode } = req.body;
  const session = sessions[sessionId];

  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  const jobId = randomUUID();
  jobs[jobId] = { status: 'processing', createdAt: Date.now() };
  res.json({ status: 'processing', jobId });

  const { browser, page, getGrantCode } = session;

  try {
    await new Promise(resolve => setTimeout(resolve, 2000));

    await page.waitForSelector('input[placeholder="6-digit code"]', { timeout: 10000 });
    await page.click('input[placeholder="6-digit code"]');
    await page.type('input[placeholder="6-digit code"]', otpCode);
    console.log('[2FA] OTP entered');

    await page.click('#uif72');
    await page.click('.n-loginchallenge-button');
    await page.waitForNavigation({ waitUntil: 'networkidle0' }).catch((e) => {
      console.log('[submit-otp] Navigation warning:', e.message);
    });
    console.log('[submit-otp] URL after 2FA:', page.url());

    await new Promise(resolve => setTimeout(resolve, 3000));
    await browser.close();
    delete sessions[sessionId];

    const grantCode = getGrantCode();
    console.log('[grant] Grant code:', grantCode);
    jobs[jobId] = { status: 'success', grantCode, createdAt: Date.now() };

  } catch (e) {
    console.error('[submit-otp] Error:', e.message);
    delete sessions[sessionId];
    jobs[jobId] = { status: 'error', error: e.message };
  }
});

// Cleanup stale jobs and sessions
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
